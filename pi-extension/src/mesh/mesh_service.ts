/**
 * MeshService — the local UDS agent mesh.
 *
 * Owns the MeshNode (SessionPeer + broker leadership + optional cross-PC
 * bridge), the per-(cwd,name) lock, the peer-count cache, and the inbound
 * mesh-message drain that batches deliveries into the agent between turns.
 *
 * Naming (plan/59): the mesh name IS the pi session name —
 * `sanitize(pi.getSessionName()) ?? basename(cwd)`. There is no separate
 * name config anywhere. When the user renames the pi session, the shell
 * calls `rename()` and the broker re-registers. A `#N` collision suffix is
 * a RUNTIME resolution and is never written back to the session name.
 *
 * All state lives on the instance created by the extension factory.
 */

import { mkdirSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ServerMessage } from "../relay/protocol.js";
import { MeshNode } from "./node.js";
import type { Envelope } from "./envelope.js";
import { acquireCwdLock, type AcquiredLock } from "./cwd_lock.js";
import {
  ensureGlobalDirs,
  LOCAL_SESSION_NAME,
  sessionAuditPath,
  sessionSockPath,
  skillsDir,
} from "./paths.js";
import { defaultAgentName, sanitizeSegment } from "./names.js";

export interface MeshServiceDeps {
  getPi: () => ExtensionAPI | null;
  /** pi.getSessionName() — the mesh name source of truth. */
  getSessionName: () => string | undefined;
  /** Mirror inbound mesh messages to the phone app's TOOL timeline. */
  broadcastToApp: (msg: ServerMessage) => void;
  notify: (message: string, level?: "info" | "warning" | "error") => void;
  refreshFooter: () => void;
  isDisposed: () => boolean;
  /** Fired once the local broker exists so the relay can attach the
   *  cross-PC bridge. No-op when the relay is down. */
  onMeshReady: () => void;
}

type MeshEnvelope = { id: string; from: string; re: string | null; body: unknown };

export class MeshService {
  private readonly deps: MeshServiceDeps;

  private node: MeshNode | null = null;
  private peerCount = 0;
  private cwdLock: AcquiredLock | null = null;
  private lockedName: string | null = null;
  private joinGeneration = 0;

  // Inbound mesh-message drain (batched between agent turns)
  private pendingMeshMessages: MeshEnvelope[] = [];
  private agentRunActive = false;
  private agentRunGeneration = 0;
  private meshDrainScheduled = false;

  constructor(deps: MeshServiceDeps) {
    this.deps = deps;
  }

  // ── Getters ───────────────────────────────────────────────────────────────

  get currentNode(): MeshNode | null { return this.node; }
  get currentPeerCount(): number { return this.peerCount; }
  get isJoined(): boolean { return this.node !== null; }

  /** Requested mesh name for a fresh join: sanitized pi session name, else
   *  the cwd leaf. */
  private requestedName(cwd: string): string {
    return sanitizeSegment(this.deps.getSessionName()) ?? defaultAgentName(cwd);
  }

  // ── Join / leave ──────────────────────────────────────────────────────────

  /**
   * Join the fixed local UDS mesh ("local" session). Acquires the
   * per-(cwd,name) lock first (auto-suffixing `name#2`, `name#3`, … when
   * same-named agents share the folder), then connects the MeshNode.
   */
  async join(ctx: Pick<ExtensionContext, "ui" | "cwd">): Promise<void> {
    const cwd = "cwd" in ctx ? (ctx as ExtensionCommandContext).cwd : process.cwd();

    if (this.node) {
      ctx.ui.notify("[remote-pi] Already on the local mesh.", "warning");
      return;
    }
    const joinGeneration = ++this.joinGeneration;
    const isCurrentCandidate = (): boolean =>
      !this.deps.isDisposed() &&
      joinGeneration === this.joinGeneration &&
      this.node === null;

    // Per-(cwd,name) lock. Several agents may run in the SAME folder; the
    // requested name is made unique with a `#N` suffix when needed.
    if (this.cwdLock === null) {
      const baseName = this.requestedName(cwd);
      const maxAttempts = 1000;
      for (let n = 1; n <= maxAttempts; n++) {
        const candidate = n === 1 ? baseName : `${baseName}#${n}`;
        const result = await acquireCwdLock(cwd, candidate);
        if (!isCurrentCandidate()) {
          if (result.ok) {
            try { result.release(); } catch { /* best-effort stale lock cleanup */ }
          }
          return;
        }
        if (result.ok) { this.cwdLock = result; this.lockedName = candidate; break; }
      }
      if (this.cwdLock === null) {
        ctx.ui.notify(
          `[remote-pi] Could not join: too many agents named "${baseName}" already running in this folder.`,
          "warning",
        );
        return;
      }
    }

    const agentName = this.lockedName ?? this.requestedName(cwd);
    const sessionName = LOCAL_SESSION_NAME;

    ensureGlobalDirs();
    mkdirSync(join(skillsDir(), "..", "sessions", sessionName), { recursive: true });

    const sock = sessionSockPath(sessionName);
    const audit = sessionAuditPath(sessionName);
    // Forward the cwd so the broker keys this peer by (cwd, name).
    // Canonicalize via realpath so symlinked cwds map to one identity.
    let canonCwd = cwd;
    try { canonCwd = realpathSync(cwd); } catch { /* cwd missing — use raw path */ }
    const peer = new MeshNode({
      sockPath: sock,
      name: agentName,
      cwd: canonCwd,
      auditPath: audit,
    });

    peer.onMessage((env) => this.onMeshMessage(peer, env));
    // After failover the new broker's peers map starts fresh — re-seed the
    // cached count so surviving peers don't carry the pre-failover count.
    peer.onReconnect(() => this.refreshPeerCount(peer));

    try {
      const assigned = await peer.connect();
      if (!isCurrentCandidate()) {
        try { await peer.close(); } catch { /* best-effort */ }
        return;
      }
      this.node = peer;
      this.peerCount = 1;  // optimistic — overwritten by list_peers below
      // The broker broadcasts `peer_joined` only to existing peers; ask for
      // the live list to seed the count correctly on join.
      this.refreshPeerCount(peer);
      if (assigned !== agentName) {
        ctx.ui.notify(
          `[remote-pi] Mesh name "${agentName}" taken — joined as "${assigned}" (${peer.currentRole()})`,
          "info",
        );
      } else {
        ctx.ui.notify(
          `[remote-pi] Joined local mesh as "${assigned}" (${peer.currentRole()})`,
          "info",
        );
      }
      this.deps.refreshFooter();
      // Bring up cross-PC routing now that the local broker exists. No-op if
      // the relay isn't up yet (fires again from relay start).
      this.deps.onMeshReady();
    } catch (err) {
      if (!isCurrentCandidate()) {
        try { await peer.close(); } catch { /* best-effort */ }
        return;
      }
      ctx.ui.notify(`[remote-pi] join failed: ${String(err)}`, "error");
    }
  }

  /** Leave the mesh + release the cwd lock. Idempotent. */
  async leave(): Promise<void> {
    this.joinGeneration += 1;
    const node = this.node;
    this.node = null;
    this.peerCount = 0;
    let meshClose: Promise<void> | null = null;
    try { meshClose = node?.close() ?? null; } catch { /* best-effort */ }
    if (this.cwdLock) {
      try { this.cwdLock.release(); } catch { /* best-effort */ }
      this.cwdLock = null;
      this.lockedName = null;
    }
    try { await meshClose; } catch { /* best-effort */ }
  }

  /** session_shutdown teardown. */
  async dispose(): Promise<void> {
    await this.leave();
  }

  /**
   * Follow a pi session rename live: broker soft leave+rejoin → new address
   * `<cwd>@<newName>`. Returns the assigned name (broker may add `#N`), or
   * null when not on the mesh / rename failed.
   */
  async rename(newName: string, cwd: string): Promise<string | null> {
    if (!this.node) return null;
    const clean = sanitizeSegment(newName) ?? defaultAgentName(cwd);
    try {
      const assigned = await this.node.rename(clean);
      this.deps.refreshFooter();
      return assigned;
    } catch (err) {
      this.deps.notify(`[remote-pi] rename failed: ${String(err)}`, "error");
      return null;
    }
  }

  // ── Inbound message handling ──────────────────────────────────────────────

  private onMeshMessage(peer: MeshNode, env: Envelope): void {
    const body = env.body as { type?: string } | null;
    // Broker system events: re-query the broker for the authoritative count
    // (incremental ±1 drifts when peer_left is missed).
    if (body && (body.type === "peer_joined" || body.type === "peer_left")) {
      this.refreshPeerCount(peer);
      // Push the fresh peer list to siblings so their remotePeers cache stays
      // current without polling. list_peers returns the aggregated roster;
      // the bridge wants LOCAL-only addresses (a local peer has no `pc`).
      void peer.request("broker", { type: "list_peers" }, 2000)
        .then((reply) => {
          const replyBody = reply.body as {
            peers?: string[];
            peers_detailed?: Array<{ pc?: string; address?: string }>;
          } | null;
          let local: string[] | null = null;
          const detailed = replyBody?.peers_detailed;
          if (Array.isArray(detailed)) {
            local = detailed
              .filter((p) => !p.pc && typeof p.address === "string")
              .map((p) => p.address as string);
          } else if (Array.isArray(replyBody?.peers)) {
            local = replyBody!.peers!.filter((p) => !p.includes(":"));
          }
          if (local) peer.onLocalPeersChanged(local);
        })
        .catch(() => { /* bridge not bound yet, or list_peers failed */ });
      return;
    }
    if (env.from === "broker") return;  // other broker control messages

    this.deliverMeshMessageToAgent({
      id: env.id,
      from: env.from,
      re: env.re ?? null,
      body: env.body,
    });
  }

  /** Re-queries the broker for the authoritative peer count. Fire-and-forget. */
  private refreshPeerCount(peer: MeshNode): void {
    void peer.request("broker", { type: "list_peers" }, 2000)
      .then((reply) => {
        const peers = (reply.body as { peers?: string[] } | null)?.peers;
        if (Array.isArray(peers)) {
          this.peerCount = peers.length;
          this.deps.refreshFooter();
        }
      })
      .catch(() => { /* older broker without list_peers — keep prior count */ });
  }

  /**
   * Deliver an inbound mesh message to the agent + the app.
   *
   * App: rendered in the TOOL timeline (a matched tool_request/tool_result
   * "agent-network" pair). Agent: injected as a CUSTOM message (role:"custom"
   * → user-role LLM message). This is the ONE custom message type this
   * extension intentionally sends into the LLM context — it IS the mesh.
   *
   * Messages are held until the current agent run finishes, then appended as
   * one batch before a single turn starts.
   */
  private deliverMeshMessageToAgent(env: MeshEnvelope): void {
    const bodyText = typeof env.body === "string" ? env.body : JSON.stringify(env.body);
    const toolCallId = `mesh_${env.id}`;
    this.deps.broadcastToApp({
      type: "tool_request",
      tool_call_id: toolCallId,
      tool: "agent-network",
      args: env.re
        ? { from: env.from, re: env.re, message: bodyText }
        : { from: env.from, message: bodyText },
    });
    this.deps.broadcastToApp({ type: "tool_result", tool_call_id: toolCallId, result: { from: env.from, message: bodyText } });

    if (!this.deps.getPi()) {
      console.error(`[remote-pi] agent-network message from "${env.from}": agent session not bound yet — message dropped`);
      return;
    }
    this.pendingMeshMessages.push(env);
    this.scheduleDrain();
  }

  /** Build the injected custom message for one inbound envelope. */
  private messageForAgent(env: MeshEnvelope) {
    const bodyText = typeof env.body === "string" ? env.body : JSON.stringify(env.body);
    const header = `[agent-network] message from "${env.from}" (id=${env.id}${env.re ? `, re=${env.re}` : ""}):`;
    const footer = env.re
      ? "(This is a reply to a previous message of yours.)"
      : `(If a reply is expected, call agent_send with to="${env.from}" and re="${env.id}".)`;
    return {
      customType: "remote-pi:mesh-message",
      content: `${header}\n${bodyText}\n\n${footer}`,
      display: true,
    };
  }

  private scheduleDrain(): void {
    if (this.meshDrainScheduled || this.pendingMeshMessages.length === 0) return;
    this.meshDrainScheduled = true;
    queueMicrotask(() => {
      this.meshDrainScheduled = false;
      const pi = this.deps.getPi();
      if (this.agentRunActive || !pi || this.pendingMeshMessages.length === 0) return;

      const batch = this.pendingMeshMessages.splice(0);
      let delivered = 0;
      this.agentRunActive = true;
      try {
        batch.forEach((env, index) => {
          const isLast = index === batch.length - 1;
          pi.sendMessage(
            this.messageForAgent(env),
            isLast
              ? { triggerTurn: true, deliverAs: "followUp" }
              : { triggerTurn: false },
          );
          delivered += 1;
        });
      } catch (err) {
        this.agentRunActive = false;
        this.pendingMeshMessages = [...batch.slice(delivered), ...this.pendingMeshMessages];
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`[remote-pi] queued mesh delivery failed: ${detail}`);
        this.deps.notify(`[remote-pi] failed to process queued mesh messages: ${detail}`, "error");
      }
    });
  }

  // ── Agent run lifecycle (drives the drain) ────────────────────────────────

  onAgentStart(): void {
    this.agentRunActive = true;
    this.agentRunGeneration += 1;
  }

  /**
   * agent_end listeners finish before pi-agent-core clears its active run.
   * Defer the drain to the next event-loop turn so triggerTurn cannot collide
   * with the prompt that emitted this event. A queued continuation may start
   * first; its generation keeps the older timer from clearing the new run's
   * busy flag.
   */
  onAgentEnd(): void {
    const endedGeneration = this.agentRunGeneration;
    setTimeout(() => {
      if (this.agentRunGeneration !== endedGeneration) return;
      this.agentRunActive = false;
      this.scheduleDrain();
    }, 0);
  }

  // ── Status ────────────────────────────────────────────────────────────────

  statusLine(): string {
    if (this.node) {
      const name = this.node.name();
      return `🟢 Local mesh: connected as "${name}" (${this.peerCount} peer${this.peerCount === 1 ? "" : "s"})`;
    }
    return "⚪ Local mesh: not connected";
  }
}

import { SessionPeer, type AckResult, type SessionPeerOptions } from "./peer.js";
import type { Envelope } from "./envelope.js";
import type { Broker } from "./broker.js";
import type { BrokerRemote } from "./broker_remote.js";
import type { PiForwardClient } from "./forward.js";
import type { RelayClient } from "../relay/client.js";
import {
  attachCrossPcBridge,
  type CrossPcBridge,
} from "./bridge.js";
import { getOrCreateEd25519Keypair } from "../relay/storage.js";
import type { Ed25519Keypair } from "../relay/crypto.js";
import type { MeshTopologySnapshot } from "./siblings.js";
import { ownTopology } from "./topology.js";

/**
 * MeshNode is the composition point for the local UDS mesh plus the optional
 * cross-PC Relay bridge. Topology is retained independently from the current
 * role, Relay, Broker, or bridge publication lifecycle.
 */

export interface MeshNodeOptions {
  /** UDS broker socket path (e.g. ~/.pi/remote/sessions/local/broker.sock). */
  sockPath: string;
  /** Requested mesh name (broker may add a #N collision suffix). */
  name: string;
  cwd?: string;
  takeoverExisting?: boolean;
  auditPath?: string;
  /** Diagnostic logger. Defaults to a no-op (avoids leaking into TUIs). */
  log?: (msg: string) => void;
}

export type { AckResult } from "./peer.js";

interface BridgeParams {
  readonly relayUrl: string;
  readonly keypair?: Ed25519Keypair;
  readonly meshRequestTimeoutMs?: number;
  /** The externally-owned relay. MeshNode never closes it. */
  readonly relay: RelayClient;
}

function topologyEquals(
  left: MeshTopologySnapshot | null,
  right: MeshTopologySnapshot,
): boolean {
  if (!left) return false;
  if (
    left.self.pcPubkey !== right.self.pcPubkey ||
    left.self.pcLabel !== right.self.pcLabel ||
    left.self.legacyPcLabel !== right.self.legacyPcLabel ||
    left.siblings.length !== right.siblings.length
  ) {
    return false;
  }
  return left.siblings.every((identity, index) => {
    const other = right.siblings[index];
    return other !== undefined &&
      identity.pcPubkey === other.pcPubkey &&
      identity.pcLabel === other.pcLabel &&
      identity.legacyPcLabel === other.legacyPcLabel;
  });
}

function keypairEquals(
  left: Ed25519Keypair | undefined,
  right: Ed25519Keypair | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return Buffer.from(left.publicKey).equals(Buffer.from(right.publicKey)) &&
    Buffer.from(left.secretKey).equals(Buffer.from(right.secretKey));
}

function bridgeParamsEqual(left: BridgeParams | null, right: BridgeParams): boolean {
  return left !== null &&
    left.relayUrl === right.relayUrl &&
    left.meshRequestTimeoutMs === right.meshRequestTimeoutMs &&
    left.relay === right.relay &&
    keypairEquals(left.keypair, right.keypair);
}

export class MeshNode {
  private readonly peer_: SessionPeer;
  private readonly log: (msg: string) => void;

  private latestTopology: MeshTopologySnapshot | null = null;
  private topologyRevision = 0;
  private bridgeGeneration = 0;
  private bridgeAttachInFlight: Promise<void> | null = null;
  private bridgeAttachQueued = false;
  private closed = false;
  private closeInFlight: Promise<void> | null = null;

  private activeBridge: CrossPcBridge | null = null;
  private relay: RelayClient | null = null;
  private brokerRemote: BrokerRemote | null = null;
  private piForward: PiForwardClient | null = null;
  private keypair: Ed25519Keypair | null = null;
  private bridgeParams: BridgeParams | null = null;
  private reconnectWired = false;

  constructor(opts: MeshNodeOptions) {
    this.log = opts.log ?? ((): void => {});
    const peerOpts: SessionPeerOptions = { sockPath: opts.sockPath, name: opts.name };
    if (opts.cwd !== undefined) peerOpts.cwd = opts.cwd;
    if (opts.takeoverExisting !== undefined) peerOpts.takeoverExisting = opts.takeoverExisting;
    if (opts.auditPath !== undefined) peerOpts.auditPath = opts.auditPath;
    this.peer_ = new SessionPeer(peerOpts);
  }

  /** Join (or lead) the mesh. Resolves with the assigned name. */
  async connect(): Promise<string> {
    this._assertOpen();
    const name = await this.peer_.start();
    this._assertOpen();
    this._wireReconnect();
    if (this.bridgeParams) {
      await this._requestBridge();
      while (this.bridgeAttachQueued) await this._requestBridge();
    }
    return name;
  }

  /** Attach an externally-owned Relay. MeshNode never closes this Relay. */
  async attachBridge(opts: {
    relay: RelayClient;
    relayUrl: string;
    keypair?: Ed25519Keypair;
    meshRequestTimeoutMs?: number;
  }): Promise<void> {
    this._assertOpen();
    const next: BridgeParams = {
      relayUrl: opts.relayUrl,
      relay: opts.relay,
      ...(opts.keypair !== undefined ? { keypair: opts.keypair } : {}),
      ...(opts.meshRequestTimeoutMs !== undefined
        ? { meshRequestTimeoutMs: opts.meshRequestTimeoutMs }
        : {}),
    };
    if (!bridgeParamsEqual(this.bridgeParams, next)) {
      this.bridgeGeneration += 1;
      this._teardownPublishedBridge();
      this.bridgeParams = next;
    }
    this._wireReconnect();
    this.bridgeAttachQueued = true;
    await this._requestBridge();
    while (this.bridgeAttachQueued) await this._requestBridge();
  }

  /** Retain a canonical immutable topology independently from bridge state. */
  setTopology(snapshot: MeshTopologySnapshot): void {
    const owned = ownTopology(snapshot);
    if (
      this.latestTopology &&
      this.latestTopology.self.pcPubkey !== owned.self.pcPubkey
    ) {
      throw new Error("mesh: technical self key cannot change");
    }
    if (!topologyEquals(this.latestTopology, owned)) {
      this.topologyRevision += 1;
    }
    this.latestTopology = owned;
    // Identical calls still reach an active router so dirty refreshes retry.
    this.brokerRemote?.setTopology(owned);
  }

  hasTopology(): boolean {
    return this.latestTopology !== null;
  }

  /** Forget bridge parameters and tear down publication, retaining topology. */
  detachBridge(): void {
    this.bridgeGeneration += 1;
    this.bridgeAttachQueued = false;
    this.bridgeParams = null;
    this._teardownPublishedBridge();
  }

  private _assertOpen(): void {
    if (this.closed) throw new Error("mesh: node is closed");
  }

  private _wireReconnect(): void {
    if (this.reconnectWired) return;
    this.reconnectWired = true;
    this.peer_.onReconnect(() => { void this._onReconnect(); });
  }

  private async _onReconnect(): Promise<void> {
    if (this.closed || !this.bridgeParams) return;
    this.bridgeGeneration += 1;
    this._teardownPublishedBridge();
    this.bridgeAttachQueued = true;
    try {
      await this._requestBridge();
    } catch (error) {
      this.log(`mesh bridge: re-attach after failover failed: ${String(error)}`);
    }
  }

  /** One serialized attach loop. Newer generations are drained before exit. */
  private _requestBridge(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("mesh: node is closed"));
    this.bridgeAttachQueued = true;
    if (this.bridgeAttachInFlight) return this.bridgeAttachInFlight;

    const run = async (): Promise<void> => {
      while (this.bridgeAttachQueued) {
        this.bridgeAttachQueued = false;
        const generation = this.bridgeGeneration;
        try {
          await this._attemptBridge(generation);
        } catch (error) {
          if (generation !== this.bridgeGeneration) {
            this.bridgeAttachQueued = true;
            continue;
          }
          throw error;
        }
        if (generation !== this.bridgeGeneration) {
          this.bridgeAttachQueued = true;
        }
      }
    };
    const inFlight = run().finally(() => {
      if (this.bridgeAttachInFlight === inFlight) {
        this.bridgeAttachInFlight = null;
      }
    });
    this.bridgeAttachInFlight = inFlight;
    return inFlight;
  }

  private async _attemptBridge(generation: number): Promise<void> {
    if (this.closed || this.activeBridge) return;
    if (this.peer_.currentRole() !== "leader") return;
    const broker: Broker | null = this.peer_.localBroker();
    if (!broker) return;
    const paramsAtStart = this.bridgeParams;
    if (!paramsAtStart) return;
    const revisionAtStart = this.topologyRevision;

    const keypair = paramsAtStart.keypair ?? this.keypair ??
      await getOrCreateEd25519Keypair();
    if (generation !== this.bridgeGeneration || paramsAtStart !== this.bridgeParams) {
      return;
    }

    // Injected relay only — the host (RelayService) owns its lifecycle,
    // including reconnect. A closed relay simply defers the attach until the
    // host hands us a live one via attachBridge().
    const candidateRelay = paramsAtStart.relay;
    if (this._relayIsClosed(candidateRelay)) return;

    let candidateClosed = false;
    const markCandidateClosed = (): void => { candidateClosed = true; };
    let markerInstalled = false;
    let result: CrossPcBridge | null = null;
    try {
      candidateRelay.on("close", markCandidateClosed);
      markerInstalled = true;
      result = await attachCrossPcBridge({
        broker,
        relay: candidateRelay,
        relayUrl: paramsAtStart.relayUrl,
        keypair,
        ...(this.latestTopology ? { topology: this.latestTopology } : {}),
        ...(paramsAtStart.meshRequestTimeoutMs !== undefined
          ? { meshRequestTimeoutMs: paramsAtStart.meshRequestTimeoutMs }
          : {}),
        log: this.log,
      });

      if (this._attemptIsStale(
        generation,
        paramsAtStart,
        broker,
        candidateRelay,
        candidateClosed,
      )) {
        result.detach();
        this._removeMarker(candidateRelay, markCandidateClosed, markerInstalled);
        markerInstalled = false;
        return;
      }

      if (this.latestTopology) {
        if (this.topologyRevision !== revisionAtStart) {
          result.brokerRemote.setTopology(this.latestTopology);
        }
      } else {
        this.setTopology(result.topology);
      }

      result.activate();

      if (this._attemptIsStale(
        generation,
        paramsAtStart,
        broker,
        candidateRelay,
        candidateClosed,
      )) {
        result.detach();
        this._removeMarker(candidateRelay, markCandidateClosed, markerInstalled);
        markerInstalled = false;
        return;
      }

      this._removeMarker(candidateRelay, markCandidateClosed, markerInstalled);
      markerInstalled = false;

      // Publish only after activation.
      this.activeBridge = result;
      this.brokerRemote = result.brokerRemote;
      this.piForward = result.piForward;
      this.relay = candidateRelay;
      this.keypair = keypair;
    } catch (error) {
      if (markerInstalled) {
        try { candidateRelay.off("close", markCandidateClosed); } catch { /* best-effort */ }
      }
      try { result?.detach(); } catch { /* preserve original error */ }
      throw error;
    }
  }

  private _attemptIsStale(
    generation: number,
    paramsAtStart: BridgeParams,
    broker: Broker,
    candidateRelay: RelayClient,
    candidateClosed: boolean,
  ): boolean {
    return this.closed ||
      generation !== this.bridgeGeneration ||
      paramsAtStart !== this.bridgeParams ||
      this.peer_.currentRole() !== "leader" ||
      this.peer_.localBroker() !== broker ||
      candidateClosed ||
      this._relayIsClosed(candidateRelay);
  }

  private _relayIsClosed(relay: RelayClient): boolean {
    return !relay.isOpen();
  }

  private _removeMarker(
    relay: RelayClient,
    marker: () => void,
    installed: boolean,
  ): void {
    if (installed) relay.off("close", marker);
  }

  private _teardownPublishedBridge(): void {
    const bridge = this.activeBridge;
    this.activeBridge = null;
    this.brokerRemote = null;
    this.piForward = null;
    this.relay = null;
    try { bridge?.detach(); } catch { /* best-effort teardown */ }
  }

  /** Announce the local peer set to siblings (Pi broker peer_joined/left). */
  onLocalPeersChanged(local: string[]): void {
    this.brokerRemote?.onLocalPeersChanged(local);
  }

  /** True when the cross-PC relay bridge is active (this node is leader). */
  hasBridge(): boolean {
    return this.activeBridge !== null;
  }

  // ── Mesh API (delegates to SessionPeer) ─────────────────────────────────────

  /** The underlying SessionPeer — for consumers that need it directly (tools). */
  peer(): SessionPeer {
    return this.peer_;
  }

  /** Fire-and-forget send. `to` may be a name, `<pc>:<name>`, or "broadcast". */
  async send(to: string | string[], body: unknown, re: string | null = null): Promise<void> {
    return this.peer_.send(to, body, re);
  }

  /** Unicast send + await broker ACK (received/busy/denied/timeout). */
  async sendWithAck(to: string, body: unknown, re: string | null = null, timeoutMs?: number): Promise<AckResult> {
    return timeoutMs === undefined
      ? this.peer_.sendWithAck(to, body, re)
      : this.peer_.sendWithAck(to, body, re, timeoutMs);
  }

  /** Send + await the first reply whose `re` matches the outbound id. */
  async request(to: string, body: unknown, timeoutMs?: number): Promise<Envelope> {
    return timeoutMs === undefined
      ? this.peer_.request(to, body)
      : this.peer_.request(to, body, timeoutMs);
  }

  /** Subscribe to inbound envelopes. Returns an unsubscribe fn. */
  onMessage(handler: (env: Envelope) => void): () => void {
    return this.peer_.onMessage(handler);
  }

  /** Subscribe to post-failover reconnects. Returns an unsubscribe fn. */
  onReconnect(handler: () => void): () => void {
    return this.peer_.onReconnect(handler);
  }

  /** Assigned clean mesh name (after any #N collision suffix). */
  name(): string {
    return this.peer_.name();
  }

  /** Canonical mesh address (`[<pc>:]<cwd>@<nome>`) — echo, never compose. */
  address(): string {
    return this.peer_.address();
  }

  async rename(newName: string): Promise<string> {
    return this.peer_.rename(newName);
  }

  currentRole(): "leader" | "follower" {
    return this.peer_.currentRole();
  }

  localBroker(): Broker | null {
    return this.peer_.localBroker();
  }

  async listPeers(timeoutMs = 2_000): Promise<string[]> {
    const reply = await this.peer_.request("broker", { type: "list_peers" }, timeoutMs);
    const body = reply.body as { peers?: string[] } | null;
    return (body?.peers ?? []).filter((peer) => peer !== this.peer_.address());
  }

  close(): Promise<void> {
    if (this.closeInFlight) return this.closeInFlight;
    this.closed = true;
    this.detachBridge();
    const leaving = Promise.resolve(this.peer_.leave());
    this.closeInFlight = leaving;
    return leaving;
  }
}

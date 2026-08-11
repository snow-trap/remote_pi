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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ServerMessage } from "../relay/protocol.js";
import { MeshNode } from "./node.js";
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
export declare class MeshService {
    private readonly deps;
    private node;
    private peerCount;
    private cwdLock;
    private lockedName;
    private joinGeneration;
    private pendingMeshMessages;
    private agentRunActive;
    private agentRunGeneration;
    private meshDrainScheduled;
    constructor(deps: MeshServiceDeps);
    get currentNode(): MeshNode | null;
    get currentPeerCount(): number;
    get isJoined(): boolean;
    /** Requested mesh name for a fresh join: sanitized pi session name, else
     *  the cwd leaf. */
    private requestedName;
    /**
     * Join the fixed local UDS mesh ("local" session). Acquires the
     * per-(cwd,name) lock first (auto-suffixing `name#2`, `name#3`, … when
     * same-named agents share the folder), then connects the MeshNode.
     */
    join(ctx: Pick<ExtensionContext, "ui" | "cwd">): Promise<void>;
    /** Leave the mesh + release the cwd lock. Idempotent. */
    leave(): Promise<void>;
    /** session_shutdown teardown. */
    dispose(): Promise<void>;
    /**
     * Follow a pi session rename live: broker soft leave+rejoin → new address
     * `<cwd>@<newName>`. Returns the assigned name (broker may add `#N`), or
     * null when not on the mesh / rename failed.
     */
    rename(newName: string, cwd: string): Promise<string | null>;
    private onMeshMessage;
    /** Re-queries the broker for the authoritative peer count. Fire-and-forget. */
    private refreshPeerCount;
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
    private deliverMeshMessageToAgent;
    /** Build the injected custom message for one inbound envelope. */
    private messageForAgent;
    private scheduleDrain;
    onAgentStart(): void;
    /**
     * agent_end listeners finish before pi-agent-core clears its active run.
     * Defer the drain to the next event-loop turn so triggerTurn cannot collide
     * with the prompt that emitted this event. A queued continuation may start
     * first; its generation keeps the older timer from clearing the new run's
     * busy flag.
     */
    onAgentEnd(): void;
    statusLine(): string;
}

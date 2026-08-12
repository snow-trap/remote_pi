/**
 * RelayService — the phone-app channel over the relay WebSocket.
 *
 * Owns every piece of relay-side state (the WS client, per-owner peer
 * channels, reconnect backoff, pairing, SelfRevoke producer, session-sync
 * buffer, queued messages, steer tracking, image previews, room_meta). All
 * state lives on the instance created by the extension factory — no
 * module-level mutable singletons, so a session replacement tears the whole
 * service down with `dispose()` and a fresh boot starts from a clean slate.
 *
 * The service never touches the mesh directly: the local broker node is
 * reached through `deps.getMeshNode()` (for the cross-PC bridge), and the
 * pi session through `deps.getPi()`. UI side effects go through
 * `deps.notify` / `deps.refreshFooter`.
 */
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MeshNode } from "../mesh/node.js";
import type { ClientMessage, ServerMessage, ThinkingLevel, ByeReason } from "./protocol.js";
import { PlainPeerChannel } from "./peer_channel.js";
export type RelayState = "idle" | "started";
/** UI/context handles the service needs from the extension shell. All getters
 *  are live lookups — the shell swaps the underlying ctx on every
 *  session_start, and a stale captured ctx throws on touch (issue #55). */
export interface RelayServiceDeps {
    getPi: () => ExtensionAPI | null;
    getMeshNode: () => MeshNode | null;
    /** Display name for room_meta / pair_ok / QR: mesh name when joined, else
     *  the pi session name, else basename(cwd). */
    getDisplayName: (cwd: string) => string;
    /** Freshest command ctx (may be stale after session replacement — callers
     *  guard with try/catch); null when no command has run yet. */
    getCommandCtx: () => Pick<ExtensionContext, "ui" | "abort" | "cwd"> | null;
    /** Freshest session_start ctx — always bound to the current session. */
    getEventCtx: () => Pick<ExtensionContext, "compact" | "abort" | "ui"> | null;
    /** Re-capture the command ctx after an app-driven newSession (the old one
     *  goes stale at replacement; the fresh ctx arrives via withSession). */
    setCommandCtx: (ctx: unknown) => void;
    /** Current working directory (session_cwd or process cwd). */
    getCwd: () => string;
    notify: (message: string, level?: "info" | "warning" | "error") => void;
    refreshFooter: () => void;
    isDisposed: () => boolean;
}
export declare class RelayService {
    private readonly deps;
    private state;
    private relay;
    private relayUrl;
    /** Owners currently connected via the relay. Key = app peer pubkey (Ed25519,
     *  base64 standard); value = the dedicated PlainPeerChannel. */
    private readonly activePeers;
    private peerShort;
    private myRoomId;
    private myRoomMeta;
    private currentModel;
    private currentThinking;
    private reconnectTimer;
    private reconnectAttempt;
    private lifecycleGeneration;
    private stopAutoListener;
    private cachedEd25519;
    private selfRevoke;
    private selfRevokeEpoch;
    private selfRevokeTopologyReadyEpoch;
    private selfRevokeTopology;
    private sessionStartedAt;
    private messageBuffer;
    private pendingSteers;
    private lastConsumedSteerText;
    private queuedItems;
    private currentTurnId;
    private pendingReceivedImagePreviews;
    private hasGlobalPairings;
    private readonly harness;
    private readonly hostname;
    constructor(deps: RelayServiceDeps);
    get isStarted(): boolean;
    get activePeerCount(): number;
    get connectedPeerShort(): string;
    get hasAnyPeer(): boolean;
    get pairedBefore(): boolean;
    get currentRelayUrl(): string | null;
    get turnInFlight(): string | null;
    get working(): boolean;
    /** Seed the global-pairings cache from peers.json (footer relay slot). */
    refreshPairingsCache(): void;
    /** `/remote-pi start relay` / auto-start. Connects the WS + auto-listener. */
    start(ctx: Pick<ExtensionContext, "ui" | "cwd">): Promise<void>;
    /**
     * Full relay teardown: stop listener, detach channels, close WS → idle.
     * `byeReason`: when present and the channel is up, broadcasts `{type:"bye"}`
     * first so apps see offline immediately instead of waiting ~50s for a ping
     * miss.
     */
    stop(byeReason?: ByeReason): void;
    /** session_shutdown: tear down everything this instance owns. */
    dispose(): void;
    /**
     * Hand the live relay to MeshNode so it can bring up the cross-PC bridge
     * (BrokerRemote + sibling discovery) — but only when this Pi is the leader
     * (broker host). MeshNode is idempotent + re-attaches across UDS failovers,
     * so this is safe to call from start, relay reconnect, or SelfRevoke.
     */
    attachBridgeIfReady(): void;
    private onRelayClose;
    private isCurrentReconnect;
    private scheduleReconnect;
    private attemptReconnect;
    /** `/remote-pi pair` — show a fresh QR (relay must be up). */
    pair(ctx: Pick<ExtensionContext, "ui" | "cwd">, args?: string): Promise<void>;
    /** `/remote-pi devices`. */
    listDevices(ctx: Pick<ExtensionContext, "ui">): Promise<void>;
    /** `/remote-pi revoke <shortid>`. */
    revoke(arg: string, ctx: Pick<ExtensionContext, "ui" | "cwd">): Promise<void>;
    /** Completion source for `/remote-pi revoke <shortid>`. */
    shortidCompletions(prefix: string): Promise<Array<{
        value: string;
        label: string;
    }>>;
    /** Broadcast to every attached owner. For per-request replies use the
     *  sender channel directly. */
    broadcastToActive(msg: ServerMessage): void;
    private attachPeerChannel;
    private detachPeerChannel;
    /** Per-owner disconnect callback (relay said the peer is gone). */
    onPeerDisconnect(appPeerId?: string): void;
    private attachOwner;
    private liveCtx;
    private installAutoListener;
    private handlePairRequest;
    private findKnownPeer;
    private revokeActiveOwnerRuntime;
    routeClientMessageFrom(sender: PlainPeerChannel, msg: ClientMessage, ctx: Pick<ExtensionContext, "abort">): void;
    private abortCurrentTurn;
    private handleSessionSync;
    /** Reset the pi-side mirror after a successful session_new; broadcast the
     *  EMPTY history so every owner drops the stale conversation. */
    private resetSessionForNew;
    private queuedStateMessage;
    private sendQueuedState;
    private broadcastQueuedState;
    private resetQueuedItems;
    private upsertQueuedItem;
    private clearQueuedItems;
    private isBusyForQueueDrain;
    /** Called on agent_end / turn_end — delivers the next queued app message. */
    maybeDrainQueuedItem(): void;
    private trackPendingSteer;
    private consumePendingSteerForStartedUser;
    private broadcastConsumedSteerForUserContent;
    private echoUserMessage;
    private shouldDeferReceivedImagePreview;
    private sendReceivedImagePreviewNow;
    private flushPendingReceivedImagePreviews;
    private emitReceivedImagePreviews;
    private deliverImageUserMessage;
    /** Mirror terminal/RPC input to every connected owner. Returns true when
     *  the event was mirrored (caller continues regardless). */
    onUserInput(event: {
        text: string;
        source?: string;
    }): void;
    onModelSelect(modelName: string): void;
    onThinkingSelect(level: ThinkingLevel): void;
    /** Late model hydration on the first turn (lazy SDK model resolution). */
    onTurnStart(ctx: unknown): void;
    onTurnEnd(): void;
    private publishWorking;
    onMessageStart(event: {
        message?: unknown;
    }): void;
    onMessageUpdate(event: {
        assistantMessageEvent: {
            type: string;
            delta?: string;
        };
    }): void;
    onToolExecutionStart(event: {
        toolCallId: string;
        toolName: string;
        args: unknown;
    }): void;
    onToolExecutionEnd(event: {
        toolCallId: string;
        result: unknown;
        isError: boolean;
    }): void;
    /** message_end: buffer the message for session_sync + forward errors. */
    onMessageEnd(event: {
        message?: unknown;
    }): void;
    onAgentEnd(): void;
    /** session_before_compact / session_compact bracket compaction with
     *  working=true/false (compact() doesn't run a turn). */
    onBeforeCompact(): void;
    onCompact(event: {
        compactionEntry?: unknown;
    }): void;
    statusLine(): string;
}
export interface PairCodeEntry {
    ascii: string;
    uri: string;
    expiresAt: number;
}

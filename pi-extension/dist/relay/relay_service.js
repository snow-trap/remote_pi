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
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { buildQRUri, qrSession, renderQRAscii, clampPairTtlMs, TOKEN_TTL_MS } from "./qr.js";
import { addPeer, getOrCreateEd25519Keypair, KeyringUnavailableError, listPeers, removePeer, snapshotOwnerPubkeys, conditionalRemovePeer, } from "./storage.js";
import { MeshClient } from "../mesh/client.js";
import { canonicalizeEd25519PublicKey, decodeEd25519PublicKey, publicKeyFingerprint, } from "../mesh/encoding.js";
import { SelfRevoke } from "../mesh/self_revoke.js";
import { RelayClient, RoomAlreadyOpenError } from "./client.js";
import { PlainPeerChannel } from "./peer_channel.js";
import { roomIdFor } from "./rooms.js";
import { resolveRelayUrl, toWebSocketUrl } from "./url.js";
import { handleSessionCompact, handleModelSet, handleThinkingSet, handleListModels, handleSessionNew, } from "./actions.js";
import { ensureModelRegistry, observeModelRegistry } from "./actions_registry.js";
import { collectReceivedImagePreviews, contentFromUserMessage, REMOTE_PI_RECEIVED_IMAGE_TYPE, } from "./images.js";
import { mapAgentMessagesToEvents, stringifyContent, stringifyToolResult } from "./history.js";
import { enrichToolArgs } from "./edit_hunks.js";
import { wakeAgent } from "../wake.js";
// Backoffs in ms: 1s, 2s, 5s, 10s, 30s, then stays at 30s.
const RECONNECT_BACKOFFS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const SYNC_LIMIT_DEFAULT = 30;
const NOOP_CTX = { ui: { notify: () => undefined }, abort: () => undefined };
/**
 * Lazily resolve the package version so `pair_ok.harness.version` reflects
 * what's actually shipped. Best-effort — falls back to "0.0.0".
 */
function readExtensionVersion() {
    try {
        const here = fileURLToPath(import.meta.url);
        const pkgPath = join(here, "..", "..", "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        return typeof pkg.version === "string" ? pkg.version : "0.0.0";
    }
    catch {
        return "0.0.0";
    }
}
export class RelayService {
    deps;
    state = "idle";
    relay = null;
    relayUrl = null; // URL used by current connection
    /** Owners currently connected via the relay. Key = app peer pubkey (Ed25519,
     *  base64 standard); value = the dedicated PlainPeerChannel. */
    activePeers = new Map();
    peerShort = ""; // shortid of the most recently attached peer (UX hint)
    myRoomId = null;
    myRoomMeta = null;
    currentModel;
    currentThinking;
    // Reconnect machinery
    reconnectTimer = null;
    reconnectAttempt = 0;
    lifecycleGeneration = 0;
    stopAutoListener = null;
    cachedEd25519 = null;
    // SelfRevoke producer (cross-PC membership poller)
    selfRevoke = null;
    selfRevokeEpoch = 0;
    selfRevokeTopologyReadyEpoch = -1;
    selfRevokeTopology = null;
    // Session-sync mirror state
    sessionStartedAt = null;
    messageBuffer = [];
    pendingSteers = [];
    lastConsumedSteerText = null;
    queuedItems = [];
    currentTurnId = null;
    // Image previews pending while a turn runs
    pendingReceivedImagePreviews = [];
    // Cached state of global pairings (peers.json) for the footer
    hasGlobalPairings = false;
    harness = { name: "Pi coding agent", version: readExtensionVersion() };
    hostname = hostname();
    constructor(deps) {
        this.deps = deps;
    }
    // ── Public getters (footer / status / shell) ─────────────────────────────
    get isStarted() { return this.state !== "idle"; }
    get activePeerCount() { return this.activePeers.size; }
    get connectedPeerShort() { return this.peerShort; }
    get hasAnyPeer() { return this.activePeers.size > 0; }
    get pairedBefore() { return this.hasGlobalPairings; }
    get currentRelayUrl() { return this.relayUrl; }
    get turnInFlight() { return this.currentTurnId; }
    get working() { return this.myRoomMeta?.working === true; }
    /** Seed the global-pairings cache from peers.json (footer relay slot). */
    refreshPairingsCache() {
        void listPeers()
            .then((peers) => {
            this.hasGlobalPairings = peers.length > 0;
            this.deps.refreshFooter();
        })
            .catch(() => { });
    }
    // ── Lifecycle ─────────────────────────────────────────────────────────────
    /** `/remote-pi start relay` / auto-start. Connects the WS + auto-listener. */
    async start(ctx) {
        if (this.state !== "idle") {
            ctx.ui.notify("[remote-pi] Relay already started.", "warning");
            return;
        }
        const lifecycleGeneration = ++this.lifecycleGeneration;
        const isCurrentCandidate = () => (!this.deps.isDisposed() &&
            lifecycleGeneration === this.lifecycleGeneration &&
            this.state === "idle" &&
            this.relay === null);
        let edKp;
        try {
            edKp = await getOrCreateEd25519Keypair();
        }
        catch (err) {
            if (!isCurrentCandidate())
                return;
            if (err instanceof KeyringUnavailableError) {
                // The platform keyring is locked/denied and there's no file identity
                // to fall back to. Refuse to mint a new key (that's what silently
                // broke pairing after idle); abort with an actionable message.
                ctx.ui.notify("[remote-pi] Could not read this machine's identity: the system " +
                    "keychain is locked or access was denied. Unlock it (open the app / " +
                    "log in) and run /remote-pi start relay again. Your pairing is NOT lost. " +
                    "(Set REMOTE_PI_ALLOW_FILE_IDENTITY=1 only for headless hosts.)", "error");
                return;
            }
            throw err;
        }
        if (!isCurrentCandidate())
            return;
        this.cachedEd25519 = edKp;
        const { url: relayUrl, source } = resolveRelayUrl();
        const myShort = Buffer.from(edKp.publicKey).toString("base64").slice(0, 8);
        const cwd = "cwd" in ctx ? ctx.cwd : process.cwd();
        const sessionName = this.deps.getDisplayName(cwd);
        // plan/41: derive the App↔Pi room from (cwd, name) so several agents in
        // the SAME folder get distinct rooms.
        const roomId = roomIdFor(cwd, sessionName);
        // Seed the current model so room_meta carries it on connect. Prefer the
        // live getModel()/ctx.model; fall back to the CONFIGURED default
        // (defaultProvider/defaultModel in <cwd>/.pi/settings.json) — the model
        // an idle session will actually use once prompted.
        if (!this.currentModel) {
            try {
                const c = ctx;
                const live = c.getModel?.() ?? c.model;
                if (live) {
                    this.currentModel = live.name ?? live.id ?? undefined;
                }
                else {
                    const sm = SettingsManager.create(cwd);
                    const provider = sm.getDefaultProvider();
                    const modelId = sm.getDefaultModel();
                    if (modelId) {
                        const found = provider
                            ? ctx.modelRegistry?.find(provider, modelId)
                            : undefined;
                        this.currentModel = found?.name ?? modelId;
                    }
                }
            }
            catch { /* defensive — never block start on a model lookup */ }
        }
        // Seed thinking from the SDK's current level so the first room_meta hello
        // carries it. Future toggles go through the thinking_level_select hook.
        try {
            this.currentThinking = this.deps.getPi()?.getThinkingLevel();
        }
        catch { /* defensive — never block start on this */ }
        const roomMeta = { name: sessionName, cwd };
        const modelName = this.currentModel;
        if (modelName)
            roomMeta.model = modelName;
        if (this.currentThinking)
            roomMeta.thinking = this.currentThinking;
        // Persist so a reconnect can replay the same hello payload — without this
        // the relay creates a "default room" phantom entry.
        this.myRoomMeta = roomMeta;
        ctx.ui.notify(`[remote-pi] Connecting to relay ${relayUrl} (source: ${source}, room: ${roomId})…`, "info");
        const relay = new RelayClient(toWebSocketUrl(relayUrl), edKp);
        try {
            await relay.connect({ roomId, roomMeta });
        }
        catch (err) {
            try {
                relay.close();
            }
            catch { /* best-effort rejected candidate cleanup */ }
            if (!isCurrentCandidate())
                return;
            if (err instanceof RoomAlreadyOpenError) {
                ctx.ui.notify("[remote-pi] Already running in this cwd. Stop the other terminal first.", "error");
                return;
            }
            ctx.ui.notify(`[remote-pi] relay connect failed: ${String(err)}`, "error");
            return;
        }
        if (!isCurrentCandidate()) {
            try {
                relay.close();
            }
            catch { /* best-effort stale candidate cleanup */ }
            return;
        }
        this.relay = relay;
        this.relayUrl = relayUrl;
        this.peerShort = myShort;
        this.myRoomId = roomId;
        this.state = "started";
        // Set ONLY on first start since process boot; later start cycles preserve
        // the original epoch so the app keeps treating it as the same session.
        if (this.sessionStartedAt === null)
            this.sessionStartedAt = Date.now();
        relay.on("close", () => this.onRelayClose(relay));
        this.stopAutoListener = this.installAutoListener(relay);
        this.deps.refreshFooter();
        // SelfRevoke is the Pi path's single initial topology producer. Its first
        // coalesced sweep always publishes verified membership or a safe fallback
        // before the bridge may attach.
        let createdProducer = false;
        if (this.selfRevoke === null) {
            createdProducer = true;
            const producerEpoch = ++this.selfRevokeEpoch;
            this.selfRevokeTopologyReadyEpoch = -1;
            this.selfRevokeTopology = null;
            let producer;
            producer = new SelfRevoke({
                client: new MeshClient(relayUrl),
                storage: { snapshotOwnerPubkeys, conditionalRemovePeer },
                myPubkey: edKp.publicKey,
                onRevoke: (rawOwnerPubkey, canonicalOwnerPubkey) => {
                    if (this.selfRevoke !== producer || producerEpoch !== this.selfRevokeEpoch)
                        return;
                    this.revokeActiveOwnerRuntime(canonicalOwnerPubkey);
                    void rawOwnerPubkey;
                },
                onAuthoritativeOwners: (canonicalOwnerPubkeys) => {
                    if (this.selfRevoke !== producer || producerEpoch !== this.selfRevokeEpoch)
                        return;
                    const presentOwners = new Set(canonicalOwnerPubkeys);
                    let effectFailed = false;
                    for (const canonicalOwnerPubkey of [...this.activePeers.keys()]) {
                        if (this.selfRevoke !== producer || producerEpoch !== this.selfRevokeEpoch)
                            return;
                        if (presentOwners.has(canonicalOwnerPubkey))
                            continue;
                        try {
                            this.revokeActiveOwnerRuntime(canonicalOwnerPubkey);
                        }
                        catch {
                            effectFailed = true;
                        }
                    }
                    if (effectFailed)
                        throw new Error("Owner runtime reconciliation failed");
                },
                onTopologyChanged: (snapshot) => {
                    if (this.selfRevoke !== producer || producerEpoch !== this.selfRevokeEpoch)
                        return;
                    this.selfRevokeTopology = snapshot;
                    this.deps.getMeshNode()?.setTopology(snapshot);
                    this.selfRevokeTopologyReadyEpoch = producerEpoch;
                    this.attachBridgeIfReady();
                },
                log: { info: () => { }, warn: () => { }, error: () => { } },
            });
            this.selfRevoke = producer;
            producer.start();
            await producer.checkOnce();
            if (this.deps.isDisposed() ||
                this.selfRevoke !== producer ||
                producerEpoch !== this.selfRevokeEpoch ||
                this.relay !== relay) {
                return;
            }
        }
        // Reconnect reuses the current producer's retained snapshot. Initial
        // startup is callback-driven above, so no second attach.
        if (!createdProducer)
            this.attachBridgeIfReady();
        ctx.ui.notify(`[remote-pi] state: started (peer=${myShort}) — Connected to relay ${relayUrl}`, "info");
    }
    /**
     * Full relay teardown: stop listener, detach channels, close WS → idle.
     * `byeReason`: when present and the channel is up, broadcasts `{type:"bye"}`
     * first so apps see offline immediately instead of waiting ~50s for a ping
     * miss.
     */
    stop(byeReason) {
        this.lifecycleGeneration += 1;
        if (byeReason && this.state !== "idle" && this.hasAnyPeer) {
            this.broadcastToActive({ type: "bye", reason: byeReason });
        }
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.reconnectAttempt = 0;
        this.stopAutoListener?.();
        this.stopAutoListener = null;
        if (this.queuedItems.length > 0)
            this.resetQueuedItems({ broadcast: true });
        for (const ch of this.activePeers.values()) {
            try {
                ch.detach();
            }
            catch { /* best-effort */ }
        }
        this.activePeers.clear();
        this.peerShort = "";
        this.currentTurnId = null;
        this.pendingReceivedImagePreviews.length = 0;
        this.pendingSteers = [];
        this.lastConsumedSteerText = null;
        this.resetQueuedItems();
        // Invalidate async producers and bridge ownership before closing the host
        // relay. A synchronous/delayed close callback must observe stale identity.
        const producer = this.selfRevoke;
        this.selfRevoke = null;
        this.selfRevokeEpoch += 1;
        this.selfRevokeTopologyReadyEpoch = -1;
        this.selfRevokeTopology = null;
        producer?.stop();
        this.deps.getMeshNode()?.detachBridge();
        const relay = this.relay;
        this.relay = null;
        this.relayUrl = null;
        relay?.close();
        // sessionStartedAt + messageBuffer intentionally survive stop/start: the
        // pi agent session outlives the relay connection, and the buffer must
        // keep accumulating terminal turns for the next session_sync.
        this.state = "idle";
        this.deps.refreshFooter();
    }
    /** session_shutdown: tear down everything this instance owns. */
    dispose() {
        if (this.state !== "idle")
            this.stop();
    }
    // ── Cross-PC bridge wiring ────────────────────────────────────────────────
    /**
     * Hand the live relay to MeshNode so it can bring up the cross-PC bridge
     * (BrokerRemote + sibling discovery) — but only when this Pi is the leader
     * (broker host). MeshNode is idempotent + re-attaches across UDS failovers,
     * so this is safe to call from start, relay reconnect, or SelfRevoke.
     */
    attachBridgeIfReady() {
        const meshNode = this.deps.getMeshNode();
        if (!meshNode || !this.relay || !this.relayUrl || !this.cachedEd25519)
            return;
        // A newly-created SelfRevoke producer must publish its own initial
        // verified or fallback snapshot before any retained topology may attach.
        if (this.selfRevoke !== null) {
            if (this.selfRevokeTopologyReadyEpoch !== this.selfRevokeEpoch ||
                this.selfRevokeTopology === null) {
                return;
            }
            if (!meshNode.hasTopology())
                meshNode.setTopology(this.selfRevokeTopology);
        }
        void meshNode
            .attachBridge({ relay: this.relay, relayUrl: this.relayUrl, keypair: this.cachedEd25519 })
            .catch(() => { });
    }
    // ── Reconnect ─────────────────────────────────────────────────────────────
    onRelayClose(closedRelay) {
        if (this.relay !== closedRelay)
            return; // delayed close from a replaced relay
        if (this.state === "idle")
            return;
        this.lifecycleGeneration += 1;
        this.stopAutoListener?.();
        this.stopAutoListener = null;
        for (const ch of this.activePeers.values()) {
            try {
                ch.detach();
            }
            catch { /* best-effort */ }
        }
        if (this.queuedItems.length > 0)
            this.resetQueuedItems({ broadcast: true });
        this.activePeers.clear();
        this.peerShort = "";
        this.currentTurnId = null;
        this.pendingSteers = [];
        this.lastConsumedSteerText = null;
        this.resetQueuedItems();
        this.relay = null; // relayUrl preserved for retry
        this.deps.getMeshNode()?.detachBridge();
        this.state = "started";
        this.deps.refreshFooter();
        const reconnectUrl = this.relayUrl;
        if (reconnectUrl)
            this.scheduleReconnect(this.lifecycleGeneration, reconnectUrl);
    }
    isCurrentReconnect(lifecycleGeneration, url) {
        return (lifecycleGeneration === this.lifecycleGeneration &&
            this.state === "started" &&
            this.relay === null &&
            this.relayUrl === url);
    }
    scheduleReconnect(lifecycleGeneration, url) {
        if (this.reconnectTimer !== null)
            return;
        if (!this.cachedEd25519)
            return;
        if (!this.isCurrentReconnect(lifecycleGeneration, url))
            return;
        const idx = Math.min(this.reconnectAttempt, RECONNECT_BACKOFFS_MS.length - 1);
        const delay = RECONNECT_BACKOFFS_MS[idx];
        this.reconnectAttempt += 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.isCurrentReconnect(lifecycleGeneration, url))
                return;
            void this.attemptReconnect(lifecycleGeneration, url);
        }, delay);
    }
    async attemptReconnect(lifecycleGeneration, url) {
        if (!this.cachedEd25519)
            return;
        if (!this.isCurrentReconnect(lifecycleGeneration, url))
            return;
        const edKp = this.cachedEd25519;
        const relay = new RelayClient(toWebSocketUrl(url), edKp);
        try {
            // Replay the same room identity from start(), or the relay logs this WS
            // as a default-room peer and the app shows a phantom legacy session.
            await relay.connect({
                ...(this.myRoomId ? { roomId: this.myRoomId } : {}),
                ...(this.myRoomMeta ? { roomMeta: this.myRoomMeta } : {}),
            });
        }
        catch {
            try {
                relay.close();
            }
            catch { /* best-effort rejected candidate cleanup */ }
            if (!this.isCurrentReconnect(lifecycleGeneration, url))
                return;
            this.scheduleReconnect(lifecycleGeneration, url);
            return;
        }
        if (!this.isCurrentReconnect(lifecycleGeneration, url)) {
            try {
                relay.close();
            }
            catch { /* best-effort stale candidate cleanup */ }
            return;
        }
        this.relay = relay;
        this.reconnectAttempt = 0;
        relay.on("close", () => this.onRelayClose(relay));
        this.stopAutoListener = this.installAutoListener(relay);
        // Relay is back; bring cross-PC routing back online.
        this.attachBridgeIfReady();
    }
    // ── Pairing / owner channels ──────────────────────────────────────────────
    /** `/remote-pi pair` — show a fresh QR (relay must be up). */
    async pair(ctx, args = "") {
        const cwd = "cwd" in ctx ? ctx.cwd : process.cwd();
        // Auto-bootstrap the relay when down: pair is a focused operation, and
        // forcing a separate start command first was every session's surprise.
        if (this.state === "idle") {
            ctx.ui.notify("[remote-pi] Starting relay before pairing…", "info");
            await this.start(ctx);
        }
        if (this.state === "idle" || !this.relay) {
            ctx.ui.notify("[remote-pi] Pair requires the relay to be connected. Run /remote-pi start relay first.", "warning");
            return;
        }
        const edKp = this.cachedEd25519;
        const sessionName = this.deps.getDisplayName(cwd);
        const ttlMatch = /--ttl\s+(\d+)/.exec(args);
        const ttlMs = ttlMatch ? clampPairTtlMs(Number(ttlMatch[1]) * 1000) : TOKEN_TTL_MS;
        const { token, expiresAt } = qrSession.issueToken(ttlMs);
        const roomId = this.myRoomId ?? roomIdFor(cwd, sessionName);
        const qrUri = buildQRUri(token, edKp.publicKey, sessionName, roomId);
        // The QR + pairing URI go to a CUSTOM ENTRY (appendEntry + entry
        // renderer), NOT a custom message: entries render in the TUI but never
        // enter the LLM context (the old sendMessage path injected the whole QR
        // ASCII block on every turn — issue #105's leftover).
        const pi = this.deps.getPi();
        if (pi) {
            try {
                pi.appendEntry("remote-pi:pair-code", {
                    ascii: renderQRAscii(qrUri),
                    uri: qrUri,
                    expiresAt,
                });
            }
            catch { /* stale pi mid-replacement — the notify below still lands */ }
        }
        ctx.ui.notify(`[remote-pi] QR ready — valid until ${new Date(expiresAt).toLocaleTimeString()}. ` +
            `Scan with the app, or copy the pairing code printed above.`, "info");
        // Returns immediately; the auto-listener pairs on pair_request.
    }
    /** `/remote-pi devices`. */
    async listDevices(ctx) {
        const peers = await listPeers();
        if (peers.length === 0) {
            ctx.ui.notify("[remote-pi] No paired devices.", "info");
            return;
        }
        const lines = peers.flatMap((record) => {
            const inspected = inspectPeerRecord(record);
            if (!inspected)
                return [];
            const tag = inspected.runtimeKey !== null && this.activePeers.has(inspected.runtimeKey)
                ? " 🟢 online"
                : " ⚪ offline";
            return `• ${inspected.rawHandle.slice(0, 8)} — ${inspected.record.name}${tag}`;
        }).join("\n");
        ctx.ui.notify(`[remote-pi] Paired devices:\n${lines}`, "info");
    }
    /** `/remote-pi revoke <shortid>`. */
    async revoke(arg, ctx) {
        const shortid = arg.trim();
        if (!shortid) {
            ctx.ui.notify("[remote-pi] Usage: /remote-pi revoke <shortid>. Run /remote-pi devices to see shortids.", "warning");
            return;
        }
        // Revoke needs the relay so the revoked device gets a `bye` and its live
        // channel is torn down — not just a silent peers.json edit.
        if (this.state === "idle") {
            ctx.ui.notify("[remote-pi] Starting relay before revoking…", "info");
            await this.start(ctx);
        }
        if (this.state === "idle" || !this.relay) {
            ctx.ui.notify("[remote-pi] Revoke requires the relay to be connected. Run /remote-pi start relay first.", "warning");
            return;
        }
        const matches = (await listPeers())
            .map(inspectPeerRecord)
            .filter((peer) => peer !== null)
            .filter((peer) => peer.rawHandle.startsWith(shortid));
        if (matches.length === 0) {
            ctx.ui.notify("[remote-pi] No peer matching that shortid. Run /remote-pi devices to see shortids.", "warning");
            return;
        }
        if (matches.length > 1) {
            const collisions = matches.map((peer) => peer.rawHandle.slice(0, 8)).join(", ");
            ctx.ui.notify(`[remote-pi] Ambiguous shortid — ${matches.length} matches: ${collisions}. Use more chars.`, "warning");
            return;
        }
        const peer = matches[0];
        await removePeer(peer.rawHandle);
        this.refreshPairingsCache();
        // Storage removal uses the exact saved representation; the active channel
        // is indexed by its canonical identity.
        if (peer.runtimeKey !== null && this.activePeers.has(peer.runtimeKey)) {
            const channel = this.activePeers.get(peer.runtimeKey);
            try {
                channel?.send({ type: "bye", reason: "session_replaced" });
            }
            catch { /* best-effort */ }
            this.detachPeerChannel(peer.runtimeKey);
            this.deps.refreshFooter();
        }
        ctx.ui.notify(`[remote-pi] Revoked: ${peer.record.name} (${peer.rawHandle.slice(0, 8)}…)`, "info");
    }
    /** Completion source for `/remote-pi revoke <shortid>`. */
    async shortidCompletions(prefix) {
        const peers = await listPeers().catch(() => []);
        return peers
            .map(inspectPeerRecord)
            .filter((peer) => peer !== null)
            .map((peer) => peer.rawHandle.slice(0, 8))
            .filter((short) => short.startsWith(prefix))
            .map((short) => ({ value: short, label: short }));
    }
    // ── Multi-channel broadcast ───────────────────────────────────────────────
    /** Broadcast to every attached owner. For per-request replies use the
     *  sender channel directly. */
    broadcastToActive(msg) {
        for (const ch of this.activePeers.values()) {
            try {
                ch.send(msg);
            }
            catch { /* best-effort per channel */ }
        }
    }
    attachPeerChannel(appPeerId, channel) {
        this.activePeers.set(appPeerId, channel);
        this.peerShort = appPeerId.slice(0, 8);
    }
    detachPeerChannel(appPeerId) {
        const ch = this.activePeers.get(appPeerId);
        if (!ch)
            return;
        try {
            ch.detach();
        }
        catch { /* best-effort */ }
        this.activePeers.delete(appPeerId);
        if (this.peerShort === appPeerId.slice(0, 8)) {
            const next = this.activePeers.keys().next().value;
            this.peerShort = next ? next.slice(0, 8) : "";
        }
    }
    /** Per-owner disconnect callback (relay said the peer is gone). */
    onPeerDisconnect(appPeerId) {
        if (this.state === "idle")
            return;
        const target = appPeerId ?? [...this.activePeers.keys()].pop();
        if (!target)
            return;
        if (!this.activePeers.has(target))
            return;
        this.detachPeerChannel(target);
        if (this.hasAnyPeer) {
            this.deps.refreshFooter();
            return;
        }
        // No owner left. Conservatively clear the turn so the next pair_request
        // starts cleanly.
        this.currentTurnId = null;
        this.deps.refreshFooter();
        this.deps.notify("[remote-pi] All app peers disconnected, listening for reconnect", "info");
        // Auto-listener stays up — same listener catches the reconnect.
    }
    attachOwner(relay, appPeerId, peerName) {
        const peerShort = appPeerId.slice(0, 8);
        if (this.activePeers.has(appPeerId))
            this.detachPeerChannel(appPeerId);
        const channel = new PlainPeerChannel(relay, appPeerId, this.myRoomId ?? undefined, (msg) => this.routeClientMessageFrom(channel, msg, this.liveCtx() ?? NOOP_CTX), () => this.onPeerDisconnect(appPeerId));
        this.attachPeerChannel(appPeerId, channel);
        this.deps.refreshFooter();
        this.deps.notify(`[remote-pi] Owner attached: peer=${peerShort}, name=${peerName} ` +
            `(${this.activePeers.size} active)`, "info");
        return channel;
    }
    liveCtx() {
        return this.deps.getEventCtx()
            ?? this.deps.getCommandCtx();
    }
    // ── Auto-listener ─────────────────────────────────────────────────────────
    installAutoListener(relay) {
        const listenerGeneration = this.lifecycleGeneration;
        const hasListenerAuthority = () => !this.deps.isDisposed() &&
            this.state === "started" &&
            this.relay === relay &&
            this.lifecycleGeneration === listenerGeneration;
        const onMsg = async (line) => {
            let outer;
            try {
                outer = JSON.parse(line);
            }
            catch {
                return;
            }
            if (!outer.peer || !outer.ct)
                return;
            if (!hasListenerAuthority())
                return;
            if (this.activePeers.has(outer.peer))
                return;
            let inner;
            try {
                const plaintext = Buffer.from(outer.ct, "base64").toString("utf8");
                const parsed = JSON.parse(plaintext);
                if (!parsed ||
                    typeof parsed !== "object" ||
                    typeof parsed.type !== "string")
                    return;
                inner = parsed;
            }
            catch {
                return;
            }
            const appPeerId = outer.peer;
            if (inner.type === "pair_request") {
                await this.handlePairRequest(relay, appPeerId, inner, hasListenerAuthority);
                return;
            }
            // Reconnect path: known peer (peers.json) without an active channel.
            const known = await this.findKnownPeer(appPeerId);
            if (!hasListenerAuthority())
                return;
            if (known) {
                const channel = this.attachOwner(relay, appPeerId, known.name);
                this.routeClientMessageFrom(channel, inner, this.liveCtx() ?? NOOP_CTX);
                return;
            }
            // Unknown peer + non-pair inner — signal so the app can re-scan.
            const errReply = {
                type: "error",
                code: "unknown_peer",
                message: "Peer not paired — re-scan QR",
            };
            const errCt = Buffer.from(JSON.stringify(errReply)).toString("base64");
            relay.send(JSON.stringify({ peer: appPeerId, ct: errCt }));
        };
        relay.on("message", onMsg);
        return () => relay.off("message", onMsg);
    }
    async handlePairRequest(relay, appPeerId, inner, hasListenerAuthority) {
        const sendInner = (msg) => {
            const ct = Buffer.from(JSON.stringify(msg)).toString("base64");
            relay.send(JSON.stringify({ peer: appPeerId, ct }));
        };
        const sendError = (code, message) => {
            sendInner({ type: "pair_error", in_reply_to: inner.id, code, message });
        };
        const status = qrSession.consumeToken(inner.token);
        if (status !== "ok") {
            const code = status === "expired" ? "token_expired"
                : status === "consumed" ? "token_consumed"
                    : "token_unknown";
            const msg = code === "token_expired" ? "Ephemeral token expired. Generate a new QR with /remote-pi pair."
                : code === "token_consumed" ? "Token already consumed by another pair_request."
                    : "Token was not issued by this Pi.";
            sendError(code, msg);
            return;
        }
        // A delayed signed revoke must lose authority before the same-process
        // re-pair enters storage; the replacement owns a fresh token snapshot.
        const producer = this.selfRevoke;
        const producerEpoch = this.selfRevokeEpoch;
        producer?.invalidateStorageAuthority();
        const pairedAt = new Date().toISOString();
        try {
            await addPeer({
                name: inner.device_name,
                remote_epk: appPeerId,
                paired_at: pairedAt,
            });
            if (!hasListenerAuthority())
                return;
            this.refreshPairingsCache();
            if (producer && this.selfRevoke === producer && this.selfRevokeEpoch === producerEpoch) {
                void producer.requestFreshCheck().catch(() => {
                    // The regular cadence retries; pairing itself already succeeded.
                });
            }
        }
        catch (err) {
            if (!hasListenerAuthority())
                return;
            sendError("internal_error", `Failed to persist peer: ${String(err)}`);
            return;
        }
        const commandCtx = this.deps.getCommandCtx();
        const cwd = commandCtx && "cwd" in commandCtx
            ? commandCtx.cwd
            : process.cwd();
        const sessionName = this.deps.getDisplayName(cwd);
        this.attachOwner(relay, appPeerId, inner.device_name);
        sendInner({
            type: "pair_ok",
            in_reply_to: inner.id,
            session_name: sessionName,
            session_started_at: this.sessionStartedAt ?? Date.now(),
            room_id: this.myRoomId ?? roomIdFor(cwd, sessionName),
            harness: this.harness,
            hostname: this.hostname,
        });
    }
    async findKnownPeer(appPeerIdStd) {
        let runtimeKey;
        try {
            runtimeKey = canonicalizeEd25519PublicKey(appPeerIdStd, "Relay Owner key");
        }
        catch {
            return null;
        }
        for (const record of await listPeers()) {
            const inspected = inspectPeerRecord(record);
            if (inspected?.runtimeKey === runtimeKey)
                return inspected.record;
        }
        return null;
    }
    revokeActiveOwnerRuntime(canonicalOwnerPubkey) {
        if (!this.activePeers.has(canonicalOwnerPubkey))
            return;
        this.refreshPairingsCache();
        this.detachPeerChannel(canonicalOwnerPubkey);
        this.deps.refreshFooter();
        reportRevocationByFingerprint(this.deps.getPi(), canonicalOwnerPubkey);
    }
    // ── Client message routing ────────────────────────────────────────────────
    routeClientMessageFrom(sender, msg, ctx) {
        // session_sync has its own internal guards — handle before the strict
        // pi-binding guard so a missing pi doesn't drop the reply.
        if (msg.type === "session_sync") {
            this.handleSessionSync(sender, msg);
            return;
        }
        if (msg.type === "cancel") {
            try {
                const aborted = this.abortCurrentTurn(ctx);
                if (!aborted) {
                    sender.send({
                        type: "error",
                        code: "internal_error",
                        in_reply_to: msg.id,
                        message: "No active Pi context to abort",
                    });
                    return;
                }
                sender.send({ type: "cancelled", in_reply_to: msg.id, target_id: msg.target_id });
            }
            catch (err) {
                sender.send({
                    type: "error",
                    code: "internal_error",
                    in_reply_to: msg.id,
                    message: `Abort failed: ${String(err)}`,
                });
            }
            return;
        }
        const pi = this.deps.getPi();
        if (!pi)
            return;
        switch (msg.type) {
            case "queued_message_set": {
                const text = msg.text.trim();
                if (!text) {
                    this.clearQueuedItems(msg.id);
                    break;
                }
                this.upsertQueuedItem({ id: msg.id, text, editable: true, created_at: Date.now() });
                this.maybeDrainQueuedItem();
                break;
            }
            case "queued_message_clear":
                this.clearQueuedItems(msg.target_id);
                break;
            case "user_message": {
                const requestedSteer = msg.streaming_behavior === "steer";
                const inferredBusySteer = !requestedSteer && this.myRoomMeta?.working === true;
                const shouldSteer = requestedSteer || inferredBusySteer;
                if (msg.images && msg.images.length > 0) {
                    void this.deliverImageUserMessage(sender, msg, shouldSteer).catch((error) => {
                        const detail = error instanceof Error ? error.message : String(error);
                        console.error(`[remote-pi] failed delivering image message id=${msg.id}: ${detail}`);
                    });
                    break;
                }
                const previousTurnId = this.currentTurnId;
                const seededTurnId = !shouldSteer || this.currentTurnId === null;
                if (seededTurnId)
                    this.currentTurnId = msg.id;
                // Always steer-mode for app-originated messages: the SDK ignores
                // deliverAs when idle, but requires it when a turn is running.
                const wake = wakeAgent(pi, msg.text, `app user_message id=${msg.id}`, "steer", this.deps.notify);
                if (!wake.ok) {
                    if (seededTurnId)
                        this.currentTurnId = previousTurnId;
                    sender.send({
                        type: "error",
                        code: "internal_error",
                        in_reply_to: msg.id,
                        message: `Agent rejected incoming message: ${wake.detail}`,
                    });
                    break;
                }
                if (shouldSteer)
                    this.trackPendingSteer(msg.id, msg.text);
                this.echoUserMessage(msg, shouldSteer);
                break;
            }
            case "approve_tool":
                // Approval gate removed; type kept for forward-compat. Ignore.
                break;
            case "ping":
                sender.send({ type: "pong", in_reply_to: msg.id });
                break;
            case "pair_request":
                // Already paired — idempotent ignore.
                break;
            case "session_compact":
                handleSessionCompact((this.deps.getEventCtx() ?? this.deps.getCommandCtx()), sender, msg);
                break;
            case "session_new": {
                const actionCtx = this.deps.getCommandCtx();
                const setCommandCtx = this.deps.setCommandCtx;
                void handleSessionNew(actionCtx, sender, msg, (freshCtx) => setCommandCtx(freshCtx))
                    .then((created) => {
                    // Only reset the pi-side mirror when a fresh session was actually
                    // created — a cancelled/errored new-session must NOT wipe history.
                    if (created)
                        this.resetSessionForNew(msg.id);
                });
                break;
            }
            case "model_set": {
                const actCtx = (this.deps.getEventCtx() ?? this.deps.getCommandCtx());
                observeModelRegistry(actCtx?.modelRegistry);
                let reg;
                try {
                    reg = ensureModelRegistry();
                }
                catch (err) {
                    sender.send({ type: "error", in_reply_to: msg.id, code: "internal_error", message: String(err instanceof Error ? err.message : err) });
                    break;
                }
                void handleModelSet(pi, actCtx, reg, sender, msg, persistModelDefault);
                break;
            }
            case "thinking_set":
                handleThinkingSet(pi, sender, msg);
                break;
            case "list_models": {
                const actCtx = (this.deps.getEventCtx() ?? this.deps.getCommandCtx());
                observeModelRegistry(actCtx?.modelRegistry);
                let reg;
                try {
                    reg = ensureModelRegistry();
                }
                catch (err) {
                    sender.send({ type: "error", in_reply_to: msg.id, code: "internal_error", message: String(err instanceof Error ? err.message : err) });
                    break;
                }
                handleListModels(actCtx, reg, sender, msg);
                break;
            }
        }
    }
    abortCurrentTurn(fallbackCtx) {
        const candidates = [
            this.deps.getEventCtx(),
            this.deps.getCommandCtx(),
            fallbackCtx,
        ];
        for (const candidate of candidates) {
            if (!candidate || candidate === NOOP_CTX)
                continue;
            if (typeof candidate.abort !== "function")
                continue;
            try {
                candidate.abort();
                return true;
            }
            catch (err) {
                // Only skip SDK stale-ctx throws and try the next candidate.
                const msg = err instanceof Error ? err.message : String(err);
                if (/stale|session replacement or reload/i.test(msg))
                    continue;
                throw err;
            }
        }
        return false;
    }
    // ── session_sync ──────────────────────────────────────────────────────────
    handleSessionSync(sender, msg) {
        this.sendQueuedState(sender);
        if (this.sessionStartedAt === null) {
            sender.send({
                type: "session_history",
                in_reply_to: msg.id,
                session_started_at: 0,
                events: [],
                eos: true,
                truncated: false,
            });
            return;
        }
        // Mirror semantics: always return the last N events; the app SUBSTITUTES
        // its local cache — no delta/since_ts logic.
        const serverLimit = getSyncLimit();
        const requested = msg.limit ?? serverLimit;
        const effectiveLimit = Math.min(requested, serverLimit);
        const allEvents = mapAgentMessagesToEvents(this.messageBuffer);
        const slice = effectiveLimit > 0 ? allEvents.slice(-effectiveLimit) : [];
        const truncated = allEvents.length > effectiveLimit;
        sender.send({
            type: "session_history",
            in_reply_to: msg.id,
            session_started_at: this.sessionStartedAt,
            events: slice,
            eos: true,
            truncated,
        });
    }
    /** Reset the pi-side mirror after a successful session_new; broadcast the
     *  EMPTY history so every owner drops the stale conversation. */
    resetSessionForNew(inReplyTo) {
        this.messageBuffer = [];
        this.pendingSteers = [];
        this.lastConsumedSteerText = null;
        this.resetQueuedItems({ broadcast: true });
        this.sessionStartedAt = Date.now();
        this.broadcastToActive({
            type: "session_history",
            in_reply_to: inReplyTo,
            session_started_at: this.sessionStartedAt,
            events: [],
            eos: true,
            truncated: false,
        });
    }
    // ── Queued messages (app-side queued editing) ─────────────────────────────
    queuedStateMessage() {
        const first = this.queuedItems[0];
        return {
            type: "queued_message_state",
            ...(first ? { id: first.id, text: first.text } : {}),
            items: this.queuedItems.map((item) => ({ ...item })),
        };
    }
    sendQueuedState(sender) {
        sender.send(this.queuedStateMessage());
    }
    broadcastQueuedState() {
        this.broadcastToActive(this.queuedStateMessage());
    }
    resetQueuedItems({ broadcast = false } = {}) {
        this.queuedItems = [];
        if (broadcast)
            this.broadcastQueuedState();
    }
    upsertQueuedItem(item) {
        const index = this.queuedItems.findIndex((existing) => existing.id === item.id);
        if (index === -1) {
            this.queuedItems = [...this.queuedItems, item];
        }
        else {
            this.queuedItems = [
                ...this.queuedItems.slice(0, index),
                item,
                ...this.queuedItems.slice(index + 1),
            ];
        }
        this.broadcastQueuedState();
    }
    clearQueuedItems(targetId) {
        this.queuedItems = targetId
            ? this.queuedItems.filter((item) => item.id !== targetId)
            : [];
        this.broadcastQueuedState();
    }
    isBusyForQueueDrain() {
        return this.currentTurnId !== null || this.myRoomMeta?.working === true;
    }
    /** Called on agent_end / turn_end — delivers the next queued app message. */
    maybeDrainQueuedItem() {
        if (this.isBusyForQueueDrain())
            return;
        const item = this.queuedItems.shift();
        if (!item)
            return;
        this.broadcastQueuedState();
        const previousTurnId = this.currentTurnId;
        this.currentTurnId = item.id;
        const msg = { type: "user_message", id: item.id, text: item.text };
        const wake = wakeAgent(this.deps.getPi(), item.text, `queued app user_message id=${item.id}`, "steer", this.deps.notify);
        if (!wake.ok) {
            this.currentTurnId = previousTurnId;
            this.queuedItems = [item, ...this.queuedItems];
            this.broadcastQueuedState();
            this.broadcastToActive({
                type: "error",
                code: "internal_error",
                in_reply_to: item.id,
                message: `Agent rejected queued message: ${wake.detail}`,
            });
            return;
        }
        this.echoUserMessage(msg, false);
    }
    // ── Steer tracking ────────────────────────────────────────────────────────
    trackPendingSteer(id, text) {
        const key = normalizeSteerText(text);
        if (!key)
            return;
        this.pendingSteers.push({ id, text: key });
    }
    consumePendingSteerForStartedUser(text) {
        if (this.pendingSteers.length === 0)
            return null;
        const key = normalizeSteerText(text);
        const index = key ? this.pendingSteers.findIndex((item) => item.text === key) : -1;
        const [item] = this.pendingSteers.splice(index >= 0 ? index : 0, 1);
        return item?.id ?? null;
    }
    broadcastConsumedSteerForUserContent(content) {
        const text = stringifyContent(content);
        if (this.lastConsumedSteerText === text) {
            this.lastConsumedSteerText = null;
            return;
        }
        const id = this.consumePendingSteerForStartedUser(text);
        if (!id)
            return;
        this.lastConsumedSteerText = text;
        this.broadcastToActive({ type: "steer_consumed", id });
    }
    // ── Image delivery ────────────────────────────────────────────────────────
    echoUserMessage(msg, forceSteer = false) {
        this.broadcastToActive({
            type: "user_message",
            id: msg.id,
            text: msg.text,
            ...(msg.images && msg.images.length > 0 ? { images: msg.images } : {}),
            ...(forceSteer || msg.streaming_behavior === "steer"
                ? { streaming_behavior: "steer" }
                : {}),
        });
    }
    shouldDeferReceivedImagePreview() {
        return this.currentTurnId !== null || this.myRoomMeta?.working === true;
    }
    sendReceivedImagePreviewNow(details) {
        const pi = this.deps.getPi();
        if (!pi)
            return;
        try {
            pi.sendMessage({
                customType: REMOTE_PI_RECEIVED_IMAGE_TYPE,
                content: "",
                display: true,
                details,
            });
        }
        catch {
            // TUI preview is best-effort; skip on failure.
        }
    }
    flushPendingReceivedImagePreviews() {
        if (this.pendingReceivedImagePreviews.length === 0)
            return;
        const pending = this.pendingReceivedImagePreviews.splice(0);
        for (const details of pending)
            this.sendReceivedImagePreviewNow(details);
    }
    async emitReceivedImagePreviews(msg, delivery = "immediate") {
        const previews = await collectReceivedImagePreviews(msg);
        for (const preview of previews) {
            if (delivery === "defer" || this.shouldDeferReceivedImagePreview()) {
                this.pendingReceivedImagePreviews.push(preview);
            }
            else {
                this.sendReceivedImagePreviewNow(preview);
            }
        }
    }
    async deliverImageUserMessage(sender, msg, shouldSteer) {
        const previewDelivery = shouldSteer || this.currentTurnId !== null || this.myRoomMeta?.working === true
            ? "defer"
            : "immediate";
        const emitPreview = async () => {
            try {
                await this.emitReceivedImagePreviews(msg, previewDelivery);
            }
            catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                console.error(`[remote-pi] failed emitting image preview id=${msg.id}: ${detail}`);
            }
        };
        if (previewDelivery === "immediate") {
            await emitPreview();
        }
        else {
            void emitPreview().finally(() => {
                if (!this.shouldDeferReceivedImagePreview())
                    this.flushPendingReceivedImagePreviews();
            });
        }
        const previousTurnId = this.currentTurnId;
        const seededTurnId = !shouldSteer || this.currentTurnId === null;
        if (seededTurnId)
            this.currentTurnId = msg.id;
        const wake = wakeAgent(this.deps.getPi(), contentFromUserMessage(msg), `app user_message id=${msg.id} (+${msg.images?.length ?? 0} image)`, "steer", this.deps.notify);
        if (!wake.ok) {
            if (seededTurnId)
                this.currentTurnId = previousTurnId;
            sender.send({
                type: "error",
                code: "internal_error",
                in_reply_to: msg.id,
                message: `Agent rejected incoming message: ${wake.detail}`,
            });
            return;
        }
        if (shouldSteer)
            this.trackPendingSteer(msg.id, msg.text);
        this.echoUserMessage(msg, shouldSteer);
    }
    // ── Pi event hooks (called by the shell) ──────────────────────────────────
    /** Mirror terminal/RPC input to every connected owner. Returns true when
     *  the event was mirrored (caller continues regardless). */
    onUserInput(event) {
        if (!this.hasAnyPeer)
            return;
        if (event.source === "extension")
            return;
        const turnId = `local_${randomUUID()}`;
        this.currentTurnId = turnId;
        this.broadcastToActive({ type: "user_input", id: turnId, text: event.text });
    }
    onModelSelect(modelName) {
        this.currentModel = modelName;
        if (this.myRoomMeta)
            this.myRoomMeta = { ...this.myRoomMeta, model: modelName };
        if (this.relay && this.myRoomId) {
            this.relay.sendControl({ type: "room_meta_update", room_id: this.myRoomId, meta: { model: modelName } });
        }
    }
    onThinkingSelect(level) {
        this.currentThinking = level;
        if (this.myRoomMeta)
            this.myRoomMeta = { ...this.myRoomMeta, thinking: level };
        if (this.relay && this.myRoomId) {
            this.relay.sendControl({ type: "room_meta_update", room_id: this.myRoomId, meta: { thinking: level } });
        }
    }
    /** Late model hydration on the first turn (lazy SDK model resolution). */
    onTurnStart(ctx) {
        if (!this.currentModel) {
            try {
                const m = ctx.getModel?.();
                const name = m?.name ?? m?.id;
                if (name)
                    this.onModelSelect(name);
            }
            catch { /* defensive — never block a turn on a model lookup */ }
        }
        this.publishWorking(true);
    }
    onTurnEnd() {
        this.publishWorking(false);
        this.maybeDrainQueuedItem();
    }
    publishWorking(working) {
        if (this.myRoomMeta)
            this.myRoomMeta = { ...this.myRoomMeta, working };
        if (this.relay && this.myRoomId) {
            this.relay.sendControl({ type: "room_meta_update", room_id: this.myRoomId, meta: { working } });
        }
    }
    onMessageStart(event) {
        const message = event?.message;
        if (!this.hasAnyPeer || message?.role !== "user")
            return;
        this.broadcastConsumedSteerForUserContent(message.content);
    }
    onMessageUpdate(event) {
        if (!this.hasAnyPeer || !this.currentTurnId)
            return;
        const ae = event.assistantMessageEvent;
        if (ae.type === "text_delta" && ae.delta !== undefined) {
            this.broadcastToActive({ type: "agent_chunk", in_reply_to: this.currentTurnId, delta: ae.delta });
        }
    }
    onToolExecutionStart(event) {
        if (!this.hasAnyPeer)
            return;
        this.broadcastToActive({
            type: "tool_request",
            tool_call_id: event.toolCallId,
            tool: event.toolName,
            args: enrichToolArgs(event.toolName, event.args, this.deps.getCwd()),
        });
    }
    onToolExecutionEnd(event) {
        if (!this.hasAnyPeer)
            return;
        const text = stringifyToolResult(event.result);
        const msg = event.isError
            ? { type: "tool_result", tool_call_id: event.toolCallId, error: text }
            : { type: "tool_result", tool_call_id: event.toolCallId, result: text };
        this.broadcastToActive(msg);
    }
    /** message_end: buffer the message for session_sync + forward errors. */
    onMessageEnd(event) {
        const m = event?.message;
        if (!m)
            return;
        if (m.role === "user" && this.hasAnyPeer) {
            this.broadcastConsumedSteerForUserContent(m.content);
        }
        if (m.role === "user" || m.role === "assistant" || m.role === "toolResult") {
            this.messageBuffer.push(m);
        }
        // Forward a failed turn to connected owners — without this the app hangs
        // with no response when the provider errors.
        if (m.role === "assistant" && m.stopReason === "error" && this.hasAnyPeer) {
            const message = typeof m.errorMessage === "string" && m.errorMessage
                ? m.errorMessage
                : "Provider error";
            const errMsg = this.currentTurnId
                ? { type: "error", in_reply_to: this.currentTurnId, code: "provider_error", message }
                : { type: "error", code: "provider_error", message };
            this.broadcastToActive(errMsg);
        }
    }
    onAgentEnd() {
        if (this.hasAnyPeer && this.currentTurnId) {
            this.broadcastToActive({ type: "agent_done", in_reply_to: this.currentTurnId });
            this.currentTurnId = null;
        }
        this.flushPendingReceivedImagePreviews();
        this.lastConsumedSteerText = null;
        this.maybeDrainQueuedItem();
    }
    /** session_before_compact / session_compact bracket compaction with
     *  working=true/false (compact() doesn't run a turn). */
    onBeforeCompact() {
        this.publishWorking(true);
    }
    onCompact(event) {
        const entry = event?.compactionEntry;
        const summary = typeof entry?.summary === "string" ? entry.summary : "";
        const tokensBefore = typeof entry?.tokensBefore === "number" ? entry.tokensBefore : 0;
        const ts = Date.now();
        this.messageBuffer.push({ role: "compaction", content: summary, timestamp: ts, tokensBefore });
        this.broadcastToActive({ type: "compaction", summary, tokens_before: tokensBefore, ts });
        this.publishWorking(false);
        this.maybeDrainQueuedItem();
    }
    // ── Status ────────────────────────────────────────────────────────────────
    statusLine() {
        const relayUrl = this.relayUrl ?? resolveRelayUrl().url;
        if (this.state === "idle") {
            return `⚪ Relay: off (${relayUrl}) — run /remote-pi start relay`;
        }
        if (this.activePeers.size > 0) {
            const count = this.activePeers.size;
            const shortids = [...this.activePeers.keys()].map((peerId) => peerId.slice(0, 8)).join(", ");
            return `🟢 Relay: ${count} owner${count === 1 ? "" : "s"} online (${shortids}) (${relayUrl})`;
        }
        return this.hasGlobalPairings
            ? `🟢 Relay: on, waiting for an app to connect (${relayUrl})`
            : `🟡 Relay: on, waiting for first pairing (${relayUrl})`;
    }
}
function rawOwnerFingerprint(rawValue) {
    let fingerprintInput;
    if (typeof rawValue === "string") {
        fingerprintInput = rawValue;
    }
    else {
        try {
            const serialized = JSON.stringify(rawValue);
            const type = rawValue === null ? "null" : typeof rawValue;
            fingerprintInput = `${type}:${serialized ?? ""}`;
        }
        catch {
            fingerprintInput = `${typeof rawValue}:unserializable`;
        }
    }
    return createHash("sha256")
        .update(fingerprintInput, "utf8")
        .digest("hex")
        .slice(0, 8);
}
function runtimeOwnerFingerprint(runtimeKey) {
    try {
        return publicKeyFingerprint(decodeEd25519PublicKey(runtimeKey, "Owner runtime key"));
    }
    catch {
        // Relay authentication guarantees canonical keys in production. This
        // fallback keeps diagnostics metadata-only at defensive/test boundaries.
        return rawOwnerFingerprint(runtimeKey);
    }
}
function inspectPeerRecord(record) {
    if (!record || typeof record !== "object") {
        const fingerprint = rawOwnerFingerprint(record);
        console.warn(`[remote-pi] event=invalid_owner_record owner_fp=${fingerprint}`);
        return null;
    }
    const candidate = record;
    const rawHandle = candidate.remote_epk;
    if (typeof rawHandle !== "string") {
        const fingerprint = rawOwnerFingerprint(rawHandle);
        console.warn(`[remote-pi] event=invalid_owner_record owner_fp=${fingerprint}`);
        return null;
    }
    const safeRecord = {
        name: typeof candidate.name === "string" ? candidate.name : "Unknown Owner",
        remote_epk: rawHandle,
        paired_at: typeof candidate.paired_at === "string" ? candidate.paired_at : "",
    };
    try {
        const runtimeKey = canonicalizeEd25519PublicKey(rawHandle, "stored Owner public key");
        return { record: safeRecord, rawHandle, runtimeKey };
    }
    catch {
        const fingerprint = rawOwnerFingerprint(rawHandle);
        console.warn(`[remote-pi] event=invalid_owner_record owner_fp=${fingerprint}`);
        return { record: safeRecord, rawHandle, runtimeKey: null };
    }
}
/**
 * Security notice when an owner revokes this PC from the mesh. Delivered as a
 * CUSTOM ENTRY (not a custom message): visible in the TUI transcript, never
 * injected into the LLM context.
 */
function reportRevocationByFingerprint(pi, canonicalOwnerPubkey) {
    if (!pi)
        return;
    const fingerprint = runtimeOwnerFingerprint(canonicalOwnerPubkey);
    try {
        pi.appendEntry("remote-pi:mesh-revoked", {
            text: `🔒 Revoked by Owner ${fingerprint}…\n\n` +
                `The mobile app for this Owner removed this PC from the mesh. ` +
                `Re-pair via /remote-pi pair if this was unexpected.`,
        });
    }
    catch { /* stale pi mid-replacement — the runtime detach already happened */ }
}
function normalizeSteerText(text) {
    return text.trim();
}
function getSyncLimit() {
    const raw = process.env["REMOTE_PI_SYNC_LIMIT"];
    const parsed = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : SYNC_LIMIT_DEFAULT;
}
/**
 * Persist a model change to the PROJECT settings (`<cwd>/.pi/settings.json`)
 * so a model picked from the app survives a restart. Project scope, NOT
 * global, deliberately: the SDK merges global←project with PROJECT winning.
 * Read-merge-write + best-effort: preserves other keys and never throws.
 */
function persistModelDefault(provider, modelId) {
    try {
        const path = join(process.cwd(), ".pi", "settings.json");
        let obj = {};
        try {
            const parsed = JSON.parse(readFileSync(path, "utf8"));
            if (parsed && typeof parsed === "object")
                obj = parsed;
        }
        catch { /* no existing/parseable file → start fresh */ }
        obj["defaultProvider"] = provider;
        obj["defaultModel"] = modelId;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(obj, null, 2));
    }
    catch { /* best-effort — model change already applied live */ }
}
//# sourceMappingURL=relay_service.js.map
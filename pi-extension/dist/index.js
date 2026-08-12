#!/usr/bin/env node
/**
 * remote-pi (lean) — relay (phone remote control) + local UDS agent mesh.
 *
 * Both features are OFF by default. Enable via CLI flags:
 *
 *   pi --relay          auto-start the relay (phone app channel)
 *   pi --mesh           auto-join the local agent mesh (agent_send/list_peers)
 *   pi --relay --mesh   both
 *
 * or at runtime: /remote-pi start [relay|mesh|all], /remote-pi stop, …
 *
 * Architecture: the factory creates ONE RelayService + ONE MeshService per
 * session wiring; all state lives on those instances (no module-level mutable
 * singletons). session_shutdown disposes them, so a replacement session starts
 * from a clean slate.
 *
 * Prompt-injection hygiene: the ONLY custom message this extension injects
 * into the LLM context is `remote-pi:mesh-message` (that IS the mesh). Pure
 * UI artifacts (pair QR, revoke notice) use appendEntry + entry renderers,
 * which never enter the context. Received-image previews are custom messages
 * but stripped by the `context` / `session_before_compact` hooks.
 */
import { Container, Text } from "@earendil-works/pi-tui";
import { isPrintMode, resolveFeatureFlags } from "./flags.js";
import { RelayService } from "./relay/relay_service.js";
import { MeshService } from "./mesh/mesh_service.js";
import { registerAgentTools } from "./mesh/tools.js";
import { deployAgentNetworkSkill, undeployAgentNetworkSkill } from "./mesh/skill.js";
import { ensureGlobalDirs, LOCAL_SESSION_NAME } from "./mesh/paths.js";
import { defaultAgentName, sanitizeSegment } from "./mesh/names.js";
import { registerReceivedImageRenderer, filterReceivedImageMessagesFromContext } from "./relay/images.js";
import { updateFooter } from "./ui/footer.js";
// A single Pi process can load this extension TWICE in the SAME session
// (explicit `-e <path>` plus auto-discovery from a pi-package). Both loads
// receive the same session-scoped `pi` and would re-run registerTool/
// registerCommand for identical names — a hard duplicate-registration
// conflict. Idempotent, first-load-wins via a process-global WeakSet keyed
// by `pi` (lives on globalThis under a Symbol.for key so both module
// instances resolve the SAME set).
const _APPLIED_REGISTRY_KEY = Symbol.for("remote-pi.extension.appliedRegistry");
function _appliedRegistry() {
    const g = globalThis;
    return (g[_APPLIED_REGISTRY_KEY] ??= new WeakSet());
}
const extension = (pi) => {
    const applied = _appliedRegistry();
    if (applied.has(pi))
        return; // this session's pi was already wired
    applied.add(pi);
    // ── Shell state (fresh per wiring) ────────────────────────────────────────
    let lastCtx = null;
    let lastEventCtx = null;
    let disposed = false;
    let autoInited = false;
    const flags = resolveFeatureFlags((name) => {
        try {
            return pi.getFlag(name);
        }
        catch {
            return undefined;
        }
    });
    // Register the CLI flags so the Pi CLI accepts them (an unregistered flag
    // aborts with "Unknown option") and surfaces values via pi.getFlag. Both
    // default OFF — a bare `pi` boot leaves this extension fully inert.
    pi.registerFlag("relay", {
        type: "boolean",
        description: "remote-pi: auto-start the relay (phone app channel)",
    });
    pi.registerFlag("mesh", {
        type: "boolean",
        description: "remote-pi: auto-join the local agent mesh (agent_send/list_peers)",
    });
    // ── UI helpers ────────────────────────────────────────────────────────────
    /** Prefer the always-fresh session_start ctx over the capturable-stale
     *  command ctx (issue #55). */
    function liveCtx() {
        return lastEventCtx ?? lastCtx;
    }
    function safeNotify(message, level = "info") {
        try {
            const ui = liveCtx()?.ui;
            ui?.notify?.(message, level);
        }
        catch { /* stale ctx — never let notify take down the process */ }
    }
    function refreshFooter() {
        let ui;
        try {
            ui = liveCtx()?.ui ?? null;
        }
        catch {
            return;
        }
        if (!ui || typeof ui.setStatus !== "function" || typeof ui.setTitle !== "function")
            return;
        try {
            const state = {
                session: mesh.isJoined ? LOCAL_SESSION_NAME : undefined,
                peerCount: mesh.currentPeerCount,
                relayOn: relay.isStarted,
                devicePaired: relay.hasAnyPeer ? relay.connectedPeerShort : undefined,
                hasPairings: relay.pairedBefore,
                agentName: mesh.currentNode?.name(),
            };
            updateFooter({ ui: { setStatus: ui.setStatus.bind(ui), setTitle: ui.setTitle.bind(ui) } }, state);
        }
        catch { /* runner went stale mid-call */ }
    }
    function displayName(cwd) {
        return mesh.currentNode?.name()
            ?? sanitizeSegment(safeGetSessionName())
            ?? defaultAgentName(cwd);
    }
    function safeGetSessionName() {
        try {
            return pi.getSessionName();
        }
        catch {
            return undefined;
        }
    }
    // ── Services ──────────────────────────────────────────────────────────────
    const relay = new RelayService({
        getPi: () => pi,
        getMeshNode: () => mesh.currentNode,
        getDisplayName: displayName,
        getCommandCtx: () => lastCtx,
        getEventCtx: () => lastEventCtx,
        setCommandCtx: (ctx) => { lastCtx = ctx; },
        getCwd: () => lastEventCtx?.cwd ?? lastCtx?.cwd ?? process.cwd(),
        notify: safeNotify,
        refreshFooter,
        isDisposed: () => disposed,
    });
    const mesh = new MeshService({
        getPi: () => pi,
        getSessionName: safeGetSessionName,
        broadcastToApp: (msg) => relay.broadcastToActive(msg),
        notify: safeNotify,
        refreshFooter,
        isDisposed: () => disposed,
        onMeshReady: () => relay.attachBridgeIfReady(),
    });
    // ── Skill + tools visibility follows mesh enablement ──────────────────────
    let toolsRegistered = false;
    function enableMeshSurface() {
        deployAgentNetworkSkill();
        if (!toolsRegistered) {
            toolsRegistered = true;
            registerAgentTools(pi, () => mesh.currentNode?.peer() ?? null);
        }
    }
    try {
        ensureGlobalDirs();
        if (flags.mesh)
            enableMeshSurface();
        else
            undeployAgentNetworkSkill();
    }
    catch { /* best-effort init */ }
    // ── Entry/message renderers (never enter the LLM context) ─────────────────
    registerReceivedImageRenderer(pi);
    // Pair QR: custom ENTRY renderer — TUI-visible, context-invisible.
    pi.registerEntryRenderer("remote-pi:pair-code", (entry, _options, theme) => {
        const data = entry.data;
        if (!data)
            return undefined;
        const expiry = new Date(data.expiresAt).toLocaleTimeString();
        const container = new Container();
        container.addChild(new Text(theme.fg("customMessageLabel", "📱 Scan to pair:")));
        container.addChild(new Text(data.ascii));
        container.addChild(new Text(theme.fg("customMessageText", `📋 Pairing code (camera-less devices):\n\n${data.uri}`)));
        container.addChild(new Text(theme.fg("muted", `Valid until ${expiry}`)));
        return container;
    });
    pi.registerEntryRenderer("remote-pi:mesh-revoked", (entry, _options, theme) => {
        const text = entry.data?.text;
        if (!text)
            return undefined;
        return new Text(theme.fg("warning", text));
    });
    // Received-image preview entries are for local TUI display only — strip
    // before every provider request; the actual image reaches the model via
    // the paired sendUserMessage call.
    pi.on("context", (event) => ({
        messages: filterReceivedImageMessagesFromContext(event.messages),
    }));
    // ── Pi event wiring → services ────────────────────────────────────────────
    // Mirror terminal/RPC input to every connected owner.
    pi.on("input", (event) => {
        relay.onUserInput(event);
        return undefined;
    });
    pi.on("model_select", (event) => {
        const m = event?.model;
        const modelName = m?.name ?? m?.id;
        if (modelName)
            relay.onModelSelect(modelName);
    });
    pi.on("thinking_level_select", (event) => {
        const level = event?.level;
        if (level)
            relay.onThinkingSelect(level);
    });
    pi.on("agent_start", () => mesh.onAgentStart());
    pi.on("message_start", (event) => relay.onMessageStart(event));
    pi.on("message_update", (event) => {
        relay.onMessageUpdate(event);
    });
    pi.on("tool_execution_start", (event) => {
        relay.onToolExecutionStart(event);
    });
    pi.on("tool_execution_end", (event) => {
        relay.onToolExecutionEnd(event);
    });
    pi.on("message_end", (event) => relay.onMessageEnd(event));
    pi.on("agent_end", () => {
        relay.onAgentEnd();
        mesh.onAgentEnd();
    });
    pi.on("turn_start", (_event, ctx) => relay.onTurnStart(ctx));
    pi.on("turn_end", () => relay.onTurnEnd());
    pi.on("session_before_compact", (event) => {
        if (event.preparation) {
            event.preparation.messagesToSummarize = filterReceivedImageMessagesFromContext(event.preparation.messagesToSummarize);
            event.preparation.turnPrefixMessages = filterReceivedImageMessagesFromContext(event.preparation.turnPrefixMessages);
        }
        relay.onBeforeCompact();
    });
    pi.on("session_compact", (event) => relay.onCompact(event));
    // Follow pi session renames on the mesh (and cycle the relay room — the
    // room id derives from (cwd, name)). A `#N` collision suffix stays a pure
    // runtime resolution: never written back to the session name.
    pi.on("session_info_changed", (event, ctx) => {
        const newName = event.name ?? undefined;
        const cwd = "cwd" in ctx ? ctx.cwd : process.cwd();
        const requested = sanitizeSegment(newName) ?? defaultAgentName(cwd);
        void (async () => {
            const wasStarted = relay.isStarted;
            if (wasStarted)
                relay.stop("peer_stop");
            if (mesh.isJoined)
                await mesh.rename(requested, cwd);
            if (wasStarted && !disposed)
                await relay.start(ctx);
        })();
    });
    // ── Session lifecycle ─────────────────────────────────────────────────────
    pi.on("session_start", (_event, ctx) => {
        lastEventCtx = ctx;
        // Auto-start on a fresh boot per the CLI flags. session_start fires
        // strictly AFTER the SDK's bindCore (pi.sendMessage is real here).
        // Guarded by autoInited so session replacements don't re-run.
        if (autoInited)
            return;
        autoInited = true;
        if (isPrintMode())
            return; // issue #44: never auto-start under -p/--print
        if (!("cwd" in ctx))
            return; // minimal ctx (tests) — nothing to key on
        if (flags.mesh) {
            enableMeshSurface();
            void mesh.join(ctx);
        }
        if (flags.relay)
            void relay.start(ctx);
    });
    pi.on("session_shutdown", async () => {
        disposed = true;
        lastCtx = null;
        lastEventCtx = null;
        relay.dispose();
        await mesh.dispose();
    });
    // ── Commands ──────────────────────────────────────────────────────────────
    //
    // Lean surface: start [relay|mesh|all] / stop / status / pair / devices /
    // revoke. Everything else (setup wizard, rename, set-relay, daemon fleet,
    // cron, install) was removed in the lean rewrite.
    async function cmdStart(ctx, mode) {
        const wantMesh = mode === "mesh" || mode === "all" || (mode === undefined && flags.mesh);
        const wantRelay = mode === "relay" || mode === "all" || (mode === undefined && flags.relay);
        if (!wantMesh && !wantRelay) {
            ctx.ui.notify("[remote-pi] Nothing selected. Pass --relay/--mesh at launch, or use /remote-pi start relay|mesh|all.", "info");
            return;
        }
        if (wantMesh) {
            enableMeshSurface();
            await mesh.join(ctx);
        }
        if (wantRelay && !disposed)
            await relay.start(ctx);
        cmdStatus(ctx);
    }
    async function cmdStop(ctx) {
        const meshUp = mesh.isJoined;
        const relayUp = relay.isStarted;
        if (!meshUp && !relayUp) {
            ctx.ui.notify("[remote-pi] Already stopped — nothing to do.", "info");
            return;
        }
        if (relayUp)
            relay.stop("peer_stop");
        await mesh.leave();
        ctx.ui.notify("[remote-pi] Stopped (mesh + relay disconnected).", "info");
        refreshFooter();
    }
    function cmdStatus(ctx) {
        ctx.ui.notify(`[remote-pi]\n  ${mesh.statusLine()}\n  ${relay.statusLine()}`, "info");
    }
    pi.registerCommand("remote-pi", {
        description: "remote-pi: start [relay|mesh|all] · stop · status · pair · devices · revoke",
        getArgumentCompletions: async (prefix) => {
            if (prefix.startsWith("revoke ") || prefix === "revoke") {
                const shortPrefix = prefix === "revoke" ? "" : prefix.slice("revoke ".length);
                const completions = await relay.shortidCompletions(shortPrefix);
                return completions.map((c) => ({ value: `revoke ${c.value}`, label: c.label }));
            }
            return ["start", "start relay", "start mesh", "start all", "stop", "status", "pair", "devices", "revoke"]
                .filter((o) => o.startsWith(prefix))
                .map((o) => ({ value: o, label: o }));
        },
        handler: async (args, ctx) => {
            lastCtx = ctx;
            const sub = args.trim();
            if (sub === "" || sub === "start") {
                await cmdStart(ctx);
            }
            else if (sub === "start relay") {
                await cmdStart(ctx, "relay");
            }
            else if (sub === "start mesh") {
                await cmdStart(ctx, "mesh");
            }
            else if (sub === "start all") {
                await cmdStart(ctx, "all");
            }
            else if (sub === "stop") {
                await cmdStop(ctx);
            }
            else if (sub === "status") {
                cmdStatus(ctx);
            }
            else if (sub === "pair" || sub.startsWith("pair ")) {
                await relay.pair(ctx, sub.slice("pair".length).trim());
            }
            else if (sub === "devices") {
                await relay.listDevices(ctx);
            }
            else if (sub.startsWith("revoke")) {
                await relay.revoke(sub.slice("revoke".length).trim(), ctx);
            }
            else {
                await cmdStart(ctx);
            }
        },
    });
    pi.registerCommand("remote-pi start", { description: "Start per flags, or force: start relay|mesh|all", handler: async (args, ctx) => { lastCtx = ctx; const m = args.trim(); await cmdStart(ctx, m === "relay" || m === "mesh" || m === "all" ? m : undefined); } });
    pi.registerCommand("remote-pi stop", { description: "Stop everything (leave local mesh + disconnect relay)", handler: async (_, ctx) => { lastCtx = ctx; await cmdStop(ctx); } });
    pi.registerCommand("remote-pi status", { description: "Show local mesh + relay status", handler: async (_, ctx) => { lastCtx = ctx; cmdStatus(ctx); } });
    pi.registerCommand("remote-pi pair", { description: "Show a QR code to pair a new mobile device (optional: --ttl <seconds>)", handler: async (args, ctx) => { lastCtx = ctx; await relay.pair(ctx, args.trim()); } });
    pi.registerCommand("remote-pi devices", { description: "List paired mobile devices", handler: async (_, ctx) => { lastCtx = ctx; await relay.listDevices(ctx); } });
    pi.registerCommand("remote-pi revoke", {
        description: "Revoke a paired device by its shortid",
        getArgumentCompletions: async (prefix) => relay.shortidCompletions(prefix),
        handler: async (args, ctx) => { lastCtx = ctx; await relay.revoke(args.trim(), ctx); },
    });
    // Seed the pairings cache so the footer relay slot is accurate the
    // moment the relay is up (no race with the first refresh).
    relay.refreshPairingsCache();
};
export default extension;
//# sourceMappingURL=index.js.map
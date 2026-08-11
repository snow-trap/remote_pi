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
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
declare const extension: ExtensionFactory;
export default extension;

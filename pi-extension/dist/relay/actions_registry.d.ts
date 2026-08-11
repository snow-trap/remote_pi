/**
 * ModelRegistry access for the action handlers.
 *
 * SDK ≥0.84 exposes the LIVE session registry directly on every
 * ExtensionContext (`ctx.modelRegistry`) — the same instance the agent
 * session uses, including providers registered dynamically via
 * `pi.registerProvider(...)`. The pre-0.84 fallback (a parallel disk-backed
 * `ModelRegistry.create(AuthStorage.create())`) is gone: those factories are
 * no longer exported.
 *
 * This module caches the most recently observed live registry so call sites
 * that only hold a narrow ctx Pick can still reach one. The cache is fed by
 * `observeModelRegistry` on every action dispatch.
 */
import type { ActionModelRegistry } from "./actions.js";
/** Feed the cache with the live registry from a full ExtensionContext. */
export declare function observeModelRegistry(reg: ActionModelRegistry | null | undefined): void;
/** Most recently observed live registry. Throws when no session ctx has been
 *  seen yet (the app gets an explicit action_error from the handlers). */
export declare function ensureModelRegistry(): ActionModelRegistry;
/** Test seam — drop the cached registry so tests can rebuild with fakes. */
export declare function _resetModelRegistryForTests(): void;

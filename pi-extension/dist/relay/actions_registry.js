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
let _cached = null;
/** Feed the cache with the live registry from a full ExtensionContext. */
export function observeModelRegistry(reg) {
    if (reg)
        _cached = reg;
}
/** Most recently observed live registry. Throws when no session ctx has been
 *  seen yet (the app gets an explicit action_error from the handlers). */
export function ensureModelRegistry() {
    if (!_cached)
        throw new Error("Model registry unavailable (no session ctx yet)");
    return _cached;
}
/** Test seam — drop the cached registry so tests can rebuild with fakes. */
export function _resetModelRegistryForTests() {
    _cached = null;
}
//# sourceMappingURL=actions_registry.js.map
/**
 * Relay URL resolution — no config file, two sources only:
 *
 *   1. `REMOTE_PI_RELAY` env var (ops/CI escape hatch)
 *   2. `kDefaultRelayUrl` (community default)
 *
 * Canonical form is http(s)://; conversion to ws(s):// happens at the
 * transport layer (see `toWebSocketUrl`). The community relay's reverse proxy
 * maps `:443 → :3000` (the WS port), so the URL has no explicit port and the
 * WebSocket upgrade rides on the same TLS connection as the HTTPS endpoints
 * used by the mesh client.
 */
export declare const kDefaultRelayUrl = "https://relay-rp1.jacobmoura.work";
export type RelayResolution = {
    url: string;
    source: "env" | "default";
};
/** Resolves the effective relay URL in **canonical http(s):// form**. */
export declare function resolveRelayUrl(): RelayResolution;
/**
 * Converts an http(s):// URL to the corresponding ws(s):// form. Used by
 * the transport layer right before opening the WebSocket — config storage
 * and the mesh HTTP client both stay on http(s)://.
 *
 *   https://host  → wss://host
 *   http://host   → ws://host
 *   ws(s)://host  → pass-through (defensive — env overrides may carry ws(s)://)
 */
export declare function toWebSocketUrl(url: string): string;
/** Inverse of `toWebSocketUrl`. */
export declare function toHttpUrl(url: string): string;

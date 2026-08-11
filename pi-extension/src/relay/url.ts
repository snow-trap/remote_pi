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

export const kDefaultRelayUrl = "https://relay-rp1.jacobmoura.work";

export type RelayResolution = { url: string; source: "env" | "default" };

/** Resolves the effective relay URL in **canonical http(s):// form**. */
export function resolveRelayUrl(): RelayResolution {
  const env = process.env["REMOTE_PI_RELAY"];
  if (env && env.length > 0) return { url: toHttpUrl(env), source: "env" };
  return { url: toHttpUrl(kDefaultRelayUrl), source: "default" };
}

/**
 * Converts an http(s):// URL to the corresponding ws(s):// form. Used by
 * the transport layer right before opening the WebSocket — config storage
 * and the mesh HTTP client both stay on http(s)://.
 *
 *   https://host  → wss://host
 *   http://host   → ws://host
 *   ws(s)://host  → pass-through (defensive — env overrides may carry ws(s)://)
 */
export function toWebSocketUrl(url: string): string {
  const lower = url.toLowerCase();
  if (lower.startsWith("https://")) return "wss://" + url.slice("https://".length);
  if (lower.startsWith("http://"))  return "ws://"  + url.slice("http://".length);
  return url;
}

/** Inverse of `toWebSocketUrl`. */
export function toHttpUrl(url: string): string {
  const lower = url.toLowerCase();
  if (lower.startsWith("wss://")) return "https://" + url.slice("wss://".length);
  if (lower.startsWith("ws://"))  return "http://"  + url.slice("ws://".length);
  return url;
}

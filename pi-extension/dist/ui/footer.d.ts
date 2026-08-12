/**
 * Footer renderer for the Pi TUI. Three status slots + window title.
 *
 * Slot keys (intentionally namespaced so other extensions don't collide):
 *   - remote-pi:session   — current local session + peer count
 *   - remote-pi:relay     — relay state (off / on / paired)
 *   - remote-pi:peer-active — active mobile device, if paired
 *
 * Slots are plain text — no emoji. Host footers (e.g. pi-spark) render
 * extension statuses in the theme's dim color, so anything we draw
 * ourselves (colored dots, satellite/phone emoji) breaks the line's
 * color discipline and can't be themed. Attention states are spelled
 * out in words instead ("relay: pairing needed").
 */
export interface FooterContext {
    ui: {
        setStatus(key: string, value: string | undefined): void;
        setTitle(title: string): void;
    };
}
export interface FooterState {
    session?: string;
    peerCount?: number;
    relayOn?: boolean;
    /** Active device session right now (drives the peer-active slot).
     *  Independent from `hasPairings` — a device may be paired globally
     *  in peers.json without being actively connected to THIS Pi process. */
    devicePaired?: string;
    /** At least one device has been paired with this machine before
     *  (peers.json is non-empty). Drives the relay slot text:
     *  "relay" when true (ready — devices can connect),
     *  "relay: pairing needed" when false (first pairing needed).
     *  Pairing is per-machine (global), not per-process. */
    hasPairings?: boolean;
    /** Assigned agent name in the current session. Becomes the title prefix
     *  (e.g. "backend · foo · relay") when set. Falls back to "Pi" otherwise. */
    agentName?: string;
}
export declare function updateFooter(ctx: FooterContext, state: FooterState): void;

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Inject text into the agent as a user message, waking a turn. The Pi SDK's
 * `ExtensionAPI.sendUserMessage` is fire-and-forget (returns `void`) and
 * "always triggers a turn" — the SDK runtime owns any *async* turn failure
 * (no model/API key, expired auth, provider error), which surfaces in the
 * agent's own output, not back to us. Two gaps this helper closes, both of
 * which previously failed silently:
 *
 *   1. `pi` not bound yet (activation race / mesh joined before the session
 *      attached): the old code did `if (!pi) return`, dropping the message
 *      with no trace. We log it instead.
 *   2. A *synchronous* throw from `sendUserMessage` (e.g. malformed content):
 *      the old fire-and-forget call let it propagate out of the caller,
 *      which could wedge the read loop and blackout every later message.
 *      We catch + surface it instead.
 *
 * NOTE: this does NOT make a wake that fails *inside* the SDK observable —
 * that requires a fix in the Pi runtime (no extension-level error event
 * exists for it).
 */

type SendUserMessageOptions =
  NonNullable<Parameters<ExtensionAPI["sendUserMessage"]>[1]>;

export type WakeAgentResult =
  | { ok: true }
  | { ok: false; detail: string };

export function wakeAgent(
  pi: ExtensionAPI | null,
  content: Parameters<ExtensionAPI["sendUserMessage"]>[0],
  label: string,
  steeringBehavior?: SendUserMessageOptions["deliverAs"],
  notify?: (message: string, level: "info" | "warning" | "error") => void,
): WakeAgentResult {
  if (!pi) {
    const detail = "agent session not bound yet";
    console.error(`[remote-pi] ${label}: ${detail} — message dropped`);
    return { ok: false, detail };
  }
  try {
    const options = steeringBehavior
      ? ({ deliverAs: steeringBehavior })
      : undefined;
    pi.sendUserMessage(content, options);
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[remote-pi] ${label}: agent rejected incoming message: ${detail}`);
    notify?.(`[remote-pi] failed to process incoming message: ${detail}`, "error");
    return { ok: false, detail };
  }
}

/**
 * `--relay` / `--mesh` boolean CLI flags.
 *
 * Both features are OFF by default: a bare `pi` boot leaves the extension
 * fully inert (no auto-start, no tools, no skill). The flags only gate the
 * session_start auto-start; manual `/remote-pi start …` commands are explicit
 * user intent and ignore them.
 *
 * Registered via `pi.registerFlag` (boolean type) so the Pi CLI validates
 * them: an unregistered flag aborts with "Unknown option", a registered one
 * lands in `pi.getFlag("relay")` — and stays visible in process.argv (the
 * SDK never strips it). We read BOTH `pi.getFlag` and process.argv because
 * this module may be re-evaluated before the flag runtime is rebound in
 * some hosts.
 */

export interface FeatureFlags {
  relay: boolean;
  mesh: boolean;
}

/** Raw boolean presence from argv (`--relay` / `--mesh`). */
export function flagFromArgv(name: "relay" | "mesh", argv: string[] = process.argv): boolean {
  return argv.includes(`--${name}`);
}

export function resolveFeatureFlags(
  getFlag?: (name: string) => boolean | string | undefined,
  argv: string[] = process.argv,
): FeatureFlags {
  return {
    relay: getFlag?.("relay") === true || flagFromArgv("relay", argv),
    mesh: getFlag?.("mesh") === true || flagFromArgv("mesh", argv),
  };
}

/**
 * One-shot / non-interactive Pi (`pi -p` / `pi --print`) is documented as
 * "process the prompt and exit". Auto-starting the relay there opens a WS
 * that is never `.unref()`'d, so the idle Node event loop never drains and
 * the process hangs forever after printing its answer (issue #44).
 */
export function isPrintMode(argv: string[] = process.argv): boolean {
  return argv.includes("-p") || argv.includes("--print");
}

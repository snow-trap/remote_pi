/**
 * Normalize a name segment to a mesh-safe token: trim, replace the addressing
 * separators (`/ : @ #`) and whitespace runs with `-`, collapse repeats, strip
 * edges. The `@` is included so a sanitized name can never contain the address
 * separator — `<cwd>@<name>` stays unambiguous on the wire. Returns undefined
 * when the input isn't a usable non-empty string, sanitizes to empty, or is a
 * reserved addressing keyword (`broadcast` / `broker`). Used by the broker's
 * `sanitizeMeshName` to keep the `<nome>` half of a peer address safe to
 * compose (plan/38).
 */
export declare function sanitizeSegment(v: unknown): string | undefined;
/**
 * Default agent name when the pi session has no name: the **leaf** of the cwd,
 * `basename(cwd)`. The cwd travels as its own address axis (`<cwd>@<nome>`), so
 * the name needs no `parent/folder` prefix to disambiguate folders — the broker
 * keys peers by `(cwd, nome)`. Falls back to `"agent"` for a path with no
 * usable basename (root / empty).
 */
export declare function defaultAgentName(cwd: string): string;

/**
 * `edit` tool-call argument enrichment — pure functions.
 *
 * Attaches rendered diff hunks (context/remove/add lines) to an `edit` tool
 * call so the app can render a proper diff view instead of raw JSON args.
 * Reads the target file best-effort; never throws — enrichment failure just
 * returns the original args.
 */
export type ToolArgs = Record<string, unknown>;
export type DiffLine = {
    kind: "context";
    oldLine?: number;
    newLine?: number;
    text: string;
} | {
    kind: "remove";
    oldLine?: number;
    text: string;
} | {
    kind: "add";
    newLine?: number;
    text: string;
} | {
    kind: "ellipsis";
};
export declare function enrichToolArgs(tool: string, args: unknown, cwd: string): ToolArgs;

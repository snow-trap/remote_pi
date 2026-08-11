/**
 * session_sync history mapping — pure functions.
 *
 * Maps the cumulative agent-message buffer (fed by `message_end`) into the
 * flat SessionHistoryEvent[] shape consumed by the app, plus the stringify
 * helpers shared by the live broadcast and the history mapper so the app
 * shows the SAME text live and on re-sync.
 */
import type { SessionHistoryEvent, WireImage } from "./protocol.js";
/** Snapshot of one persisted agent message (user/assistant/toolResult or the
 *  synthetic `compaction` marker pushed by the session_compact handler). */
export type BufferMsg = {
    role: "user" | "assistant" | "toolResult" | string;
    content?: unknown;
    timestamp?: number;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    usage?: {
        input?: number;
        output?: number;
    };
    /** Pre-compaction token count, set on the synthetic `role:"compaction"`
     *  marker. */
    tokensBefore?: number;
};
export declare function stringifyContent(content: unknown): string;
/**
 * Stringify a tool result consistently for BOTH the live `tool_execution_end`
 * broadcast AND the history mapper. The SDK's `ToolExecutionEndEvent.result`
 * is `any` — usually a content-array of `{type:"text"}` blocks; `String()` on
 * that yields the "[object Object]" bug. Rules: string → as-is; content-array
 * → join its text; any other object → readable JSON; other primitives →
 * `String()`; null/undefined → "". Never "[object Object]".
 */
export declare function stringifyToolResult(value: unknown): string;
/**
 * Plan/30: extract `ImageContent` blocks ({type:"image", data, mimeType}) from
 * an SDK message's content and map them to the wire shape (`mimeType` →
 * `mime`). Used by the history mapper so a re-synced image bubble keeps its
 * bytes — `stringifyContent` only pulls text and would otherwise drop the
 * image.
 */
export declare function imagesFromContent(content: unknown): WireImage[];
/**
 * Maps SDK AgentMessage[] (UserMessage / AssistantMessage / ToolResultMessage)
 * into the flat SessionHistoryEvent[] shape consumed by the app.
 *
 * Caveat: in_reply_to of agent_message is the *last* user_input id seen in a
 * linear scan — fine for typical conversational flow but not a perfect
 * reconstruction of multi-turn ordering when tools interleave. Stable id for
 * user_input is `sync_<timestamp>`.
 */
export declare function mapAgentMessagesToEvents(messages: BufferMsg[]): SessionHistoryEvent[];

/**
 * session_sync history mapping — pure functions.
 *
 * Maps the cumulative agent-message buffer (fed by `message_end`) into the
 * flat SessionHistoryEvent[] shape consumed by the app, plus the stringify
 * helpers shared by the live broadcast and the history mapper so the app
 * shows the SAME text live and on re-sync.
 */
export function stringifyContent(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content
        .map((c) => {
        if (!c || typeof c !== "object")
            return "";
        const block = c;
        return block.type === "text" ? String(block.text ?? "") : "";
    })
        .join("");
}
/**
 * Stringify a tool result consistently for BOTH the live `tool_execution_end`
 * broadcast AND the history mapper. The SDK's `ToolExecutionEndEvent.result`
 * is `any` — usually a content-array of `{type:"text"}` blocks; `String()` on
 * that yields the "[object Object]" bug. Rules: string → as-is; content-array
 * → join its text; any other object → readable JSON; other primitives →
 * `String()`; null/undefined → "". Never "[object Object]".
 */
export function stringifyToolResult(value) {
    if (typeof value === "string")
        return value;
    if (Array.isArray(value))
        return stringifyContent(value);
    if (value !== null && typeof value === "object") {
        // The LIVE `tool_execution_end` result is a WRAPPER object
        // `{ content: [{type:"text",...}], details:{} }` — not the bare
        // content-array the history path (`m.content`) carries. Unwrap `content`
        // (or a plain `text`) so live == re-sync; JSON is only the last fallback.
        const obj = value;
        if (Array.isArray(obj.content))
            return stringifyContent(obj.content);
        if (typeof obj.text === "string")
            return obj.text;
        try {
            return JSON.stringify(value);
        }
        catch {
            return "";
        }
    }
    return value === null || value === undefined ? "" : String(value);
}
/**
 * Plan/30: extract `ImageContent` blocks ({type:"image", data, mimeType}) from
 * an SDK message's content and map them to the wire shape (`mimeType` →
 * `mime`). Used by the history mapper so a re-synced image bubble keeps its
 * bytes — `stringifyContent` only pulls text and would otherwise drop the
 * image.
 */
export function imagesFromContent(content) {
    if (!Array.isArray(content))
        return [];
    const out = [];
    for (const c of content) {
        if (!c || typeof c !== "object")
            continue;
        const block = c;
        if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
            out.push({ data: block.data, mime: block.mimeType });
        }
    }
    return out;
}
/**
 * Maps SDK AgentMessage[] (UserMessage / AssistantMessage / ToolResultMessage)
 * into the flat SessionHistoryEvent[] shape consumed by the app.
 *
 * Caveat: in_reply_to of agent_message is the *last* user_input id seen in a
 * linear scan — fine for typical conversational flow but not a perfect
 * reconstruction of multi-turn ordering when tools interleave. Stable id for
 * user_input is `sync_<timestamp>`.
 */
export function mapAgentMessagesToEvents(messages) {
    const events = [];
    let lastUserId = null;
    for (const m of messages) {
        const ts = typeof m.timestamp === "number" ? m.timestamp : 0;
        if (m.role === "compaction") {
            // Re-render the compaction notice on history re-sync.
            events.push({
                ts,
                type: "compaction",
                summary: typeof m.content === "string" ? m.content : "",
                tokens_before: typeof m.tokensBefore === "number" ? m.tokensBefore : 0,
            });
        }
        else if (m.role === "user") {
            const id = `sync_${ts}`;
            lastUserId = id;
            const images = imagesFromContent(m.content);
            const ev = {
                ts,
                type: "user_input",
                id,
                text: stringifyContent(m.content),
            };
            if (images.length > 0)
                ev.images = images;
            events.push(ev);
        }
        else if (m.role === "assistant") {
            const content = Array.isArray(m.content) ? m.content : [];
            const usage = m.usage
                ? { input_tokens: m.usage.input ?? 0, output_tokens: m.usage.output ?? 0 }
                : undefined;
            for (const raw of content) {
                if (!raw || typeof raw !== "object")
                    continue;
                const block = raw;
                if (block.type === "text") {
                    const text = String(block.text ?? "");
                    if (!text)
                        continue;
                    events.push({
                        ts,
                        type: "agent_message",
                        in_reply_to: lastUserId ?? `sync_${ts}`,
                        text,
                        ...(usage ? { usage } : {}),
                    });
                }
                else if (block.type === "toolCall") {
                    events.push({
                        ts,
                        type: "tool_request",
                        tool_call_id: String(block.id ?? ""),
                        tool: String(block.name ?? ""),
                        args: block.arguments ?? {},
                    });
                }
            }
        }
        else if (m.role === "toolResult") {
            const text = stringifyToolResult(m.content);
            const tcid = String(m.toolCallId ?? "");
            events.push(m.isError
                ? { ts, type: "tool_result", tool_call_id: tcid, error: text }
                : { ts, type: "tool_result", tool_call_id: tcid, result: text });
        }
    }
    return events;
}
//# sourceMappingURL=history.js.map
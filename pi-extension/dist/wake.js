export function wakeAgent(pi, content, label, steeringBehavior, notify) {
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
    }
    catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`[remote-pi] ${label}: agent rejected incoming message: ${detail}`);
        notify?.(`[remote-pi] failed to process incoming message: ${detail}`, "error");
        return { ok: false, detail };
    }
}
//# sourceMappingURL=wake.js.map
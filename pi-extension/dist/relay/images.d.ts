/**
 * Received-image channel (phone → pi) — payload handling + TUI preview.
 *
 * The app attaches images to a `user_message`; the bytes reach the model via
 * the paired `sendUserMessage` call. In parallel we persist the image to a
 * 0700 temp dir and show a local TUI preview as a custom message
 * (`remote-pi:received-image`). That preview entry is LOCAL DISPLAY ONLY:
 * pi would otherwise persist it as a CustomMessageEntry and inject it into
 * the LLM context on every turn, so the extension strips this type in its
 * `context` / `session_before_compact` hooks (see `filterReceivedImage…`).
 */
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ClientMessage } from "./protocol.js";
export declare const REMOTE_PI_RECEIVED_IMAGE_TYPE = "remote-pi:received-image";
export declare const RECEIVED_IMAGE_MAX_BYTES: number;
export declare const IMAGE_PREVIEW_MIME = "image/png";
export type ClientUserMessage = Extract<ClientMessage, {
    type: "user_message";
}>;
export type ReceivedImageDetails = {
    messageId: string;
    index: number;
    mime: string;
    size?: number;
    path?: string;
    previewPath?: string;
    text?: string;
    error?: string;
    reason?: string;
};
export declare function decodeImagePayload(data: string, mime: string): {
    ok: true;
    decoded: Buffer;
    size: number;
} | {
    ok: false;
    reason: string;
};
/** Persist the message's images to the temp cache + build preview metadata. */
export declare function collectReceivedImagePreviews(msg: ClientUserMessage): Promise<ReceivedImageDetails[]>;
/** Build the sendUserMessage content for an app message (text + images). */
export declare function contentFromUserMessage(msg: ClientUserMessage): Parameters<ExtensionAPI["sendUserMessage"]>[0];
/** TUI renderer for the local preview entry (chat panel + inline image). */
export declare function registerReceivedImageRenderer(pi: ExtensionAPI): void;
export declare function isReceivedImageContextMessage(message: unknown): boolean;
/** Strip preview entries from any message list headed for the LLM. */
export declare function filterReceivedImageMessagesFromContext<T>(messages: T[] | undefined): T[];

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

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToPng, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Container, Image, Text } from "@earendil-works/pi-tui";
import type { ClientMessage } from "./protocol.js";

export const REMOTE_PI_RECEIVED_IMAGE_TYPE = "remote-pi:received-image";
export const RECEIVED_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_PREVIEW_MIME = "image/png";

export type ClientUserMessage = Extract<ClientMessage, { type: "user_message" }>;

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

const IMAGE_CACHE_PREFIX = "pi-app-";
let _imageCacheDir: string | undefined;

function imageCacheRootDir(): string {
  if (_imageCacheDir) {
    try { mkdirSync(_imageCacheDir, { recursive: true, mode: 0o700 }); } catch {}
    try { chmodSync(_imageCacheDir, 0o700); } catch {}
    return _imageCacheDir;
  }
  const dir = mkdtempSync(join(tmpdir(), IMAGE_CACHE_PREFIX));
  try { chmodSync(dir, 0o700); } catch {}
  _imageCacheDir = dir;
  return dir;
}

function imageExtension(mime: string): string | undefined {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  return undefined;
}

function isBase64Char(code: number): boolean {
  return (code >= 48 && code <= 57) // 0-9
    || (code >= 65 && code <= 90) // A-Z
    || (code >= 97 && code <= 122) // a-z
    || code === 43 // +
    || code === 47; // /
}

function isStrictBase64(data: string): boolean {
  if (data.length === 0 || data.length % 4 !== 0) return false;
  if (data.startsWith("=")) return false;

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  for (let i = 0; i < data.length; i += 1) {
    const code = data.charCodeAt(i);
    if (i >= data.length - padding) {
      if (code !== 61) return false;
      continue;
    }
    if (!isBase64Char(code)) return false;
  }

  return true;
}

function safeFilenameToken(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "message";
}

function safePreviewPath(dir: string, messageId: string, index: number): string {
  return join(dir, `${safeFilenameToken(messageId)}-${index}.preview.png`);
}

function cleanupPreviewFile(previewPath: string): void {
  try {
    if (existsSync(previewPath)) unlinkSync(previewPath);
  } catch {
    // best effort
  }
}

async function renderablePngPathFromImage(
  imageData: string,
  mime: string,
  previewPath: string,
): Promise<string | undefined> {
  if (mime === IMAGE_PREVIEW_MIME) return undefined;

  try {
    const converted = await convertToPng(imageData, mime);
    if (!converted || converted.mimeType !== IMAGE_PREVIEW_MIME || !converted.data) {
      return undefined;
    }

    const previewBytes = Buffer.from(converted.data, "base64");
    if (previewBytes.length === 0 || previewBytes.length > RECEIVED_IMAGE_MAX_BYTES) {
      return undefined;
    }

    try {
      writeFileSync(previewPath, previewBytes, { mode: 0o600 });
      try { chmodSync(previewPath, 0o600); } catch {}
      return previewPath;
    } catch {
      cleanupPreviewFile(previewPath);
    }
  } catch {
    cleanupPreviewFile(previewPath);
  }

  return undefined;
}

export function decodeImagePayload(data: string, mime: string): { ok: true; decoded: Buffer; size: number } | { ok: false; reason: string } {
  if (!imageExtension(mime)) return { ok: false, reason: `unsupported mime: ${mime}` };
  if (data.startsWith("data:")) return { ok: false, reason: "data URI payloads are not supported" };
  if (!isStrictBase64(data)) return { ok: false, reason: "invalid base64 payload" };

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const estimate = (data.length / 4) * 3 - padding;
  if (estimate > RECEIVED_IMAGE_MAX_BYTES) {
    return { ok: false, reason: `image too large (${estimate} bytes)` };
  }

  const decoded = Buffer.from(data, "base64");
  if (decoded.length === 0 || decoded.length > RECEIVED_IMAGE_MAX_BYTES) {
    return { ok: false, reason: `invalid decoded image size (${decoded.length} bytes)` };
  }

  return { ok: true, decoded, size: decoded.length };
}

/** Persist the message's images to the temp cache + build preview metadata. */
export async function collectReceivedImagePreviews(msg: ClientUserMessage): Promise<ReceivedImageDetails[]> {
  if (!msg.images || msg.images.length === 0) return [];

  const previews: ReceivedImageDetails[] = [];
  const text = typeof msg.text === "string" ? msg.text : "";
  const dir = imageCacheRootDir();

  for (let i = 0; i < msg.images.length; i += 1) {
    const image = msg.images[i];
    const mime = typeof image?.mime === "string" ? image.mime : "unknown";

    if (!image || typeof image.data !== "string") {
      console.error(`[remote-pi] malformed image in message ${msg.id} index=${i}`);
      previews.push({
        messageId: msg.id,
        index: i,
        mime,
        ...(text ? { text } : {}),
        error: "malformed image payload",
        reason: "missing mime/data payload fields",
      });
      continue;
    }

    const decoded = decodeImagePayload(image.data, image.mime);
    if (!decoded.ok) {
      console.error(`[remote-pi] skipped image id=${msg.id} index=${i}: ${decoded.reason}`);
      previews.push({
        messageId: msg.id,
        index: i,
        mime: image.mime,
        ...(text ? { text } : {}),
        error: "invalid image payload",
        reason: decoded.reason,
      });
      continue;
    }

    const ext = imageExtension(image.mime);
    if (!ext) {
      console.error(`[remote-pi] unsupported image mime in message ${msg.id} index=${i}: ${image.mime}`);
      previews.push({
        messageId: msg.id,
        index: i,
        mime: image.mime,
        ...(text ? { text } : {}),
        error: "invalid image payload",
        reason: `unsupported mime: ${image.mime}`,
      });
      continue;
    }

    const filename = `${safeFilenameToken(msg.id)}-${i}.${ext}`;
    const path = join(dir, filename);

    try {
      writeFileSync(path, decoded.decoded, { mode: 0o600 });
      try { chmodSync(path, 0o600); } catch {}

      const previewPath =
        image.mime === IMAGE_PREVIEW_MIME
          ? undefined
          : await renderablePngPathFromImage(
              image.data,
              image.mime,
              safePreviewPath(dir, msg.id, i),
            );

      previews.push({
        messageId: msg.id,
        index: i,
        mime: image.mime,
        size: decoded.size,
        path,
        ...(previewPath ? { previewPath } : {}),
        ...(text ? { text } : {}),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[remote-pi] failed saving image id=${msg.id} index=${i}: ${detail}`);
      previews.push({
        messageId: msg.id,
        index: i,
        mime: image.mime,
        ...(text ? { text } : {}),
        path,
        error: "failed to save image",
        reason: detail,
      });
    }
  }

  return previews;
}

/** Build the sendUserMessage content for an app message (text + images). */
export function contentFromUserMessage(
  msg: ClientUserMessage,
): Parameters<ExtensionAPI["sendUserMessage"]>[0] {
  return msg.images && msg.images.length > 0
    ? [
        ...msg.images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mime })),
        { type: "text" as const, text: msg.text },
      ]
    : msg.text;
}

/** TUI renderer for the local preview entry (chat panel + inline image). */
export function registerReceivedImageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<ReceivedImageDetails>(
    REMOTE_PI_RECEIVED_IMAGE_TYPE,
    (message, _options, theme) => {
      const details = (message.details ?? {}) as Partial<ReceivedImageDetails>;
      const path = typeof details.path === "string" ? details.path : "";
      const previewPath = typeof details.previewPath === "string" ? details.previewPath : "";
      const mime = typeof details.mime === "string" ? details.mime : "application/octet-stream";
      const inlineImagePath = previewPath.length > 0
        ? previewPath
        : (mime === IMAGE_PREVIEW_MIME ? path : "");
      const size = typeof details.size === "number" ? details.size : undefined;
      const index = typeof details.index === "number" ? details.index : undefined;
      const text = typeof details.text === "string" ? details.text.trim() : "";
      const messageId = typeof details.messageId === "string" ? details.messageId : "unknown";
      const error = typeof details.error === "string" ? details.error : undefined;
      const reason = typeof details.reason === "string" ? details.reason : undefined;

      const label = `📷 Photo from Android (${messageId}${index !== undefined ? ` #${index}` : ""})`;
      const lines = [
        theme.fg("customMessageLabel", label),
        theme.fg("customMessageText", `Saved: ${path || "(not saved)"}`),
      ];
      if (size !== undefined) lines.push(theme.fg("customMessageText", `Size: ${size} bytes`));
      if (mime) lines.push(theme.fg("customMessageText", `MIME: ${mime}`));
      if (error) lines.push(theme.fg("customMessageText", `Error: ${error}`));
      if (reason) lines.push(theme.fg("customMessageText", `Reason: ${reason}`));
      if (text) lines.push(theme.fg("customMessageText", `Text: ${text}`));

      const container = new Container();
      const metadata = new Box(1, 1, (line) => theme.bg("customMessageBg", line));
      metadata.addChild(new Text(lines.join("\n")));
      container.addChild(metadata);

      if (inlineImagePath && !error) {
        try {
          const imageData = readFileSync(inlineImagePath).toString("base64");
          if (imageData.length > 0) {
            const image = new Image(imageData, IMAGE_PREVIEW_MIME, {
              fallbackColor: (str) => theme.fg("customMessageText", str),
            });
            // Keep Kitty image rows out of Box padding/background so pi-tui can
            // preserve the empty reserved rows that make inline images visible.
            container.addChild(image);
          }
        } catch {
          // Keep the metadata-only fallback on any IO/terminal issue.
        }
      }

      return container;
    },
  );
}

export function isReceivedImageContextMessage(message: unknown): boolean {
  return typeof message === "object"
    && message !== null
    && (message as { role?: unknown }).role === "custom"
    && (message as { customType?: unknown }).customType === REMOTE_PI_RECEIVED_IMAGE_TYPE;
}

/** Strip preview entries from any message list headed for the LLM. */
export function filterReceivedImageMessagesFromContext<T>(messages: T[] | undefined): T[] {
  return Array.isArray(messages)
    ? messages.filter((message) => !isReceivedImageContextMessage(message))
    : [];
}

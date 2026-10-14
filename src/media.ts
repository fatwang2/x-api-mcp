import fs from "node:fs/promises";
import path from "node:path";
import { XClient } from "./client.js";

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".srt": "text/srt",
};

export type MediaCategory = "tweet_image" | "tweet_gif" | "tweet_video" | "subtitles";

const MB = 1024 * 1024;
const SIMPLE_MAX = 5 * MB;
const CHUNK = 4 * MB; // docs: keep segments at or below 5 MB
const PROCESSING_TIMEOUT_MS = 10 * 60_000;

export interface UploadInput {
  account?: string;
  file_path?: string;
  base64?: string;
  mime_type?: string;
  media_category?: MediaCategory;
  alt_text?: string;
}

export interface UploadResult {
  media_id: string;
  media_key?: string;
  media_category: MediaCategory;
  bytes: number;
  method: "simple" | "chunked";
  processing?: unknown;
  alt_text_set?: boolean;
}

export function guessCategory(mime: string): MediaCategory {
  if (mime === "image/gif") return "tweet_gif";
  if (mime.startsWith("video/")) return "tweet_video";
  if (mime === "text/srt" || mime === "text/vtt") return "subtitles";
  return "tweet_image";
}

/**
 * Upload media for a post. Images up to 5 MB use the one-shot POST /2/media/upload;
 * GIFs, videos and larger files use initialize/append/finalize and wait for processing.
 */
export async function uploadMedia(client: XClient, input: UploadInput): Promise<UploadResult> {
  let bytes: Buffer;
  let mime = input.mime_type;
  if (input.file_path) {
    const p = expandHome(input.file_path);
    bytes = await fs.readFile(p);
    mime ??= MIME[path.extname(p).toLowerCase()];
    if (!mime) throw new Error(`Unknown media type for ${p}; pass mime_type (e.g. image/png, video/mp4).`);
  } else if (input.base64) {
    bytes = Buffer.from(input.base64.replace(/^data:[^;]+;base64,/, ""), "base64");
    if (!mime) {
      const m = input.base64.match(/^data:([^;]+);base64,/);
      mime = m?.[1];
    }
    if (!mime) throw new Error("mime_type is required with base64 data.");
  } else {
    throw new Error("Provide file_path or base64.");
  }
  if (!bytes.length) throw new Error("Media is empty.");

  const account = client.resolveAccount(input.account);
  const category = input.media_category ?? guessCategory(mime);
  const simple = category === "tweet_image" && bytes.length <= SIMPLE_MAX;

  let data: any;
  if (simple) {
    const form = new FormData();
    form.append("media", new Blob([new Uint8Array(bytes)], { type: mime }), "media");
    form.append("media_category", category);
    data = (await client.request(account, "POST", "/2/media/upload", { form })).data;
  } else {
    data = await chunkedUpload(client, account, bytes, mime, category);
  }

  const result: UploadResult = {
    media_id: String(data.id),
    media_key: data.media_key,
    media_category: category,
    bytes: bytes.length,
    method: simple ? "simple" : "chunked",
  };
  if (data.processing_info) result.processing = data.processing_info;
  if (input.alt_text) {
    await client.request(account, "POST", "/2/media/metadata", {
      json: { id: result.media_id, metadata: { alt_text: { text: input.alt_text.slice(0, 1000) } } },
    });
    result.alt_text_set = true;
  }
  return result;
}

async function chunkedUpload(
  client: XClient,
  account: string,
  bytes: Buffer,
  mime: string,
  category: MediaCategory,
): Promise<any> {
  const init = await client.request(account, "POST", "/2/media/upload/initialize", {
    json: { media_type: mime, total_bytes: bytes.length, media_category: category },
  });
  const id = String(init.data.id);
  for (let i = 0, seg = 0; i < bytes.length; i += CHUNK, seg++) {
    const form = new FormData();
    form.append("segment_index", String(seg));
    form.append("media", new Blob([new Uint8Array(bytes.subarray(i, i + CHUNK))], { type: "application/octet-stream" }), "chunk");
    await client.request(account, "POST", `/2/media/upload/${id}/append`, { form });
  }
  let data = (await client.request(account, "POST", `/2/media/upload/${id}/finalize`)).data;
  const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
  while (data?.processing_info && ["pending", "in_progress"].includes(data.processing_info.state)) {
    if (Date.now() > deadline) {
      throw new Error(`Media ${id} still processing after ${PROCESSING_TIMEOUT_MS / 60000} min; check later with media_status.`);
    }
    const wait = Math.min(Math.max(Number(data.processing_info.check_after_secs) || 2, 1), 30);
    await new Promise((r) => setTimeout(r, wait * 1000));
    data = (await mediaStatus(client, account, id)).data;
  }
  if (data?.processing_info?.state === "failed") {
    throw new Error(`Media processing failed: ${JSON.stringify(data.processing_info.error ?? data.processing_info)}`);
  }
  return { ...data, id: data?.id ?? id };
}

export function mediaStatus(client: XClient, account: string | undefined, mediaId: string) {
  return client.request(client.resolveAccount(account), "GET", "/2/media/upload", {
    query: { command: "STATUS", media_id: mediaId },
  });
}

function expandHome(p: string) {
  return p.startsWith("~/") ? path.join(process.env.HOME || "", p.slice(2)) : p;
}

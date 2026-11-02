import type { XClient } from "./client.js";

export const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".srt": "text/srt",
};

export type MediaCategory =
  | "tweet_image"
  | "tweet_gif"
  | "tweet_video"
  | "dm_image"
  | "dm_gif"
  | "dm_video"
  | "subtitles";

const MB = 1024 * 1024;
const SIMPLE_MAX = 5 * MB;
export const CHUNK = 4 * MB; // docs: keep segments at or below 5 MB
const DEFAULT_WAIT_MS = 10 * 60_000;
/** X's own limits per kind of media. */
export const MAX_BYTES = { image: 5 * MB, gif: 15 * MB, video: 512 * MB, subtitles: 5 * MB } as const;

/** Media bytes from any source, readable once as a stream. */
export interface MediaBlob {
  mime?: string;
  /** Total size in bytes, when known before reading. */
  size?: number;
  /** File name or path, used to guess the type when `mime` is missing. */
  name?: string;
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
}

/**
 * Where media can come from on this server. The local server reads files from disk; the Worker
 * reads its R2 bucket and fetches https URLs. Sources left out are simply not offered.
 */
export interface MediaSources {
  readFile?(path: string): Promise<MediaBlob>;
  readR2?(key: string): Promise<MediaBlob>;
  /** Fetch public https URLs (media_url). */
  urls?: boolean;
  /** Largest base64 payload accepted, decoded (default: no extra limit). */
  base64MaxBytes?: number;
  /** How long to wait for video/GIF processing before handing back the media_id (default 10 min). */
  waitMs?: number;
  fetch?: typeof fetch;
}

export interface MediaRef {
  file_path?: string;
  r2_key?: string;
  media_url?: string;
  alt_text?: string;
}

export interface UploadInput extends MediaRef {
  account?: string;
  base64?: string;
  mime_type?: string;
  media_category?: MediaCategory;
}

export interface UploadResult {
  media_id: string;
  media_key?: string;
  media_category: MediaCategory;
  bytes: number;
  method: "simple" | "chunked";
  processing?: unknown;
  alt_text_set?: boolean;
  note?: string;
}

const STILL_PROCESSING = ["pending", "in_progress"];

export function guessCategory(mime: string, dm = false): MediaCategory {
  if (mime === "text/srt" || mime === "text/vtt") return "subtitles";
  const kind = mime === "image/gif" ? "gif" : mime.startsWith("video/") ? "video" : "image";
  return `${dm ? "dm" : "tweet"}_${kind}` as MediaCategory;
}

function limitFor(category: MediaCategory): number {
  if (category === "subtitles") return MAX_BYTES.subtitles;
  if (category.endsWith("_gif")) return MAX_BYTES.gif;
  if (category.endsWith("_video")) return MAX_BYTES.video;
  return MAX_BYTES.image;
}

function mimeFromName(name?: string): string | undefined {
  const m = name?.toLowerCase().match(/\.[a-z0-9]+$/);
  return m ? MIME_BY_EXT[m[0]] : undefined;
}

export function offeredSources(src: MediaSources): string[] {
  return [src.readFile && "file_path", src.readR2 && "r2_key", src.urls && "media_url", "base64"].filter(Boolean) as string[];
}

/** Open whichever source the input names (exactly one). */
export async function openMedia(client: XClient, input: UploadInput): Promise<MediaBlob> {
  const src = client.media;
  const offered = offeredSources(src);
  const given = (["file_path", "r2_key", "media_url", "base64"] as const).filter((k) => input[k]);
  if (given.length !== 1) throw new Error(`Give exactly one media source (${offered.join(", ")}).`);
  if (input.file_path) {
    if (!src.readFile) throw new Error(`file_path is not available on this server; use ${offered.join(" or ")}.`);
    return src.readFile(input.file_path);
  }
  if (input.r2_key) {
    if (!src.readR2) throw new Error("r2_key needs an R2 bucket bound to this server.");
    return src.readR2(input.r2_key);
  }
  if (input.media_url) {
    if (!src.urls) throw new Error(`media_url is not available on this server; use ${offered.join(" or ")}.`);
    return fetchMediaUrl(input.media_url, src.fetch ?? fetch);
  }
  const b64 = input.base64!;
  const bytes = Buffer.from(b64.replace(/^data:[^;]+;base64,/, ""), "base64");
  if (src.base64MaxBytes && bytes.length > src.base64MaxBytes) {
    throw new Error(
      `base64 media is limited to ${Math.floor(src.base64MaxBytes / MB)} MB here (got ${(bytes.length / MB).toFixed(1)} MB). ` +
        (src.readR2 ? "Use create_upload_link for larger files." : "Use another source for larger files."),
    );
  }
  return { mime: b64.match(/^data:([^;]+);base64,/)?.[1], size: bytes.length, body: once(new Uint8Array(bytes)) };
}

/**
 * Upload media for a post or DM. Images up to 5 MB use the one-shot POST /2/media/upload;
 * GIFs, videos and larger files are streamed in 4 MB segments through initialize/append/finalize,
 * so a large file is never held in memory whole.
 */
export async function uploadMedia(client: XClient, input: UploadInput, opts: { dm?: boolean } = {}): Promise<UploadResult> {
  const blob = await openMedia(client, input);
  const mime = input.mime_type ?? blob.mime ?? mimeFromName(blob.name ?? input.file_path ?? input.r2_key ?? input.media_url);
  if (!mime) throw new Error("Unknown media type; pass mime_type (e.g. image/png, video/mp4).");
  const category = input.media_category ?? guessCategory(mime, opts.dm);
  const limit = limitFor(category);
  if (blob.size !== undefined && blob.size > limit) {
    await cancel(blob.body);
    throw new Error(`Media is ${(blob.size / MB).toFixed(1)} MB; X allows up to ${limit / MB} MB for ${category}.`);
  }

  const account = await client.resolveAccount(input.account);
  const image = category === "tweet_image" || category === "dm_image";
  let size = blob.size;
  let chunks = segments(blob.body, CHUNK, limit);
  let data: any;
  let method: "simple" | "chunked";
  if (image && (size === undefined || size <= SIMPLE_MAX)) {
    // Images are capped at 5 MB, so buffering one is fine.
    const bytes = await collect(chunks, SIMPLE_MAX);
    if (!bytes.length) throw new Error("Media is empty.");
    size = bytes.length;
    const form = new FormData();
    form.append("media", new Blob([bytes], { type: mime }), "media");
    form.append("media_category", category);
    data = (await client.request(account, "POST", "/2/media/upload", { form, scopes: ["media.write"] })).data;
    method = "simple";
  } else {
    if (size === undefined) {
      // initialize needs the total size up front; buffer when the source didn't say.
      const bytes = await collect(chunks, Math.min(limit, 64 * MB), "The media source did not report its size; files over 64 MB need one.");
      size = bytes.length;
      chunks = segments(once(bytes), CHUNK, limit);
    }
    if (!size) throw new Error("Media is empty.");
    data = await chunkedUpload(client, account, chunks, size, mime, category);
    method = "chunked";
  }

  let processing = data.processing_info;
  const deadline = Date.now() + (client.media.waitMs ?? DEFAULT_WAIT_MS);
  while (processing && STILL_PROCESSING.includes(processing.state) && Date.now() < deadline) {
    const secs = Math.min(Math.max(Number(processing.check_after_secs) || 2, 1), 30);
    await new Promise((r) => setTimeout(r, Math.min(secs * 1000, Math.max(deadline - Date.now(), 0))));
    if (Date.now() >= deadline) break;
    processing = (await mediaStatus(client, account, String(data.id))).data?.processing_info;
  }
  if (processing?.state === "failed") {
    throw new Error(`Media processing failed: ${JSON.stringify(processing.error ?? processing)}`);
  }

  const result: UploadResult = {
    media_id: String(data.id),
    media_key: data.media_key,
    media_category: category,
    bytes: size,
    method,
  };
  if (processing) result.processing = processing;
  if (processing && STILL_PROCESSING.includes(processing.state)) {
    result.note = "X is still processing this media. Call get_media_status until its state is succeeded, then attach it with media_ids.";
  }
  if (input.alt_text) {
    await client.request(account, "POST", "/2/media/metadata", {
      json: { id: result.media_id, metadata: { alt_text: { text: input.alt_text.slice(0, 1000) } } },
    });
    result.alt_text_set = true;
  }
  return result;
}

/** Upload and require the media to be ready, for tools that post right after. */
export async function uploadReady(client: XClient, input: UploadInput, opts: { dm?: boolean } = {}): Promise<string> {
  const r = await uploadMedia(client, input, opts);
  if (r.note) {
    throw new Error(
      `Uploaded media ${r.media_id} is still being processed by X, so nothing was posted. ` +
        "Call get_media_status with this media_id until it succeeds, then post again with media_ids.",
    );
  }
  return r.media_id;
}

async function chunkedUpload(
  client: XClient,
  account: string,
  chunks: AsyncIterable<Uint8Array<ArrayBuffer>>,
  size: number,
  mime: string,
  category: MediaCategory,
): Promise<any> {
  const init = await client.request(account, "POST", "/2/media/upload/initialize", {
    scopes: ["media.write"],
    json: { media_type: mime, total_bytes: size, media_category: category },
  });
  const id = String(init.data.id);
  let seg = 0;
  let sent = 0;
  for await (const chunk of chunks) {
    const form = new FormData();
    form.append("segment_index", String(seg++));
    form.append("media", new Blob([chunk], { type: "application/octet-stream" }), "chunk");
    await client.request(account, "POST", `/2/media/upload/${id}/append`, { form });
    sent += chunk.length;
  }
  if (sent !== size) throw new Error(`The media source sent ${sent} bytes but reported ${size}.`);
  const data = (await client.request(account, "POST", `/2/media/upload/${id}/finalize`)).data;
  return { ...data, id: data?.id ?? id };
}

export async function mediaStatus(client: XClient, account: string | undefined, mediaId: string) {
  return client.request(await client.resolveAccount(account), "GET", "/2/media/upload", {
    query: { command: "STATUS", media_id: mediaId },
  });
}

// ---- streams ------------------------------------------------------------------------------

async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

async function* iterate(body: MediaBlob["body"]): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in body) {
    yield* body as AsyncIterable<Uint8Array>;
    return;
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function cancel(body: MediaBlob["body"]) {
  if (!(Symbol.asyncIterator in body)) await (body as ReadableStream).cancel().catch(() => {});
}

/** Re-cut a byte stream into segments of exactly `size` bytes (the last may be shorter); fail past `limit`. */
export async function* segments(body: MediaBlob["body"], size: number, limit: number): AsyncIterable<Uint8Array<ArrayBuffer>> {
  let buf = new Uint8Array(size);
  let fill = 0;
  let total = 0;
  for await (let piece of iterate(body)) {
    total += piece.length;
    if (total > limit) throw new Error(`Media is larger than the ${limit / MB} MB X allows for this type.`);
    while (piece.length) {
      const n = Math.min(size - fill, piece.length);
      buf.set(piece.subarray(0, n), fill);
      fill += n;
      piece = piece.subarray(n);
      if (fill === size) {
        yield buf;
        buf = new Uint8Array(size);
        fill = 0;
      }
    }
  }
  if (fill) yield buf.subarray(0, fill);
}

async function collect(chunks: AsyncIterable<Uint8Array>, max: number, tooBig?: string): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of chunks) {
    n += c.length;
    if (n > max) throw new Error(tooBig ?? `Media is larger than ${max / MB} MB.`);
    parts.push(c);
  }
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---- media_url ----------------------------------------------------------------------------

const MAX_REDIRECTS = 3;

/**
 * Fetch a public https URL for upload. Refuses plain http, credentials in the URL, other ports,
 * and hosts that name this machine or a private network, checking again after each redirect.
 */
export async function fetchMediaUrl(raw: string, fetchFn: typeof fetch): Promise<MediaBlob> {
  let url = checkMediaUrl(raw);
  for (let hop = 0; ; hop++) {
    const r = await fetchFn(url, { redirect: "manual", headers: { accept: "image/*,video/*" } });
    const location = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && location) {
      await r.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new Error("media_url redirected too many times.");
      url = checkMediaUrl(new URL(location, url).toString());
      continue;
    }
    if (!r.ok || !r.body) {
      await r.body?.cancel();
      throw new Error(`media_url returned HTTP ${r.status}.`);
    }
    const type = r.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    const len = Number(r.headers.get("content-length"));
    return {
      mime: type && type !== "application/octet-stream" ? type : undefined,
      size: Number.isFinite(len) && len > 0 ? len : undefined,
      name: url.pathname,
      body: r.body,
    };
  }
}

export function checkMediaUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("media_url is not a valid URL.");
  }
  if (url.protocol !== "https:") throw new Error("media_url must be an https:// URL.");
  if (url.username || url.password) throw new Error("media_url must not contain credentials.");
  if (url.port && url.port !== "443") throw new Error("media_url must use the default https port.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isInternalHost(host)) throw new Error("media_url must point to a public host, not a private or local address.");
  return url;
}

function isInternalHost(host: string): boolean {
  if (host.includes(":")) return isPrivateV6(host);
  if (!host.includes(".")) return true; // single-label names
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/.test(host)) return true;
  if (/^[0-9a-fx.]+$/i.test(host) && /^[0-9x.]/i.test(host) && !/[g-wyz]/i.test(host)) {
    // Looks numeric. Only plain dotted-decimal is judged; other forms (hex, octal, one integer) are refused.
    const v4 = parseDottedV4(host);
    return v4 ? isPrivateV4(v4) : true;
  }
  return false;
}

function parseDottedV4(host: string): number[] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^(0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255)) return undefined;
  return parts.map(Number);
}

function isPrivateV4([a, b]: number[]): boolean {
  return (
    a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) || a >= 224
  );
}

function isPrivateV6(h: string): boolean {
  if (h === "::" || h === "::1") return true;
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    const v4 = parseDottedV4(mapped[1]);
    return v4 ? isPrivateV4(v4) : true;
  }
  if (h.startsWith("::ffff:") || h.startsWith("::")) return true;
  return /^(fc|fd|fe[89ab]|ff)/.test(h) || h.startsWith("64:ff9b:") || h.startsWith("2001:db8:");
}

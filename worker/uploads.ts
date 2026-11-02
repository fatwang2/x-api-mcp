import type { MediaSources } from "../src/media.js";
import { MAX_BYTES } from "../src/media.js";
import type { Uploads } from "../src/server.js";
import type { Env } from "./env.js";
import { escapeHtml, htmlResponse, layout, messagePage } from "./pages.js";
import { publicBaseUrl } from "./settings.js";
import type { XTokenStore } from "./token-store.js";

const MB = 1024 * 1024;
export const UPLOAD_TTL_MS = 15 * 60_000;
export const UPLOAD_PREFIX = "uploads/";
/**
 * What the upload page takes. Videos stop at 100 MB because that is the largest request body
 * Cloudflare accepts on the Free and Pro plans; X itself allows up to 512 MB.
 */
export const UPLOAD_TYPES: Record<string, number> = {
  "image/jpeg": MAX_BYTES.image,
  "image/png": MAX_BYTES.image,
  "image/webp": MAX_BYTES.image,
  "image/gif": MAX_BYTES.gif,
  "video/mp4": 100 * MB,
  "video/quicktime": 100 * MB,
};

/** Media sources on the Worker: public https URLs, small base64, and the R2 bucket when bound. */
export function workerMediaSources(env: Env): MediaSources {
  const wait = Number(env.X_MEDIA_WAIT_SECONDS ?? 20);
  return {
    urls: true,
    // MCP requests are capped at 4 MB, so base64 is only for small images; bigger files go through R2.
    base64MaxBytes: 2 * MB,
    // Don't hold a tool call open for minutes while X processes a video; get_media_status picks it up.
    waitMs: (Number.isFinite(wait) && wait >= 0 ? Math.min(wait, 120) : 20) * 1000,
    ...(env.X_MEDIA ? { readR2: (key: string) => readUpload(env.X_MEDIA!, key) } : {}),
  };
}

async function readUpload(bucket: R2Bucket, key: string) {
  if (!key.startsWith(UPLOAD_PREFIX) || key.includes("..")) throw new Error("r2_key must be a key from list_uploads.");
  const obj = await bucket.get(key);
  if (!obj) throw new Error(`No upload with r2_key ${key}; call list_uploads to see what is there.`);
  return { mime: obj.httpMetadata?.contentType, size: obj.size, name: key, body: obj.body };
}

function tokenStore(env: Env): DurableObjectStub<XTokenStore> {
  return env.X_TOKEN_STORE.get(env.X_TOKEN_STORE.idFromName("owner"));
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** create_upload_link and list_uploads, backed by the R2 bucket and one-time tokens in the Durable Object. */
export function uploadsFor(env: Env): Uploads | undefined {
  const bucket = env.X_MEDIA;
  if (!bucket) return undefined;
  return {
    async createLink() {
      const token = randomToken();
      const expires = Date.now() + UPLOAD_TTL_MS;
      // Only a hash of the token is stored, so the store alone can't be used to upload.
      await tokenStore(env).addUploadToken(await sha256(token), expires);
      return {
        upload_url: `${publicBaseUrl(env)}/upload/${token}`,
        expires_at: new Date(expires).toISOString(),
        accepts: Object.entries(UPLOAD_TYPES).map(([type, max]) => `${type} up to ${max / MB} MB`),
        note: "Send this link to the user. It works once, for one file, for 15 minutes. After they upload, call list_uploads.",
      };
    },
    async list(limit: number) {
      const listed = await bucket.list({ prefix: UPLOAD_PREFIX, limit: 1000, include: ["httpMetadata", "customMetadata"] });
      const items = listed.objects
        .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())
        .slice(0, limit)
        .map((o) => ({
          r2_key: o.key,
          name: o.customMetadata?.name,
          mime_type: o.httpMetadata?.contentType,
          bytes: o.size,
          uploaded_at: o.uploaded.toISOString(),
        }));
      return { uploads: items, ...(listed.truncated ? { note: "Showing the newest of the first 1000 uploads." } : {}) };
    },
  };
}

/** GET shows the upload page; PUT stores the file in R2 and uses up the token. */
export async function handleUpload(request: Request, env: Env, token: string): Promise<Response> {
  const bucket = env.X_MEDIA;
  if (!bucket) return htmlResponse(messagePage("Uploads are off", "This server has no R2 bucket for uploads."), 404);
  const hash = await sha256(token);
  const store = tokenStore(env);

  if (request.method === "GET") {
    const state = await store.peekUploadToken(hash);
    if (state !== "open") {
      return htmlResponse(messagePage("Link not usable", "This upload link was already used or has expired. Ask Claude for a new one."), 410);
    }
    const nonce = randomToken(16);
    const res = htmlResponse(uploadPage(nonce));
    res.headers.set(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
    );
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  }

  if (request.method !== "PUT") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, PUT" } });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const max = UPLOAD_TYPES[type];
  if (!max) return json(415, { error: `Unsupported file type ${type || "(none)"}. Use JPEG, PNG, WebP, GIF, MP4 or MOV.` });
  const size = Number(request.headers.get("content-length"));
  if (!Number.isInteger(size) || size <= 0) return json(411, { error: "The upload needs a Content-Length." });
  if (size > max) return json(413, { error: `${type} files can be at most ${max / MB} MB here.` });
  if (!request.body) return json(400, { error: "Empty upload." });

  const claim = await store.claimUploadToken(hash);
  if (claim !== "claimed") return json(410, { error: "This upload link was already used or has expired. Ask Claude for a new one." });

  const name = safeName(decodeName(request.headers.get("x-file-name")), type);
  const key = `${UPLOAD_PREFIX}${new Date().toISOString().replace(/[:.]/g, "-")}-${randomToken(6)}-${name}`;
  try {
    const obj = await bucket.put(key, request.body, { httpMetadata: { contentType: type }, customMetadata: { name } });
    if (!obj || obj.size !== size) throw new Error("size mismatch");
  } catch {
    await bucket.delete(key).catch(() => {});
    await store.finishUploadToken(hash, false);
    return json(500, { error: "The upload did not finish. Try again with the same link." });
  }
  await store.finishUploadToken(hash, true);
  return json(201, { r2_key: key, bytes: size, mime_type: type });
}

function decodeName(raw: string | null): string {
  try {
    return raw ? decodeURIComponent(raw) : "";
  } catch {
    return "";
  }
}

const EXT: Record<string, string> = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "video/mp4": ".mp4", "video/quicktime": ".mov",
};

function safeName(name: string, type: string): string {
  const base = name.replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "file";
  return base + EXT[type];
}

function uploadPage(nonce: string): string {
  const accept = Object.keys(UPLOAD_TYPES).join(",");
  return layout(
    "Upload media for x-api-mcp",
    `<h2>Upload an image or video</h2>
<p>This link works once. The file is stored on this server so Claude can attach it to a post you approve.</p>
<p><input type="file" id="file" accept="${escapeHtml(accept)}"></p>
<p><button id="go" disabled>Upload</button></p>
<p id="status" role="status"></p>
<script nonce="${nonce}">
const file = document.getElementById("file");
const go = document.getElementById("go");
const status = document.getElementById("status");
file.addEventListener("change", () => { go.disabled = !file.files.length; status.textContent = ""; });
go.addEventListener("click", () => {
  const f = file.files[0];
  if (!f) return;
  go.disabled = true; file.disabled = true;
  const xhr = new XMLHttpRequest();
  xhr.open("PUT", location.pathname);
  xhr.setRequestHeader("Content-Type", f.type || "application/octet-stream");
  xhr.setRequestHeader("X-File-Name", encodeURIComponent(f.name));
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) status.textContent = "Uploading… " + Math.round(e.loaded / e.total * 100) + "%"; };
  xhr.onload = () => {
    let body = {};
    try { body = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status === 201) { status.textContent = "Uploaded. Go back to Claude and say it's done."; return; }
    status.textContent = body.error || ("Upload failed (" + xhr.status + ").");
    if (xhr.status === 500) { go.disabled = false; file.disabled = false; }
  };
  xhr.onerror = () => { status.textContent = "Upload failed. Check your connection and try again."; go.disabled = false; file.disabled = false; };
  xhr.send(f);
});
</script>`,
  );
}

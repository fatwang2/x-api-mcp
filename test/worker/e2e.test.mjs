// End-to-end test of the remote Worker: runs it with `wrangler dev` (workerd, local storage)
// against a mock X API, then walks the whole connector sign-in the way claude.ai would.
// No network, no Cloudflare account and no real credentials needed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const persist = fs.mkdtempSync(path.join(os.tmpdir(), "x-api-mcp-worker-"));
const calls = [];
const issued = new Map(); // access token -> user
const validRefresh = new Map(); // refresh token -> user (single use)
const revoked = [];
let seq = 0;
let mock;
let wrangler;
let base;

const USERS = { alice: "1001", bob: "2002", mallory: "666" };
// alice's tokens are always "about to expire", so every tool call refreshes and rotates them.
const EXPIRES = { alice: 60, bob: 7200, mallory: 7200 };
const SCOPE = "tweet.read tweet.write users.read follows.read follows.write like.read like.write offline.access media.write";

function issue(res, user) {
  const n = ++seq;
  issued.set(`at-${n}`, user);
  validRefresh.set(`rt-${n}`, user);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ token_type: "bearer", access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: EXPIRES[user], scope: SCOPE }));
}

const b64url = (b) => b.toString("base64url");

before(async () => {
  mock = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body, bytes: Buffer.concat(chunks).length });
    const json = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === "/2/oauth2/token") {
      // The Worker is a confidential client: it must authenticate with HTTP Basic.
      if (req.headers.authorization !== "Basic " + Buffer.from("test-client:test-secret").toString("base64")) {
        return json(401, { error: "unauthorized_client" });
      }
      const p = new URLSearchParams(body);
      if (p.get("grant_type") === "authorization_code") {
        assert.ok(p.get("code_verifier")?.length >= 43);
        assert.equal(p.get("redirect_uri"), `${base}/x/callback`);
        return issue(res, p.get("code").replace("code-", ""));
      }
      const user = validRefresh.get(p.get("refresh_token"));
      if (!user) return json(400, { error: "invalid_request", error_description: "Value passed for the token was invalid." });
      validRefresh.delete(p.get("refresh_token"));
      return issue(res, user);
    }
    if (url.pathname === "/2/oauth2/revoke") {
      revoked.push(new URLSearchParams(body).get("token"));
      return json(200, { revoked: true });
    }
    const user = issued.get((req.headers.authorization || "").replace("Bearer ", ""));
    if (!user) return json(401, { title: "Unauthorized", status: 401 });
    if (url.pathname === "/2/users/me") return json(200, { data: { id: USERS[user], name: user.toUpperCase(), username: user } });
    if (url.pathname === "/2/media/upload" && req.method === "POST") return json(200, { data: { id: `m${++seq}`, media_key: `3_m${seq}` } });
    if (url.pathname === "/2/media/metadata") return json(200, { data: { id: "ok" } });
    if (url.pathname === "/2/media/upload/initialize") return json(200, { data: { id: `v${++seq}` } });
    if (/^\/2\/media\/upload\/v\d+\/append$/.test(url.pathname)) return json(200, {});
    if (/^\/2\/media\/upload\/v\d+\/finalize$/.test(url.pathname)) {
      const id = url.pathname.split("/")[4];
      return json(200, { data: { id, processing_info: { state: "pending", check_after_secs: 1 } } });
    }
    if (url.pathname === "/2/media/upload" && req.method === "GET") {
      return json(200, { data: { id: url.searchParams.get("media_id"), processing_info: { state: "succeeded", progress_percent: 100 } } });
    }
    if (url.pathname === "/2/tweets" && req.method === "POST") {
      const { text } = JSON.parse(body);
      return json(201, { data: { id: `90${++seq}`, text } });
    }
    if (url.pathname === "/2/tweets/search/recent") return json(200, { data: [{ id: "1", text: "hi", author_id: USERS.alice }], includes: { users: [{ id: USERS.alice, username: "alice" }] }, meta: { result_count: 1 } });
    json(404, { detail: "not mocked " + url.pathname });
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const apiBase = `http://127.0.0.1:${mock.address().port}`;

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const vars = {
    X_PUBLIC_BASE_URL: base,
    X_API_BASE: apiBase,
    X_CLIENT_ID: "test-client",
    X_CLIENT_SECRET: "test-secret",
    ALLOWED_X_USER_IDS: USERS.alice,
    X_TOOLS: "all",
    X_MEDIA_WAIT_SECONDS: "0",
  };
  wrangler = spawn(
    process.execPath,
    [
      path.resolve("node_modules/wrangler/bin/wrangler.js"),
      "dev", "-c", "wrangler.jsonc", "--ip", "127.0.0.1", "--port", String(port),
      "--persist-to", persist, "--show-interactive-dev-session=false",
      ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
    ],
    { env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  wrangler.stdout.on("data", (d) => (log += d));
  wrangler.stderr.on("data", (d) => (log += d));
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      const r = await fetch(base + "/");
      if (r.ok) break;
    } catch {}
    if (wrangler.exitCode !== null || Date.now() > deadline) throw new Error("wrangler dev did not start:\n" + log);
    await new Promise((r) => setTimeout(r, 500));
  }
});

after(async () => {
  wrangler?.kill("SIGTERM");
  mock?.close();
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(persist, { recursive: true, force: true });
});

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Minimal cookie jar: keeps name=value pairs from Set-Cookie. */
class Jar {
  cookies = new Map();
  take(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim();
      if (attrs.some((a) => /max-age=0\b/i.test(a.trim()))) this.cookies.delete(name);
      else this.cookies.set(name, pair.slice(i + 1).trim());
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

const CLIENT_REDIRECT = "http://127.0.0.1:9/callback";

async function registerClient() {
  const r = await fetch(base + "/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Test Client", redirect_uris: [CLIENT_REDIRECT], token_endpoint_auth_method: "none" }),
  });
  assert.equal(r.status, 201);
  return (await r.json()).client_id;
}

/** Runs /authorize -> consent -> X -> /x/callback in one "browser". Returns the callback response. */
async function signIn(clientId, xUser, { jar = new Jar(), verifier } = {}) {
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: CLIENT_REDIRECT,
    code_challenge: challenge, code_challenge_method: "S256", state: "client-state", resource: `${base}/mcp`,
  });
  const page = await fetch(`${base}/authorize?${q}`, { redirect: "manual" });
  assert.equal(page.status, 200);
  jar.take(page);
  const html = await page.text();
  assert.match(html, /Test Client/);
  assert.match(html, /127\.0\.0\.1/);
  const handle = html.match(/name="handle" value="([^"]+)"/)[1];

  const approve = await fetch(`${base}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: new URLSearchParams({ handle, decision: "approve" }),
  });
  assert.equal(approve.status, 302);
  jar.take(approve);
  const toX = new URL(approve.headers.get("location"));
  assert.equal(toX.origin + toX.pathname, "https://x.com/i/oauth2/authorize");
  assert.equal(toX.searchParams.get("client_id"), "test-client");
  assert.equal(toX.searchParams.get("redirect_uri"), `${base}/x/callback`);
  assert.equal(toX.searchParams.get("code_challenge_method"), "S256");

  // X approves and sends the browser back.
  const cb = await fetch(`${base}/x/callback?state=${encodeURIComponent(toX.searchParams.get("state"))}&code=code-${xUser}`, {
    redirect: "manual",
    headers: { cookie: jar.header() },
  });
  return { cb, handle, jar };
}

async function token(clientId, code, verifier) {
  const r = await fetch(base + "/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CLIENT_REDIRECT, client_id: clientId, code_verifier: verifier }),
  });
  assert.equal(r.status, 200);
  return (await r.json()).access_token;
}

let rpcId = 0;
async function mcp(accessToken, method, params = {}) {
  const r = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  assert.equal(r.status, 200, await r.clone().text());
  const body = await r.json();
  assert.equal(body.error, undefined, JSON.stringify(body.error));
  return body.result;
}

const toolJson = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};

let accessToken;

test("unauthenticated /mcp points clients to the OAuth metadata", async () => {
  const r = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate"), /resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource\/mcp"/);
  const meta = await (await fetch(base + "/.well-known/oauth-authorization-server")).json();
  assert.equal(meta.authorization_endpoint, `${base}/authorize`);
  assert.equal(meta.registration_endpoint, `${base}/register`);
});

test("allowlisted X account signs in, gets stored, and can use read tools", async () => {
  const clientId = await registerClient();
  const verifier = b64url(crypto.randomBytes(32));
  const { cb } = await signIn(clientId, "alice", { verifier });
  assert.equal(cb.status, 302);
  const back = new URL(cb.headers.get("location"));
  assert.equal(back.origin + back.pathname, CLIENT_REDIRECT);
  assert.equal(back.searchParams.get("state"), "client-state");
  accessToken = await token(clientId, back.searchParams.get("code"), verifier);

  const init = await mcp(accessToken, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(init.serverInfo.name, "x-api-mcp");
  assert.match(init.instructions, /confirm/i, "the server tells the model to confirm visible actions");

  const names = (await mcp(accessToken, "tools/list")).tools.map((t) => t.name);
  assert.ok(names.includes("get_me"));
  assert.ok(names.includes("search"));
  assert.ok(names.includes("list_accounts"));
  for (const local of ["set_client_id", "complete_authorization"]) assert.ok(!names.includes(local), local);
  for (const remote of ["create_post", "add_account", "auth_status", "get_write_log"]) assert.ok(names.includes(remote), remote);

  const accounts = toolJson(await mcp(accessToken, "tools/call", { name: "list_accounts", arguments: {} }));
  assert.equal(accounts.default_account, "alice");
  assert.equal(accounts.accounts[0].user_id, USERS.alice);

  const me = toolJson(await mcp(accessToken, "tools/call", { name: "get_me", arguments: {} }));
  assert.equal(me.username, "alice");
});

test("concurrent tool calls share the Durable Object lock, so refresh-token rotation never collides", async () => {
  const before = calls.filter((c) => c.path === "/2/oauth2/token").length;
  const results = await Promise.all(
    [1, 2, 3].map(() => mcp(accessToken, "tools/call", { name: "get_me", arguments: { account: "alice" } })),
  );
  for (const r of results) assert.equal(toolJson(r).username, "alice");
  // alice's tokens expire inside the refresh margin, so each call refreshed once, one after another.
  assert.equal(calls.filter((c) => c.path === "/2/oauth2/token").length - before, 3);
});

test("an X account that is not on the allowlist is turned away and nothing is stored", async () => {
  const clientId = await registerClient();
  const { cb } = await signIn(clientId, "mallory", { verifier: b64url(crypto.randomBytes(32)) });
  assert.equal(cb.status, 403);
  const refusal = await cb.text();
  assert.match(refusal, /not on this server&#39;s allowlist/);
  assert.match(refusal, new RegExp(`X user ID ${USERS.mallory}`), "the page shows the ID to add");
  assert.ok(revoked.some((t) => issued.get(t) === "mallory"), "mallory's token was revoked");
  const accounts = toolJson(await mcp(accessToken, "tools/call", { name: "list_accounts", arguments: {} }));
  assert.deepEqual(accounts.accounts.map((a) => a.username), ["alice"]);
});

test("the consent form can't be submitted from another browser", async () => {
  const clientId = await registerClient();
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CLIENT_REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s" });
  const page = await fetch(`${base}/authorize?${q}`);
  const handle = (await page.text()).match(/name="handle" value="([^"]+)"/)[1];
  // Same handle, but without the browser-binding cookie set with the page.
  const r = await fetch(`${base}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ handle, decision: "approve" }),
  });
  assert.equal(r.status, 400);
  assert.equal(r.headers.get("location"), null);
});

test("write tools carry annotations, need an explicit account, and land in the write log", async () => {
  const tools = (await mcp(accessToken, "tools/list")).tools;
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName.create_post.annotations.readOnlyHint, false);
  assert.equal(byName.create_post.annotations.destructiveHint, false);
  assert.equal(byName.delete_post.annotations.destructiveHint, true);
  assert.match(byName.delete_post.description, /confirm/i);
  assert.ok(byName.create_post.inputSchema.required.includes("account"), "X_REQUIRE_ACCOUNT defaults on");

  const missing = await mcp(accessToken, "tools/call", { name: "create_post", arguments: { text: "no account" } });
  assert.equal(missing.isError, true);
  assert.ok(!calls.some((c) => c.path === "/2/tweets" && c.body.includes("no account")), "nothing was posted");

  const posted = toolJson(await mcp(accessToken, "tools/call", { name: "create_post", arguments: { account: "alice", text: "hello from the worker" } }));
  assert.ok(posted.id);

  const log = toolJson(await mcp(accessToken, "tools/call", { name: "get_write_log", arguments: {} }));
  const entries = log.entries ?? log;
  assert.equal(entries[0].tool, "create_post");
  assert.equal(entries[0].account, "alice");
  assert.deepEqual(entries[0].result_ids, [posted.id]);
  assert.equal(entries.length, 1, "the refused call was not logged as a write");
});

test("add_account gives a sign-in link and the X callback adds the second account", async () => {
  const started = toolJson(await mcp(accessToken, "tools/call", { name: "add_account", arguments: {} }));
  const link = new URL(started.authorize_url);
  assert.equal(link.origin + link.pathname, "https://x.com/i/oauth2/authorize");
  assert.equal(link.searchParams.get("redirect_uri"), `${base}/x/callback`);
  assert.equal(link.searchParams.get("state"), started.state);
  assert.equal(toolJson(await mcp(accessToken, "tools/call", { name: "auth_status", arguments: { state: started.state } })).status, "pending");

  // bob is not on the allowlist, but the signed-in owner may still add him as an account to act as.
  const cb = await fetch(`${base}/x/callback?state=${encodeURIComponent(started.state)}&code=code-bob`, { redirect: "manual" });
  assert.equal(cb.status, 200);
  assert.match(await cb.text(), /@bob is connected/);

  const status = toolJson(await mcp(accessToken, "tools/call", { name: "auth_status", arguments: { state: started.state } }));
  assert.equal(status.status, "done");
  assert.equal(status.result.username, "bob");
  assert.equal(status.result.is_default, false);

  const replay = await fetch(`${base}/x/callback?state=${encodeURIComponent(started.state)}&code=code-bob`, { redirect: "manual" });
  assert.notEqual(replay.status, 200, "a used add_account link can't be replayed");

  const accounts = toolJson(await mcp(accessToken, "tools/call", { name: "list_accounts", arguments: {} }));
  assert.deepEqual(accounts.accounts.map((a) => a.username).sort(), ["alice", "bob"]);
  assert.equal(accounts.default_account, "alice");
});

const MB = 1024 * 1024;

async function newUploadLink() {
  const link = toolJson(await mcp(accessToken, "tools/call", { name: "create_upload_link", arguments: {} }));
  assert.match(link.upload_url, new RegExp(`^${base}/upload/[A-Za-z0-9_-]{40,}$`));
  return link.upload_url;
}

const put = (url, body, type, name) =>
  fetch(url, { method: "PUT", body, headers: { "content-type": type, ...(name ? { "x-file-name": encodeURIComponent(name) } : {}) } });

test("an upload link stores one file in R2, and create_post attaches it by r2_key", async () => {
  const url = await newUploadLink();
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /script-src 'nonce-[^']+'/);
  assert.match(await page.text(), /type="file"/);

  assert.equal((await put(url, "<html>", "text/html")).status, 415, "wrong type is refused without using up the link");
  assert.equal((await put(url, new Uint8Array(6 * MB), "image/png")).status, 413, "images over 5 MB are refused");

  const up = await put(url, new Uint8Array(1024).fill(7), "image/png", "My Cat!.png");
  assert.equal(up.status, 201);
  const { r2_key } = await up.json();
  assert.match(r2_key, /^uploads\/.+-My-Cat\.png$/);

  assert.equal((await put(url, new Uint8Array(10), "image/png")).status, 410, "the link works once");
  assert.equal((await fetch(url)).status, 410);

  const listed = toolJson(await mcp(accessToken, "tools/call", { name: "list_uploads", arguments: {} }));
  assert.equal(listed.uploads[0].r2_key, r2_key);
  assert.equal(listed.uploads[0].bytes, 1024);
  assert.equal(listed.uploads[0].mime_type, "image/png");

  const posted = toolJson(await mcp(accessToken, "tools/call", { name: "create_post", arguments: { account: "alice", text: "pic", media_files: [{ r2_key, alt_text: "a cat" }] } }));
  const media = calls.findLast((c) => c.path === "/2/media/upload" && c.method === "POST");
  assert.ok(media.bytes > 1024, "the image went to X as a multipart upload");
  const tweet = JSON.parse(calls.findLast((c) => c.path === "/2/tweets").body);
  assert.equal(tweet.media.media_ids.length, 1);
  assert.deepEqual(posted.media_ids, tweet.media.media_ids);
  assert.ok(calls.some((c) => c.path === "/2/media/metadata"), "alt text was set");
});

test("videos stream to X in 4 MB segments, and posting waits for processing instead of hanging", async () => {
  const url = await newUploadLink();
  const up = await put(url, new Uint8Array(9 * MB).fill(1), "video/mp4", "clip.mp4");
  assert.equal(up.status, 201);
  const { r2_key } = await up.json();

  const r = toolJson(await mcp(accessToken, "tools/call", { name: "upload_media", arguments: { account: "alice", r2_key } }));
  assert.equal(r.method, "chunked");
  assert.equal(r.media_category, "tweet_video");
  assert.match(r.note, /get_media_status/);
  const init = JSON.parse(calls.findLast((c) => c.path === "/2/media/upload/initialize").body);
  assert.deepEqual(init, { media_type: "video/mp4", total_bytes: 9 * MB, media_category: "tweet_video" });
  const appends = calls.filter((c) => c.path === `/2/media/upload/${r.media_id}/append`);
  assert.equal(appends.length, 3);
  assert.ok(appends[0].bytes > 4 * MB && appends[0].bytes < 4 * MB + 4096, "each segment is 4 MB plus form overhead");
  assert.ok(appends[2].bytes < 1 * MB + 4096);

  const tweetsBefore = calls.filter((c) => c.path === "/2/tweets").length;
  const blocked = await mcp(accessToken, "tools/call", { name: "create_post", arguments: { account: "alice", text: "vid", media_files: [{ r2_key }] } });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /still being processed/);
  assert.equal(calls.filter((c) => c.path === "/2/tweets").length, tweetsBefore, "nothing was posted");

  const status = toolJson(await mcp(accessToken, "tools/call", { name: "get_media_status", arguments: { account: "alice", media_id: r.media_id } }));
  assert.equal(status.processing_info.state, "succeeded");
  const posted = toolJson(await mcp(accessToken, "tools/call", { name: "create_post", arguments: { account: "alice", text: "vid", media_ids: [r.media_id] } }));
  assert.deepEqual(posted.media_ids, [r.media_id]);
});

test("remote media sources: no file_path, https-only public media_url, small base64", async () => {
  const tools = (await mcp(accessToken, "tools/list")).tools;
  const upload = tools.find((t) => t.name === "upload_media").inputSchema.properties;
  assert.ok(upload.r2_key && upload.media_url && upload.base64);
  assert.equal(upload.file_path, undefined, "the Worker can't read local files");
  const item = tools.find((t) => t.name === "create_post").inputSchema.properties.media_files.items.properties;
  assert.deepEqual(Object.keys(item).sort(), ["alt_text", "media_url", "r2_key"]);

  const call = (args) => mcp(accessToken, "tools/call", { name: "upload_media", arguments: { account: "alice", ...args } });
  for (const [args, msg] of [
    [{ media_url: "http://example.com/a.png" }, /https/],
    [{ media_url: "https://169.254.169.254/latest/meta-data" }, /public host/],
    [{ media_url: "https://localhost/a.png" }, /public host/],
    [{ base64: Buffer.alloc(2.5 * MB).toString("base64"), mime_type: "image/png" }, /limited to 2 MB/],
    [{ r2_key: "../tokens" }, /list_uploads/],
    [{ r2_key: "uploads/missing.png" }, /No upload/],
    [{}, /exactly one media source/],
  ]) {
    const r = await call(args);
    assert.equal(r.isError, true, JSON.stringify(args).slice(0, 80));
    assert.match(r.content[0].text, msg);
  }

  const ok = toolJson(await call({ base64: "data:image/png;base64," + Buffer.alloc(300, 9).toString("base64") }));
  assert.equal(ok.method, "simple");
  assert.equal(ok.bytes, 300);
});

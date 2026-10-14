// End-to-end tests against a local mock of the X API. No network or real credentials needed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "x-api-mcp-test-"));
const calls = [];
let tokenSeq = 0;
let posts = 0;
const issued = new Map(); // access token -> username
const validRefresh = new Map(); // refresh token -> username (rotated on use)
let mock;
let apiBase;

function readBody(req) {
  return new Promise((r) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => r(Buffer.concat(chunks)));
  });
}

function issue(res, username, status = 200) {
  const n = ++tokenSeq;
  const access = `at-${n}`;
  const refresh = `rt-${n}`;
  issued.set(access, username);
  validRefresh.set(refresh, username);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ token_type: "bearer", access_token: access, refresh_token: refresh, expires_in: 7200, scope: "tweet.read tweet.write users.read media.write offline.access" }));
}

before(async () => {
  mock = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const body = await readBody(req);
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
    const json = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === "/2/oauth2/token") {
      const p = new URLSearchParams(body.toString());
      if (p.get("grant_type") === "authorization_code") {
        assert.ok(p.get("code_verifier")?.length >= 43);
        return issue(res, p.get("code").replace("code-", ""));
      }
      const user = validRefresh.get(p.get("refresh_token"));
      if (!user) return json(400, { error: "invalid_request", error_description: "Value passed for the token was invalid." });
      validRefresh.delete(p.get("refresh_token")); // rotation: single use
      return issue(res, user);
    }
    if (url.pathname === "/2/oauth2/revoke") return json(200, { revoked: true });
    const user = issued.get((req.headers.authorization || "").replace("Bearer ", ""));
    if (!user) return json(401, { title: "Unauthorized", detail: "Unauthorized", status: 401 });
    if (url.pathname === "/2/users/me") return json(200, { data: { id: `id-${user}`, name: user.toUpperCase(), username: user } });
    if (url.pathname === "/2/tweets" && req.method === "POST") {
      const b = JSON.parse(body.toString());
      if (b.text === "fail") return json(403, { detail: "You are not allowed to create a Post with duplicate content.", status: 403 });
      const id = String(1000 + ++posts);
      return json(201, { data: { id, text: b.text ?? "", edit_history_tweet_ids: [id] } });
    }
    if (url.pathname.startsWith("/2/tweets/") && req.method === "DELETE") return json(200, { data: { deleted: true } });
    if (url.pathname === "/2/media/upload" && req.method === "POST") return json(200, { data: { id: "555", media_key: "3_555" } });
    if (url.pathname === "/2/media/upload/initialize") return json(200, { data: { id: "777", media_key: "7_777", expires_after_secs: 86400 } });
    if (/^\/2\/media\/upload\/777\/append$/.test(url.pathname)) return json(200, {});
    if (/^\/2\/media\/upload\/777\/finalize$/.test(url.pathname)) return json(200, { data: { id: "777", processing_info: { state: "pending", check_after_secs: 1 } } });
    if (url.pathname === "/2/media/upload" && req.method === "GET") return json(200, { data: { id: "777", processing_info: { state: "succeeded", progress_percent: 100 } } });
    if (url.pathname === "/2/media/metadata") return json(200, { data: { id: JSON.parse(body.toString()).id } });
    if (url.pathname === "/2/tweets/search/recent") return json(200, { data: [{ id: "1", text: "hi", author_id: "u1" }], includes: { users: [{ id: "u1", username: "alice", name: "Alice" }] }, meta: { result_count: 1 } });
    json(404, { detail: "not mocked " + url.pathname });
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  apiBase = `http://127.0.0.1:${mock.address().port}`;
  Object.assign(process.env, {
    X_API_MCP_HOME: home,
    X_API_BASE: apiBase,
    X_CLIENT_ID: "test-client",
    X_REDIRECT_URI: "http://127.0.0.1:18765/callback",
    X_AUTHORIZE_URL: "https://x.com/i/oauth2/authorize",
  });
});

after(() => {
  mock.close();
  fs.rmSync(home, { recursive: true, force: true });
});

async function setup() {
  const { loadConfig } = await import("../dist/config.js");
  const { TokenStore } = await import("../dist/store.js");
  const { XClient } = await import("../dist/client.js");
  const { AuthManager } = await import("../dist/auth.js");
  const cfg = loadConfig();
  const client = new XClient(cfg, new TokenStore(cfg.homeDir));
  return { cfg, client, auth: new AuthManager(client) };
}

async function login(auth, username) {
  const r = await auth.start();
  assert.equal(r.listening, true);
  const u = new URL(r.authorize_url);
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.match(u.searchParams.get("scope"), /offline\.access/);
  // Simulate the browser being redirected back to the loopback listener.
  const cb = await fetch(`http://127.0.0.1:18765/callback?state=${r.state}&code=code-${username}`);
  assert.equal(cb.status, 200);
  const s = await auth.wait(r.state, 5000);
  assert.equal(s.status, "done");
  return s.result;
}

test("multi-account OAuth via loopback, default account, file permissions", async () => {
  const { client, auth } = await setup();
  const a = await login(auth, "alice");
  assert.equal(a.is_default, true);
  const b = await login(auth, "bob");
  assert.equal(b.is_default, false);
  auth.close();
  const data = client.store.read();
  assert.deepEqual(Object.keys(data.accounts).sort(), ["alice", "bob"]);
  assert.equal(data.default_account, "alice");
  assert.equal(fs.statSync(path.join(home, "tokens.json")).mode & 0o777, 0o600);
  assert.equal(client.resolveAccount(), "alice");
  assert.equal(client.resolveAccount("@Bob"), "bob");
  assert.throws(() => client.resolveAccount("carol"), /not authorized/);
});

test("post, reply thread with partial failure, delete", async () => {
  const { client } = await setup();
  const { createPost, createThread, deletePost } = await import("../dist/posts.js");
  const p = await createPost(client, { account: "bob", text: "hello" });
  assert.equal(p.url, `https://x.com/bob/status/${p.id}`);
  const last = calls.findLast((c) => c.path === "/2/tweets");
  assert.equal(issued.get(last.headers.authorization.slice(7)), "bob");

  const t = await createThread(client, { posts: [{ text: "1/3" }, { text: "2/3" }, { text: "fail" }] });
  assert.equal(t.complete, false);
  assert.equal(t.posted.length, 2);
  assert.equal(t.error.index, 2);
  const threadCalls = calls.filter((c) => c.path === "/2/tweets").slice(-3).map((c) => JSON.parse(c.body.toString()));
  assert.equal(threadCalls[0].reply, undefined);
  assert.equal(threadCalls[1].reply.in_reply_to_tweet_id, t.posted[0].id);
  assert.equal(threadCalls[2].reply.in_reply_to_tweet_id, t.posted[1].id);

  assert.deepEqual(await deletePost(client, "alice", p.id), { post_id: p.id, deleted: true });
});

test("expired token refreshes once and rotates the refresh token", async () => {
  const { client } = await setup();
  const d = client.store.read();
  const oldRefresh = d.accounts.alice.refresh_token;
  d.accounts.alice.expires_at = Date.now() - 1000;
  client.store.write(d);
  const { getMe } = await import("../dist/posts.js");
  const me = await getMe(client, "alice");
  assert.equal(me.username, "alice");
  const after = client.store.read().accounts.alice;
  assert.notEqual(after.refresh_token, oldRefresh);
  assert.ok(after.expires_at > Date.now());

  // A 401 with a still-"valid" expiry forces one refresh and a retry.
  issued.delete(after.access_token);
  const me2 = await getMe(client, "alice");
  assert.equal(me2.username, "alice");
});

test("concurrent refreshes from two clients use the refresh token only once", async () => {
  const a = await setup();
  const b = await setup();
  const d = a.client.store.read();
  d.accounts.bob.expires_at = Date.now() - 1000;
  a.client.store.write(d);
  const before = calls.filter((c) => c.path === "/2/oauth2/token").length;
  const [t1, t2] = await Promise.all([a.client.getAccessToken("bob"), b.client.getAccessToken("bob")]);
  assert.equal(t1, t2);
  assert.equal(calls.filter((c) => c.path === "/2/oauth2/token").length - before, 1);
});

test("media: simple image with alt text, chunked video with processing", async () => {
  const { client } = await setup();
  const { uploadMedia } = await import("../dist/media.js");
  const img = path.join(home, "a.png");
  fs.writeFileSync(img, Buffer.alloc(1024, 1));
  const r1 = await uploadMedia(client, { file_path: img, alt_text: "a cat" });
  assert.deepEqual([r1.media_id, r1.method, r1.media_category, r1.alt_text_set], ["555", "simple", "tweet_image", true]);
  const up = calls.findLast((c) => c.path === "/2/media/upload" && c.method === "POST");
  assert.match(up.headers["content-type"], /multipart\/form-data/);

  const vid = path.join(home, "v.mp4");
  fs.writeFileSync(vid, Buffer.alloc(9 * 1024 * 1024, 2));
  const r2 = await uploadMedia(client, { account: "bob", file_path: vid });
  assert.deepEqual([r2.media_id, r2.method, r2.media_category], ["777", "chunked", "tweet_video"]);
  const appends = calls.filter((c) => c.path === "/2/media/upload/777/append");
  assert.equal(appends.length, 3);
  const init = JSON.parse(calls.find((c) => c.path === "/2/media/upload/initialize").body.toString());
  assert.deepEqual(init, { media_type: "video/mp4", total_bytes: 9 * 1024 * 1024, media_category: "tweet_video" });
  assert.ok(calls.some((c) => c.method === "GET" && c.query.command === "STATUS"));
});

test("stdio MCP server lists tools and posts through tools/call", async () => {
  const child = spawn(process.execPath, [path.resolve("dist/index.js")], { env: process.env, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      pending.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const rpc = (method, params) =>
    new Promise((r) => {
      const n = ++id;
      pending.set(n, r);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    });
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(init.result.serverInfo.name, "x-api-mcp");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const list = await rpc("tools/list", {});
  const names = list.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "add_account", "auth_status", "complete_authorization", "create_post", "create_thread", "delete_post",
    "get_me", "get_media_status", "list_accounts", "remove_account", "search_recent_posts", "set_default_account", "upload_media",
  ]);
  const post = await rpc("tools/call", { name: "create_post", arguments: { account: "bob", text: "via mcp" } });
  assert.equal(post.result.isError, undefined);
  assert.equal(JSON.parse(post.result.content[0].text).account, "bob");
  const bad = await rpc("tools/call", { name: "create_post", arguments: { account: "nobody", text: "x" } });
  assert.equal(bad.result.isError, true);
  const search = await rpc("tools/call", { name: "search_recent_posts", arguments: { query: "hi" } });
  assert.equal(JSON.parse(search.result.content[0].text).posts[0].url, "https://x.com/alice/status/1");
  const rm = await rpc("tools/call", { name: "remove_account", arguments: { account: "alice" } });
  assert.deepEqual(JSON.parse(rm.result.content[0].text), { removed: "alice", revoked: true });
  child.kill();
});

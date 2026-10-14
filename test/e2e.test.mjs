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
const SCOPES = "tweet.read tweet.write tweet.moderate.write users.read follows.read follows.write like.read like.write bookmark.read bookmark.write mute.read mute.write block.read block.write list.read list.write dm.read dm.write media.write offline.access";
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
  res.end(JSON.stringify({ token_type: "bearer", access_token: access, refresh_token: refresh, expires_in: 7200, scope: SCOPES }));
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
    let m;
    if ((m = url.pathname.match(/^\/2\/users\/by\/username\/(\w+)$/))) return json(200, { data: { id: `id-${m[1]}`, username: m[1], name: m[1] } });
    if ((m = url.pathname.match(/^\/2\/users\/[^/]+\/(likes|retweets|bookmarks|following|muting)$/)) && req.method === "POST") {
      const key = { likes: "liked", retweets: "retweeted", bookmarks: "bookmarked", following: "following", muting: "muting" }[m[1]];
      return json(200, { data: { [key]: true } });
    }
    if ((m = url.pathname.match(/^\/2\/users\/[^/]+\/(likes|retweets|bookmarks|following|muting)\/[^/]+$/)) && req.method === "DELETE") return json(200, { data: { ok: false } });
    if (/^\/2\/tweets\/\d+\/hidden$/.test(url.pathname) && req.method === "PUT") return json(200, { data: { hidden: JSON.parse(body.toString()).hidden } });
    if (/^\/2\/users\/[^/]+\/(tweets|mentions|liked_tweets|bookmarks|timelines\/reverse_chronological)$/.test(url.pathname)) {
      return json(200, { data: [{ id: "9", text: "t", author_id: "u1", attachments: { media_keys: ["3_1"] } }], includes: { users: [{ id: "u1", username: "alice" }], media: [{ media_key: "3_1", type: "photo" }] }, meta: { result_count: 1, next_token: "n" } });
    }
    if (/^\/2\/users\/[^/]+\/(followers|following)$/.test(url.pathname)) return json(200, { data: [{ id: "u2", username: "carol" }], meta: { result_count: 1 } });
    if (/^\/2\/dm_conversations\/with\/[^/]+\/messages$/.test(url.pathname)) return json(201, { data: { dm_conversation_id: "c1", dm_event_id: "e1" } });
    if (url.pathname === "/2/lists" && req.method === "POST") return json(201, { data: { id: "L1", name: JSON.parse(body.toString()).name } });
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

test("interactions, relationships, timelines, DMs, lists and scope checks", async () => {
  const { client } = await setup();
  const S = await import("../dist/social.js");
  const like = await S.postAction(client, { account: "bob", action: "like", post_id: "42" });
  assert.deepEqual(like.result, { liked: true });
  let c = calls.at(-1);
  assert.equal(c.path, "/2/users/id-bob/likes");
  assert.deepEqual(JSON.parse(c.body.toString()), { tweet_id: "42" });
  await S.postAction(client, { account: "bob", action: "unrepost", post_id: "42" });
  assert.equal(calls.at(-1).method + " " + calls.at(-1).path, "DELETE /2/users/id-bob/retweets/42");
  const hide = await S.postAction(client, { account: "bob", action: "hide_reply", post_id: "43" });
  assert.deepEqual(hide.result, { hidden: true });

  // Locally known accounts resolve without an API call; others are looked up by username.
  const before = calls.length;
  const f1 = await S.userAction(client, { account: "bob", action: "follow", user: "@alice" });
  assert.equal(f1.user_id, "id-alice");
  assert.equal(calls.length - before, 1);
  const f2 = await S.userAction(client, { account: "bob", action: "follow", user: "@jack" });
  assert.equal(f2.user_id, "id-jack");
  assert.equal(calls.at(-2).path, "/2/users/by/username/jack");
  assert.deepEqual(JSON.parse(calls.at(-1).body.toString()), { target_user_id: "id-jack" });
  await S.userAction(client, { account: "bob", action: "unmute", user: "12345" });
  assert.equal(calls.at(-1).path, "/2/users/id-bob/muting/12345");

  const home = await S.getTimeline(client, { account: "bob", type: "home", exclude: ["replies"] });
  assert.equal(calls.at(-1).path, "/2/users/id-bob/timelines/reverse_chronological");
  assert.equal(calls.at(-1).query.exclude, "replies");
  assert.equal(home.posts[0].url, "https://x.com/alice/status/9");
  assert.equal(home.posts[0].media[0].type, "photo");
  await S.getTimeline(client, { account: "bob", type: "posts", user: "alice", max_results: 1 });
  assert.equal(calls.at(-1).path, "/2/users/id-alice/tweets");
  assert.equal(calls.at(-1).query.max_results, "5");
  await assert.rejects(S.getTimeline(client, { account: "bob", type: "bookmarks", user: "alice" }), /only available/);

  const rel = await S.getUserRelations(client, { account: "bob", type: "followers", user: "alice" });
  assert.equal(rel.users[0].username, "carol");

  const dm = await S.sendDm(client, { account: "bob", to: "@alice", text: "hi" });
  assert.deepEqual(dm, { dm_conversation_id: "c1", dm_event_id: "e1" });
  assert.equal(calls.at(-1).path, "/2/dm_conversations/with/id-alice/messages");
  await assert.rejects(S.sendDm(client, { account: "bob", text: "hi" }), /exactly one/);

  const list = await S.listAction(client, { account: "bob", action: "create", name: "friends", private: true });
  assert.equal(list.result.id, "L1");

  // An account authorized with fewer scopes gets an actionable error before any API call.
  const d = client.store.read();
  d.accounts.bob.scope = "tweet.read tweet.write users.read offline.access";
  client.store.write(d);
  const n = calls.length;
  await assert.rejects(S.postAction(client, { account: "bob", action: "like", post_id: "1" }), /without scope\(s\) like\.write.*add_account/);
  assert.equal(calls.length, n);
  d.accounts.bob.scope = SCOPES;
  client.store.write(d);
});

async function withServer(extraEnv, fn) {
  const child = spawn(process.execPath, [path.resolve("dist/index.js")], {
    env: { ...process.env, ...extraEnv },
    stdio: ["pipe", "pipe", "inherit"],
  });
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
  const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
  try {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.equal(init.result.serverInfo.name, "x-api-mcp");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools = (await rpc("tools/list", {})).result.tools.map((t) => t.name).sort();
    await fn({ tools, call });
  } finally {
    child.kill();
  }
}

const ACCOUNT_TOOLS = ["add_account", "auth_status", "complete_authorization", "list_accounts", "remove_account", "set_client_id", "set_default_account"];
const WRITE_TOOLS = ["create_post", "create_thread", "delete_post", "get_media_status", "list_action", "post_action", "upload_media", "user_action"];
const READ_TOOLS = ["get_lists", "get_me", "get_post_engagement", "get_posts", "get_timeline", "get_trends", "get_user_relations", "get_users", "search"];

test("tool groups: default has no DM tools, X_ENABLE_DM adds them, X_TOOLS=write drops reads", async () => {
  await withServer({}, async ({ tools }) => {
    assert.deepEqual(tools, [...ACCOUNT_TOOLS, ...WRITE_TOOLS, ...READ_TOOLS].sort());
  });
  await withServer({ X_ENABLE_DM: "1" }, async ({ tools }) => {
    assert.deepEqual(tools, [...ACCOUNT_TOOLS, ...WRITE_TOOLS, ...READ_TOOLS, "get_dm_events", "send_dm"].sort());
  });
  await withServer({ X_TOOLS: "write", X_ENABLE_DM: "true" }, async ({ tools }) => {
    assert.deepEqual(tools, [...ACCOUNT_TOOLS, ...WRITE_TOOLS, "send_dm"].sort());
  });
});

test("X_REQUIRE_ACCOUNT refuses write calls without an explicit account", async () => {
  await withServer({ X_REQUIRE_ACCOUNT: "1" }, async ({ call }) => {
    const r = await call("create_post", { text: "no account" });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /account/);
    const ok = await call("create_post", { account: "bob", text: "explicit" });
    assert.equal(ok.isError, undefined);
    // Reads still fall back to the default account.
    const read = await call("search", { query: "hi" });
    assert.equal(read.isError, undefined);
  });
});

test("paste auth mode skips the listener and set_client_id configures the app at runtime", async () => {
  const { loadConfig } = await import("../dist/config.js");
  assert.equal(loadConfig({ X_AUTH_MODE: "paste" }).authMode, "paste");
  assert.equal(loadConfig({ SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" }).authMode, "paste");
  assert.equal(loadConfig({}).authMode, "loopback");
  assert.ok(!loadConfig({}).scopes.includes("dm.write"));
  assert.ok(loadConfig({ X_ENABLE_DM: "1" }).scopes.includes("dm.write"));
  assert.equal(loadConfig({ X_CLIENT_ID: "${user_config.client_id}" }).clientId, undefined);

  const noId = { X_CLIENT_ID: "", X_AUTH_MODE: "paste" };
  await withServer(noId, async ({ call }) => {
    const before = await call("add_account", {});
    assert.equal(before.isError, true);
    assert.match(before.content[0].text, /set_client_id/);
    const saved = await call("set_client_id", { client_id: "runtime-client" });
    assert.equal(JSON.parse(saved.content[0].text).active, true);
    const r = JSON.parse((await call("add_account", {})).content[0].text);
    assert.equal(r.mode, "paste");
    assert.equal(r.listening, false);
    assert.equal(new URL(r.authorize_url).searchParams.get("client_id"), "runtime-client");
    assert.match(r.note, /paste/);
    // The pasted callback URL completes the authorization.
    const done = await call("complete_authorization", { redirect_url: `http://127.0.0.1:18765/callback?state=${r.state}&code=code-dave` });
    assert.equal(JSON.parse(done.content[0].text).username, "dave");
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "app.json"), "utf8")).client_id, "runtime-client");
  assert.equal(fs.statSync(path.join(home, "app.json")).mode & 0o777, 0o600);
});

test("stdio MCP server posts, searches and removes accounts through tools/call", async () => {
  await withServer({}, async ({ call }) => {
    const post = await call("create_post", { account: "bob", text: "via mcp" });
    assert.equal(post.isError, undefined);
    assert.equal(JSON.parse(post.content[0].text).account, "bob");
    const bad = await call("create_post", { account: "nobody", text: "x" });
    assert.equal(bad.isError, true);
    const search = await call("search", { query: "hi" });
    assert.equal(JSON.parse(search.content[0].text).posts[0].url, "https://x.com/alice/status/1");
    const rm = await call("remove_account", { account: "alice" });
    assert.deepEqual(JSON.parse(rm.content[0].text), { removed: "alice", revoked: true });
  });
});

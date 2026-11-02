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

const USERS = { alice: "1001", mallory: "666" };
// alice's tokens are always "about to expire", so every tool call refreshes and rotates them.
const EXPIRES = { alice: 60, mallory: 7200 };

function issue(res, user) {
  const n = ++seq;
  issued.set(`at-${n}`, user);
  validRefresh.set(`rt-${n}`, user);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ token_type: "bearer", access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: EXPIRES[user], scope: "tweet.read users.read offline.access" }));
}

const b64url = (b) => b.toString("base64url");

before(async () => {
  mock = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    calls.push({ method: req.method, path: url.pathname, headers: req.headers, body });
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
    X_TOOLS: "read",
  };
  wrangler = spawn(
    process.execPath,
    [
      path.resolve("node_modules/wrangler/bin/wrangler.js"),
      "dev", "-c", "wrangler.example.toml", "--ip", "127.0.0.1", "--port", String(port),
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

  const names = (await mcp(accessToken, "tools/list")).tools.map((t) => t.name);
  assert.ok(names.includes("get_me"));
  assert.ok(names.includes("search"));
  assert.ok(names.includes("list_accounts"));
  for (const local of ["set_client_id", "add_account", "auth_status", "complete_authorization"]) assert.ok(!names.includes(local), local);
  assert.ok(!names.includes("create_post"), "X_TOOLS=read leaves out write tools");

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
  assert.match(await cb.text(), /not on this server&#39;s allowlist/);
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

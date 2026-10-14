import http from "node:http";
import { XClient } from "./client.js";
import { requireClientId } from "./config.js";
import { describeError, parseBody } from "./errors.js";
import { buildAuthorizeUrl, createPkce, exchangeCode, randomState, revokeToken } from "./oauth.js";
import { Account, accountKey } from "./store.js";

const PENDING_TTL_MS = 15 * 60_000;

export interface AuthResult {
  username: string;
  user_id: string;
  name?: string;
  scope?: string;
  has_refresh_token: boolean;
  is_default: boolean;
}

type SessionState =
  | { status: "pending" }
  | { status: "done"; result: AuthResult }
  | { status: "error"; error: string };

/**
 * OAuth 2.0 Authorization Code + PKCE for adding accounts. A loopback listener on the
 * redirect URI catches the callback automatically (X authorization codes expire ~30s
 * after issue, so manual copy/paste is a fallback only).
 */
export class AuthManager {
  private server?: http.Server;
  private serverError?: string;
  private idleTimer?: NodeJS.Timeout;
  private sessions = new Map<string, SessionState>();
  private waiters = new Map<string, Array<(s: SessionState) => void>>();

  constructor(private readonly client: XClient) {}

  private get cfg() {
    return this.client.cfg;
  }
  private get store() {
    return this.client.store;
  }

  async start(): Promise<{ authorize_url: string; state: string; mode: "loopback" | "paste"; listening: boolean; note: string }> {
    const clientId = requireClientId(this.cfg);
    const { verifier, challenge } = createPkce();
    const state = randomState();
    const pending = this.store.readPending();
    const now = Date.now();
    for (const [k, v] of Object.entries(pending)) if (now - v.created > PENDING_TTL_MS) delete pending[k];
    pending[state] = { verifier, redirect_uri: this.cfg.redirectUri, client_id: clientId, created: now };
    this.store.writePending(pending);
    this.sessions.set(state, { status: "pending" });

    const listening = this.cfg.authMode === "loopback" && (await this.ensureListener());
    const paste =
      `Open authorize_url in a browser signed in to the X account to add and click "Authorize". The browser then ` +
      `goes to ${this.cfg.redirectUri}?state=...&code=... and the page fails to load; that is expected. Copy the ` +
      `full URL from the address bar and paste it back here right away: it is passed to complete_authorization, ` +
      `and X codes expire about 30 seconds after approval.`;
    const note = listening
      ? `Open authorize_url in a browser on this same computer, signed in to the X account to add. After you click "Authorize", the browser returns to ${this.cfg.redirectUri} and the account is saved automatically. Then call auth_status (or list_accounts) to confirm. If the browser is on another device, use the paste flow: copy the callback URL from the address bar into complete_authorization within 30 seconds.`
      : this.cfg.authMode === "paste"
        ? paste
        : `Could not listen on ${this.cfg.redirectUri} (${this.serverError}). ${paste}`;
    return {
      authorize_url: buildAuthorizeUrl(this.cfg, clientId, state, challenge),
      state,
      mode: listening ? "loopback" : "paste",
      listening,
      note,
    };
  }

  status(state?: string): SessionState | Record<string, SessionState> {
    if (state) return this.sessions.get(state) ?? { status: "error", error: "unknown state (started in another process, or expired)" };
    return Object.fromEntries(this.sessions);
  }

  /** Resolves once the given authorization finishes, or after timeoutMs with the current state. */
  wait(state: string, timeoutMs: number): Promise<SessionState> {
    const cur = this.sessions.get(state);
    if (!cur || cur.status !== "pending") return Promise.resolve(cur ?? { status: "error", error: "unknown state" });
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(this.sessions.get(state)!), timeoutMs);
      const list = this.waiters.get(state) ?? [];
      list.push((s) => {
        clearTimeout(t);
        resolve(s);
      });
      this.waiters.set(state, list);
    });
  }

  /** Finish an authorization from the full callback URL (or a code + state pair). */
  async complete(input: { redirect_url?: string; code?: string; state?: string }): Promise<AuthResult> {
    let code = input.code;
    let state = input.state;
    if (input.redirect_url) {
      const u = new URL(input.redirect_url.trim());
      const err = u.searchParams.get("error");
      if (err) throw new Error(`Authorization was denied: ${err} ${u.searchParams.get("error_description") ?? ""}`.trim());
      code = u.searchParams.get("code") ?? undefined;
      state = u.searchParams.get("state") ?? undefined;
    }
    if (!code || !state) throw new Error("Need the callback URL containing both code and state.");
    try {
      const result = await this.exchange(code, state);
      this.settle(state, { status: "done", result });
      return result;
    } catch (e) {
      this.settle(state, { status: "error", error: (e as Error).message });
      throw e;
    }
  }

  private settle(state: string, s: SessionState) {
    this.sessions.set(state, s);
    for (const w of this.waiters.get(state) ?? []) w(s);
    this.waiters.delete(state);
    if (![...this.sessions.values()].some((v) => v.status === "pending")) this.scheduleClose(5_000);
  }

  private async exchange(code: string, state: string): Promise<AuthResult> {
    const pending = this.store.readPending();
    const p = pending[state];
    if (!p) throw new Error("Unknown or expired state; call add_account again.");
    delete pending[state];
    this.store.writePending(pending);

    const t = await exchangeCode(this.cfg, p.client_id, code, p.verifier, p.redirect_uri);
    const r = await this.client.raw(t.access_token, "GET", "/2/users/me", {
      query: { "user.fields": "id,name,username" },
    });
    const me = await parseBody(r);
    if (!r.ok || !me?.data?.username) {
      throw new Error(`Token obtained but GET /2/users/me failed (${r.status}: ${describeError(me)}). Check the app has users.read scope and credits.`);
    }
    const key = accountKey(me.data.username);
    const account: Account = {
      username: me.data.username,
      user_id: me.data.id,
      name: me.data.name,
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: Date.now() + (t.expires_in ?? 7200) * 1000,
      scope: t.scope,
      client_id: p.client_id,
      authorized_at: new Date().toISOString(),
    };
    const isDefault = await this.store.withLock(async () => {
      const data = this.store.read();
      data.accounts[key] = account;
      if (!data.default_account || !data.accounts[data.default_account]) data.default_account = key;
      this.store.write(data);
      return data.default_account === key;
    });
    return {
      username: account.username,
      user_id: account.user_id,
      name: account.name,
      scope: account.scope,
      has_refresh_token: !!account.refresh_token,
      is_default: isDefault,
    };
  }

  async remove(name: string, revoke = true): Promise<{ removed: string; revoked: boolean; revoke_error?: string }> {
    const key = this.client.resolveAccount(name);
    const a = this.client.getAccount(key);
    let revoked = false;
    let revoke_error: string | undefined;
    if (revoke) {
      try {
        if (a.refresh_token) await revokeToken(this.cfg, a.client_id, a.refresh_token, "refresh_token");
        await revokeToken(this.cfg, a.client_id, a.access_token, "access_token");
        revoked = true;
      } catch (e) {
        revoke_error = (e as Error).message;
      }
    }
    await this.store.withLock(async () => {
      const data = this.store.read();
      delete data.accounts[key];
      if (data.default_account === key) {
        const rest = Object.keys(data.accounts);
        data.default_account = rest.length === 1 ? rest[0] : undefined;
      }
      this.store.write(data);
    });
    return { removed: a.username, revoked, ...(revoke_error ? { revoke_error } : {}) };
  }

  private ensureListener(): Promise<boolean> {
    if (this.server?.listening) {
      this.scheduleClose(PENDING_TTL_MS);
      return Promise.resolve(true);
    }
    const u = new URL(this.cfg.redirectUri);
    if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) {
      this.serverError = "redirect URI is not a local http address";
      return Promise.resolve(false);
    }
    const port = Number(u.port || 80);
    const host = u.hostname === "[::1]" ? "::1" : u.hostname;
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => this.onRequest(u.pathname, req, res));
      server.once("error", (e: NodeJS.ErrnoException) => {
        this.serverError = e.code === "EADDRINUSE" ? `port ${port} is already in use` : e.message;
        resolve(false);
      });
      server.listen(port, host, () => {
        this.server = server;
        server.unref();
        this.scheduleClose(PENDING_TTL_MS);
        resolve(true);
      });
    });
  }

  private onRequest(pathname: string, req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", this.cfg.redirectUri);
    if (url.pathname !== pathname) {
      res.writeHead(404).end();
      return;
    }
    const send = (ok: boolean, msg: string) => {
      res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>x-api-mcp</title>` +
          `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
          `<h2>${ok ? "✅" : "❌"} ${escapeHtml(msg)}</h2><p>You can close this tab.</p></body>`,
      );
    };
    this.complete({ redirect_url: url.toString() }).then(
      (r) => send(true, `@${r.username} is connected to x-api-mcp`),
      (e) => send(false, (e as Error).message),
    );
  }

  private scheduleClose(ms: number) {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), ms);
    this.idleTimer.unref();
  }

  close() {
    this.server?.close();
    this.server = undefined;
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

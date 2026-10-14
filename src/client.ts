import { Config } from "./config.js";
import { XApiError, describeError, parseBody } from "./errors.js";
import { refreshToken } from "./oauth.js";
import { Account, TokenStore, accountKey } from "./store.js";

const REFRESH_MARGIN_MS = 120_000;

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  form?: FormData;
}

/** Authenticated X API v2 client that acts on behalf of one of the locally stored accounts. */
export class XClient {
  constructor(
    readonly cfg: Config,
    readonly store: TokenStore,
  ) {}

  /** Resolve an account argument (or the default) to a store key. */
  resolveAccount(name?: string): string {
    const data = this.store.read();
    const keys = Object.keys(data.accounts);
    if (name) {
      const k = accountKey(name);
      if (data.accounts[k]) return k;
      throw new Error(
        `Account "${name}" is not authorized. Known: ${keys.join(", ") || "none"}. Use add_account to authorize it.`,
      );
    }
    const fallback = data.default_account ?? (this.cfg.defaultAccount && accountKey(this.cfg.defaultAccount));
    if (fallback && data.accounts[fallback]) return fallback;
    if (keys.length === 1) return keys[0];
    if (keys.length === 0) throw new Error("No X account authorized yet. Use add_account first.");
    throw new Error(
      `Several accounts are authorized (${keys.join(", ")}); pass "account" or set a default with set_default_account.`,
    );
  }

  getAccount(key: string): Account {
    const a = this.store.read().accounts[key];
    if (!a) throw new Error(`Account "${key}" not found`);
    return a;
  }

  async getAccessToken(key: string, force = false): Promise<string> {
    const a = this.getAccount(key);
    if (!force && Date.now() < a.expires_at - REFRESH_MARGIN_MS) return a.access_token;
    return this.store.withLock(async () => {
      // Another process may have refreshed while we waited for the lock.
      const data = this.store.read();
      const cur = data.accounts[key];
      if (!cur) throw new Error(`Account "${key}" was removed`);
      if (cur.access_token !== a.access_token && Date.now() < cur.expires_at - REFRESH_MARGIN_MS) {
        return cur.access_token;
      }
      if (!force && Date.now() < cur.expires_at - REFRESH_MARGIN_MS) return cur.access_token;
      if (!cur.refresh_token) {
        throw new Error(`Access token for @${cur.username} expired and no refresh token is stored; run add_account again.`);
      }
      let t;
      try {
        t = await refreshToken(this.cfg, cur.client_id, cur.refresh_token);
      } catch (e) {
        throw new Error(
          `Refreshing the token for @${cur.username} failed (${(e as Error).message}). Re-authorize with add_account.`,
        );
      }
      cur.access_token = t.access_token;
      cur.refresh_token = t.refresh_token ?? cur.refresh_token;
      cur.expires_at = Date.now() + (t.expires_in ?? 7200) * 1000;
      if (t.scope) cur.scope = t.scope;
      this.store.write(data);
      return cur.access_token;
    });
  }

  async request<T = any>(
    account: string,
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const key = this.resolveAccount(account);
    let token = await this.getAccessToken(key);
    for (let attempt = 0; ; attempt++) {
      const r = await this.raw(token, method, path, opts);
      if (r.status === 401 && attempt === 0) {
        token = await this.getAccessToken(key, true);
        continue;
      }
      const body = await parseBody(r);
      if (!r.ok || (body?.errors && body.data === undefined)) {
        const reset = Number(r.headers.get("x-rate-limit-reset")) || undefined;
        let msg = `${method} ${path} -> ${r.status}: ${describeError(body)}`;
        if (r.status === 429 && reset) msg += ` (rate limited until ${new Date(reset * 1000).toISOString()})`;
        throw new XApiError(msg, r.status, body, reset);
      }
      return body as T;
    }
  }

  /** Unauthenticated-by-store request with an explicit bearer token (used right after OAuth). */
  async raw(token: string, method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const url = new URL(this.cfg.apiBase + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      body = opts.form;
    }
    return fetch(url, { method, headers, body });
  }
}

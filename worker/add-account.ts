import { fetchAccount, saveAccount } from "../src/accounts.js";
import type { XClient } from "../src/client.js";
import { buildAuthorizeUrl, createPkce, randomState } from "../src/oauth.js";
import type { WebAuth } from "../src/server.js";
import type { Store } from "../src/store.js";

const PENDING_TTL_MS = 15 * 60_000;
const IN_PROGRESS = "in progress";

/**
 * add_account on the Worker: the sign-in link goes to X, and X calls back to /x/callback, where
 * finishAddAccount saves the account. Only a signed-in connector user can start one, so the
 * added account does not have to be on the allowlist.
 */
export function webAuth(client: XClient): WebAuth {
  const cfg = client.cfg;
  const store = client.store;
  return {
    async start() {
      const { verifier, challenge } = createPkce();
      const state = randomState();
      await store.withLock(async () => {
        const pending = prune(await store.readPending());
        pending[state] = { verifier, redirect_uri: cfg.redirectUri, client_id: cfg.clientId!, created: Date.now() };
        await store.writePending(pending);
      });
      return {
        authorize_url: buildAuthorizeUrl(cfg, cfg.clientId!, state, challenge),
        state,
        note:
          'Open authorize_url in a browser signed in to the X account to add and click "Authorize". The server saves ' +
          "the account when X sends the browser back. Then call auth_status with this state, or list_accounts.",
      };
    },
    async status(state: string) {
      const p = (await store.readPending())[state];
      if (!p || Date.now() - p.created > PENDING_TTL_MS) return { status: "error", error: "unknown or expired state; call add_account again" };
      if (p.done) return { status: "done", result: p.done };
      if (p.error === IN_PROGRESS) return { status: "pending" };
      if (p.error) return { status: "error", error: p.error };
      return { status: "pending" };
    },
  };
}

/** True when `state` belongs to an add_account started on this server. */
export async function isAddAccountState(store: Store, state: string | null): Promise<boolean> {
  if (!state) return false;
  const p = (await store.readPending())[state];
  return !!p && !p.done && !p.error && Date.now() - p.created <= PENDING_TTL_MS;
}

/** Handle X's callback for an add_account link. Returns the username that was added. */
export async function finishAddAccount(client: XClient, state: string, code: string | null, error: string | null): Promise<string> {
  const store = client.store;
  // Take the entry under the lock so a replayed callback can't use the same verifier twice.
  const p = await store.withLock(async () => {
    const pending = await store.readPending();
    const entry = pending[state];
    if (!entry || entry.done || entry.error) return undefined;
    pending[state] = { ...entry, error: IN_PROGRESS };
    await store.writePending(pending);
    return entry;
  });
  if (!p) throw new Error("This sign-in link was already used or has expired. Ask Claude for a new one.");

  const settle = (result: { done?: NonNullable<typeof p.done>; error?: string }) =>
    store.withLock(async () => {
      const pending = await store.readPending();
      pending[state] = { ...p, ...result };
      await store.writePending(pending);
    });

  try {
    if (error || !code) throw new Error(`Authorization was denied${error ? `: ${error}` : ""}`);
    const account = await fetchAccount(client, p.client_id, code, p.verifier, p.redirect_uri);
    const isDefault = await saveAccount(store, account);
    await settle({ done: { username: account.username, user_id: account.user_id, is_default: isDefault } });
    return account.username;
  } catch (e) {
    await settle({ error: (e as Error).message });
    throw e;
  }
}

function prune(pending: Awaited<ReturnType<Store["readPending"]>>) {
  const now = Date.now();
  for (const [k, v] of Object.entries(pending)) if (now - v.created > PENDING_TTL_MS) delete pending[k];
  return pending;
}

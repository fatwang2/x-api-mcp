// Account bookkeeping shared by the local OAuth flow (auth.ts) and the remote Worker.
import { XClient } from "./client.js";
import { revokeToken } from "./oauth.js";
import { Account, Store, accountKey } from "./store.js";

/** Store a newly authorized account; the first one becomes the default. Returns whether it is the default. */
export function saveAccount(store: Store, account: Account): Promise<boolean> {
  const key = accountKey(account.username);
  return store.withLock(async () => {
    const data = await store.read();
    data.accounts[key] = account;
    if (!data.default_account || !data.accounts[data.default_account]) data.default_account = key;
    await store.write(data);
    return data.default_account === key;
  });
}

/** Forget an authorized account, optionally revoking its tokens at X first. */
export async function removeAccount(
  client: XClient,
  name: string,
  revoke = true,
): Promise<{ removed: string; revoked: boolean; revoke_error?: string }> {
  const key = await client.resolveAccount(name);
  const a = await client.getAccount(key);
  let revoked = false;
  let revoke_error: string | undefined;
  if (revoke) {
    try {
      if (a.refresh_token) await revokeToken(client.cfg, a.client_id, a.refresh_token, "refresh_token");
      await revokeToken(client.cfg, a.client_id, a.access_token, "access_token");
      revoked = true;
    } catch (e) {
      revoke_error = (e as Error).message;
    }
  }
  await client.store.withLock(async () => {
    const data = await client.store.read();
    delete data.accounts[key];
    if (data.default_account === key) {
      const rest = Object.keys(data.accounts);
      data.default_account = rest.length === 1 ? rest[0] : undefined;
    }
    await client.store.write(data);
  });
  return { removed: a.username, revoked, ...(revoke_error ? { revoke_error } : {}) };
}

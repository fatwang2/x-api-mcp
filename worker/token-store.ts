import { DurableObject } from "cloudflare:workers";
import type { PendingAuth, Store, StoreData } from "../src/store.js";
import type { Env } from "./env.js";

const LEASE_MS = 30_000;
const WAIT_MS = 20_000;

/**
 * One instance per deployment (idFromName("owner")) keeps every X account and its tokens.
 * Besides plain reads and writes it hands out a lease lock, the same contract as the local
 * lock file: X rotates refresh tokens, so two Worker requests refreshing the same account at
 * once would invalidate each other. A lease expires if its holder never releases it.
 */
export class XTokenStore extends DurableObject<Env> {
  private lease?: { id: string; until: number };

  async read(): Promise<StoreData> {
    const d = await this.ctx.storage.get<StoreData>("tokens");
    return d && d.accounts ? d : { version: 1, accounts: {} };
  }

  async write(data: StoreData): Promise<void> {
    await this.ctx.storage.put("tokens", data);
  }

  async readPending(): Promise<Record<string, PendingAuth>> {
    return (await this.ctx.storage.get<Record<string, PendingAuth>>("pending")) ?? {};
  }

  async writePending(p: Record<string, PendingAuth>): Promise<void> {
    await this.ctx.storage.put("pending", p);
  }

  async acquire(): Promise<string> {
    const deadline = Date.now() + WAIT_MS;
    while (this.lease && this.lease.until > Date.now()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the token store lock");
      await new Promise((r) => setTimeout(r, 25));
    }
    const id = crypto.randomUUID();
    this.lease = { id, until: Date.now() + LEASE_MS };
    return id;
  }

  async release(id: string): Promise<void> {
    if (this.lease?.id === id) this.lease = undefined;
  }
}

/** Store backed by the XTokenStore Durable Object, for use inside the Worker. */
export class DurableStore implements Store {
  constructor(private readonly stub: DurableObjectStub<XTokenStore>) {}

  static forEnv(env: Env): DurableStore {
    return new DurableStore(env.X_TOKEN_STORE.get(env.X_TOKEN_STORE.idFromName("owner")));
  }

  async read(): Promise<StoreData> {
    return (await this.stub.read()) as StoreData;
  }

  async write(data: StoreData): Promise<void> {
    await this.stub.write(data);
  }

  async readPending(): Promise<Record<string, PendingAuth>> {
    return (await this.stub.readPending()) as Record<string, PendingAuth>;
  }

  async writePending(p: Record<string, PendingAuth>): Promise<void> {
    await this.stub.writePending(p);
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const id = await this.stub.acquire();
    try {
      return await fn();
    } finally {
      await this.stub.release(id);
    }
  }
}

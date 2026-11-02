import { DurableObject } from "cloudflare:workers";
import type { WriteLog, WriteLogEntry } from "../src/server.js";
import type { PendingAuth, Store, StoreData } from "../src/store.js";
import type { Env } from "./env.js";

const LEASE_MS = 30_000;
const WAIT_MS = 20_000;
const LOG_LIMIT = 1000;

interface UploadToken {
  expires: number;
  state: "open" | "uploading" | "used";
}

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

  async appendLog(entry: WriteLogEntry): Promise<void> {
    const log = (await this.ctx.storage.get<WriteLogEntry[]>("write_log")) ?? [];
    log.push(entry);
    await this.ctx.storage.put("write_log", log.slice(-LOG_LIMIT));
  }

  async listLog(limit: number): Promise<WriteLogEntry[]> {
    const log = (await this.ctx.storage.get<WriteLogEntry[]>("write_log")) ?? [];
    return log.slice(-limit).reverse();
  }

  /** One-time upload links: only a hash of each token is kept, with its expiry and state. */
  private async uploadTokens(): Promise<Record<string, UploadToken>> {
    const all = (await this.ctx.storage.get<Record<string, UploadToken>>("upload_tokens")) ?? {};
    const now = Date.now();
    for (const [h, t] of Object.entries(all)) if (t.expires < now - 3_600_000) delete all[h];
    return all;
  }

  async addUploadToken(hash: string, expires: number): Promise<void> {
    const all = await this.uploadTokens();
    all[hash] = { expires, state: "open" };
    await this.ctx.storage.put("upload_tokens", all);
  }

  async peekUploadToken(hash: string): Promise<"open" | "gone"> {
    const t = (await this.uploadTokens())[hash];
    return t && t.state === "open" && t.expires > Date.now() ? "open" : "gone";
  }

  /** Take an open token for one upload. Runs as one step in the object, so two uploads can't both claim it. */
  async claimUploadToken(hash: string): Promise<"claimed" | "gone"> {
    const all = await this.uploadTokens();
    const t = all[hash];
    if (!t || t.state !== "open" || t.expires <= Date.now()) return "gone";
    all[hash] = { ...t, state: "uploading" };
    await this.ctx.storage.put("upload_tokens", all);
    return "claimed";
  }

  /** Mark a claimed token used, or open it again if the upload failed. */
  async finishUploadToken(hash: string, ok: boolean): Promise<void> {
    const all = await this.uploadTokens();
    if (!all[hash]) return;
    all[hash] = { ...all[hash], state: ok ? "used" : "open" };
    await this.ctx.storage.put("upload_tokens", all);
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

/** Store (and write log) backed by the XTokenStore Durable Object, for use inside the Worker. */
export class DurableStore implements Store, WriteLog {
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

  async append(entry: WriteLogEntry): Promise<void> {
    await this.stub.appendLog(entry);
  }

  async list(limit: number): Promise<WriteLogEntry[]> {
    return (await this.stub.listLog(limit)) as WriteLogEntry[];
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

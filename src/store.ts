import fs from "node:fs";
import path from "node:path";

export interface Account {
  username: string;
  user_id: string;
  name?: string;
  access_token: string;
  refresh_token?: string;
  /** epoch ms */
  expires_at: number;
  scope?: string;
  /** Client ID that issued the token; refresh must use the same client. */
  client_id: string;
  authorized_at: string;
}

export interface StoreData {
  version: 1;
  default_account?: string;
  accounts: Record<string, Account>;
}

export interface PendingAuth {
  verifier: string;
  redirect_uri: string;
  client_id: string;
  created: number;
  /** Outcome, kept for a while by stores that can't hold it in memory (the remote Worker). */
  done?: { username: string; user_id: string; is_default: boolean };
  error?: string;
}

const LOCK_STALE_MS = 30_000;

export const accountKey = (name: string) => name.trim().replace(/^@/, "").toLowerCase();

/**
 * Where authorized accounts and in-flight PKCE state live. Every method is async so the
 * same tool code can run against the local file store or a remote backend.
 */
export interface Store {
  read(): Promise<StoreData>;
  write(data: StoreData): Promise<void>;
  readPending(): Promise<Record<string, PendingAuth>>;
  writePending(p: Record<string, PendingAuth>): Promise<void>;
  /**
   * Mutual exclusion around read-modify-write of the account data. X rotates refresh tokens,
   * so two concurrent refreshes of the same account would invalidate each other.
   */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

/** File-backed token store. Files are 0600 inside a 0700 directory; writes are atomic renames. */
export class FileStore implements Store {
  readonly tokensFile: string;
  readonly pendingFile: string;
  private readonly lockFile: string;

  constructor(readonly dir: string) {
    this.tokensFile = path.join(dir, "tokens.json");
    this.pendingFile = path.join(dir, "pending.json");
    this.lockFile = path.join(dir, "tokens.lock");
  }

  async read(): Promise<StoreData> {
    const d = readJson<StoreData>(this.tokensFile);
    return d && d.accounts ? d : { version: 1, accounts: {} };
  }

  async write(data: StoreData): Promise<void> {
    this.writeFile(this.tokensFile, data);
  }

  async readPending(): Promise<Record<string, PendingAuth>> {
    return readJson<Record<string, PendingAuth>>(this.pendingFile) ?? {};
  }

  async writePending(p: Record<string, PendingAuth>): Promise<void> {
    this.writeFile(this.pendingFile, p);
  }

  /** Cross-process mutex (lock file next to tokens.json), so several MCP processes can share one store. */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    this.ensureDir();
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const fd = fs.openSync(this.lockFile, "wx", 0o600);
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        break;
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
        try {
          if (Date.now() - fs.statSync(this.lockFile).mtimeMs > LOCK_STALE_MS) {
            fs.rmSync(this.lockFile, { force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${this.lockFile}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    try {
      return await fn();
    } finally {
      fs.rmSync(this.lockFile, { force: true });
    }
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private writeFile(file: string, obj: unknown): void {
    this.ensureDir();
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

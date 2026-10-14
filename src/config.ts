import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Scopes requested by default. DM scopes are opt-in (X_ENABLE_DM) because an App without
 *  Direct Messages permission rejects the whole authorization when they are requested. */
export const DEFAULT_SCOPES = [
  "tweet.read",
  "tweet.write",
  "tweet.moderate.write",
  "users.read",
  "follows.read",
  "follows.write",
  "like.read",
  "like.write",
  "bookmark.read",
  "bookmark.write",
  "mute.read",
  "mute.write",
  "block.read",
  "block.write",
  "list.read",
  "list.write",
  "media.write",
  "offline.access",
];
export const DM_SCOPES = ["dm.read", "dm.write"];

export type AuthMode = "loopback" | "paste";
export type ToolGroup = "read" | "write";

export interface Config {
  clientId?: string;
  clientSecret?: string;
  /** Where the client ID came from, for error messages. */
  clientIdSource?: "env" | "file";
  redirectUri: string;
  scopes: string[];
  homeDir: string;
  apiBase: string;
  authorizeUrl: string;
  defaultAccount?: string;
  authMode: AuthMode;
  dmEnabled: boolean;
  requireAccount: boolean;
  toolGroups: Set<ToolGroup>;
}

/** Locally saved app settings (set_client_id / `x-api-mcp config`). */
export interface AppFile {
  client_id?: string;
  client_secret?: string;
}

export const appFilePath = (homeDir: string) => path.join(homeDir, "app.json");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const homeDir = env.X_API_MCP_HOME || path.join(os.homedir(), ".x-api-mcp");
  const file = readAppFile(homeDir);
  const envId = nonEmpty(env.X_CLIENT_ID);
  const dmEnabled = truthy(env.X_ENABLE_DM);
  let scopes = nonEmpty(env.X_SCOPES)?.split(/[\s,]+/).filter(Boolean) ?? DEFAULT_SCOPES;
  if (dmEnabled) scopes = [...new Set([...scopes, ...DM_SCOPES])];
  return {
    clientId: envId ?? nonEmpty(file.client_id),
    clientSecret: envId ? nonEmpty(env.X_CLIENT_SECRET) : nonEmpty(env.X_CLIENT_SECRET) ?? nonEmpty(file.client_secret),
    clientIdSource: envId ? "env" : nonEmpty(file.client_id) ? "file" : undefined,
    redirectUri: nonEmpty(env.X_REDIRECT_URI) ?? "http://127.0.0.1:8765/callback",
    scopes,
    homeDir,
    apiBase: (nonEmpty(env.X_API_BASE) ?? "https://api.x.com").replace(/\/+$/, ""),
    authorizeUrl: nonEmpty(env.X_AUTHORIZE_URL) ?? "https://x.com/i/oauth2/authorize",
    defaultAccount: nonEmpty(env.X_DEFAULT_ACCOUNT),
    authMode: authMode(env),
    dmEnabled: dmEnabled || DM_SCOPES.some((s) => scopes.includes(s)),
    requireAccount: truthy(env.X_REQUIRE_ACCOUNT),
    toolGroups: toolGroups(env.X_TOOLS),
  };
}

/**
 * paste: the browser that approves the request is not on this machine (remote agents, SSH,
 * chat bots), so a loopback listener can never receive the callback.
 * auto (default): paste over SSH, loopback otherwise.
 */
function authMode(env: NodeJS.ProcessEnv): AuthMode {
  const v = nonEmpty(env.X_AUTH_MODE)?.toLowerCase() ?? "auto";
  if (v === "paste" || v === "loopback") return v;
  if (v !== "auto") throw new Error(`X_AUTH_MODE must be auto, loopback or paste (got "${v}")`);
  return env.SSH_CONNECTION || env.SSH_TTY ? "paste" : "loopback";
}

function toolGroups(v: string | undefined): Set<ToolGroup> {
  const raw = nonEmpty(v)?.toLowerCase() ?? "all";
  if (raw === "all") return new Set(["read", "write"]);
  const groups = raw.split(/[\s,]+/).filter(Boolean);
  for (const g of groups) {
    if (g !== "read" && g !== "write") throw new Error(`X_TOOLS must be all, write, read or "write,read" (got "${raw}")`);
  }
  return new Set(groups as ToolGroup[]);
}

export function readAppFile(homeDir: string): AppFile {
  try {
    return JSON.parse(fs.readFileSync(appFilePath(homeDir), "utf8"));
  } catch {
    return {};
  }
}

export function writeAppFile(homeDir: string, app: AppFile): void {
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  const file = appFilePath(homeDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(app, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

/** Save the app credentials locally and apply them to the running config. Env vars still win. */
export function saveClientId(cfg: Config, clientId: string, clientSecret?: string): void {
  writeAppFile(cfg.homeDir, { client_id: clientId.trim(), ...(clientSecret ? { client_secret: clientSecret.trim() } : {}) });
  if (cfg.clientIdSource === "env") return;
  cfg.clientId = clientId.trim();
  cfg.clientSecret = clientSecret?.trim() || undefined;
  cfg.clientIdSource = "file";
}

// Unexpanded placeholders such as "${X_CLIENT_ID}" or "${user_config.client_id}" count as unset.
export function nonEmpty(v: string | undefined): string | undefined {
  if (!v || !v.trim() || v.includes("${")) return undefined;
  return v.trim();
}

export function truthy(v: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(nonEmpty(v)?.toLowerCase() ?? "");
}

export function requireClientId(cfg: Config): string {
  if (!cfg.clientId) {
    throw new Error(
      "No X Client ID is configured. Create an app at https://console.x.com, enable OAuth 2.0 (Native App), " +
        `add ${cfg.redirectUri} as a callback URL, then either call set_client_id with its Client ID ` +
        "or set the X_CLIENT_ID environment variable.",
    );
  }
  return cfg.clientId;
}

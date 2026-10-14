import os from "node:os";
import path from "node:path";

export const DEFAULT_SCOPES = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "media.write",
  "offline.access",
];

export interface Config {
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string[];
  homeDir: string;
  apiBase: string;
  authorizeUrl: string;
  defaultAccount?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const homeDir =
    env.X_API_MCP_HOME || path.join(os.homedir(), ".x-api-mcp");
  return {
    clientId: nonEmpty(env.X_CLIENT_ID),
    clientSecret: nonEmpty(env.X_CLIENT_SECRET),
    redirectUri: env.X_REDIRECT_URI || "http://127.0.0.1:8765/callback",
    scopes: env.X_SCOPES ? env.X_SCOPES.split(/[\s,]+/).filter(Boolean) : DEFAULT_SCOPES,
    homeDir,
    apiBase: (env.X_API_BASE || "https://api.x.com").replace(/\/+$/, ""),
    authorizeUrl: env.X_AUTHORIZE_URL || "https://x.com/i/oauth2/authorize",
    defaultAccount: nonEmpty(env.X_DEFAULT_ACCOUNT),
  };
}

// Unexpanded placeholders such as "${X_CLIENT_ID}" from MCP client configs count as unset.
function nonEmpty(v: string | undefined): string | undefined {
  if (!v || !v.trim() || v.startsWith("${")) return undefined;
  return v.trim();
}

export function requireClientId(cfg: Config): string {
  if (!cfg.clientId) {
    throw new Error(
      "X_CLIENT_ID is not set. Create an app at https://console.x.com, enable OAuth 2.0, " +
        `add ${cfg.redirectUri} as a callback URL, and pass its Client ID via the X_CLIENT_ID env var.`,
    );
  }
  return cfg.clientId;
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppFile, Config, buildConfig } from "./config-core.js";

export * from "./config-core.js";

export const appFilePath = (homeDir: string) => path.join(homeDir, "app.json");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const homeDir = env.X_API_MCP_HOME || path.join(os.homedir(), ".x-api-mcp");
  return buildConfig(env, { homeDir, app: readAppFile(homeDir) });
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

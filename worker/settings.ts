import { Config, buildConfig, nonEmpty } from "../src/config-core.js";
import type { Env } from "./env.js";

/** Public origin of the Worker, validated: https, or http on a loopback host for wrangler dev. */
export function publicBaseUrl(env: Env): string {
  const raw = nonEmpty(env.X_PUBLIC_BASE_URL);
  if (!raw) throw new Error("X_PUBLIC_BASE_URL is not set. Set it to this Worker's public origin, e.g. https://x-api-mcp.example.com");
  const u = new URL(raw);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    throw new Error("X_PUBLIC_BASE_URL must use https (http is only accepted on localhost for wrangler dev)");
  }
  return u.origin;
}

/** Config for the Worker: X calls back to <base>/x/callback, and the X App is a confidential Web App. */
export function remoteConfig(env: Env): Config {
  const cfg = buildConfig({
    ...(env as unknown as Record<string, string | undefined>),
    X_REDIRECT_URI: `${publicBaseUrl(env)}/x/callback`,
    X_AUTH_MODE: "paste",
    // Several accounts behind one connector: writes must always name theirs unless turned off.
    X_REQUIRE_ACCOUNT: env.X_REQUIRE_ACCOUNT ?? "1",
  });
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error("X_CLIENT_ID and X_CLIENT_SECRET must be set as Worker secrets (wrangler secret put).");
  }
  return cfg;
}

/** X user IDs allowed to sign in to the connector. An empty or missing list allows nobody. */
export function allowedUserIds(env: Env): Set<string> {
  return new Set((nonEmpty(env.ALLOWED_X_USER_IDS) ?? "").split(/[\s,]+/).filter((id) => /^\d+$/.test(id)));
}

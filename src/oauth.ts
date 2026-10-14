import crypto from "node:crypto";
import { Config } from "./config.js";
import { XApiError, describeError, parseBody } from "./errors.js";

export interface TokenResponse {
  token_type: string;
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

const b64url = (b: Buffer) =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(48)); // 64 chars, within RFC 7636's 43-128
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export const randomState = () => b64url(crypto.randomBytes(24));

export function buildAuthorizeUrl(
  cfg: Config,
  clientId: string,
  state: string,
  challenge: string,
): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${cfg.authorizeUrl}?${q}`;
}

/**
 * Public clients (Native App) send client_id in the body; confidential clients (Web App)
 * also authenticate with HTTP Basic. The secret is only used for the client it belongs to.
 */
async function oauthPost(
  cfg: Config,
  path: string,
  clientId: string,
  params: Record<string, string>,
): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (cfg.clientSecret && clientId === cfg.clientId) {
    headers.Authorization =
      "Basic " + Buffer.from(`${clientId}:${cfg.clientSecret}`).toString("base64");
  }
  const r = await fetch(cfg.apiBase + path, {
    method: "POST",
    headers,
    body: new URLSearchParams({ ...params, client_id: clientId }),
  });
  const body = await parseBody(r);
  if (!r.ok) {
    throw new XApiError(`${path} ${r.status}: ${describeError(body)}`, r.status, body);
  }
  return body;
}

export function exchangeCode(
  cfg: Config,
  clientId: string,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<TokenResponse> {
  return oauthPost(cfg, "/2/oauth2/token", clientId, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
}

export function refreshToken(
  cfg: Config,
  clientId: string,
  refresh: string,
): Promise<TokenResponse> {
  return oauthPost(cfg, "/2/oauth2/token", clientId, {
    grant_type: "refresh_token",
    refresh_token: refresh,
  });
}

export function revokeToken(
  cfg: Config,
  clientId: string,
  token: string,
  hint: "access_token" | "refresh_token",
): Promise<unknown> {
  return oauthPost(cfg, "/2/oauth2/revoke", clientId, { token, token_type_hint: hint });
}

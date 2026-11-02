import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { XTokenStore } from "./token-store.js";

/**
 * Bindings and settings of the remote Worker. Everything that identifies one deployment comes
 * from here (wrangler vars and secrets), never from the repository.
 */
export interface Env {
  /** KV namespace the OAuth provider keeps client registrations and grants in. */
  OAUTH_KV: KVNamespace;
  /** Injected by OAuthProvider for the non-API routes. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** Durable Object holding the X accounts and their tokens. */
  X_TOKEN_STORE: DurableObjectNamespace<XTokenStore>;
  /** Optional R2 bucket for media uploaded through create_upload_link. */
  X_MEDIA?: R2Bucket;

  /** Public origin of this Worker, e.g. https://x-api-mcp.example.com (no trailing path). */
  X_PUBLIC_BASE_URL?: string;
  /** Secrets: the X Web App's OAuth 2.0 credentials. */
  X_CLIENT_ID?: string;
  X_CLIENT_SECRET?: string;
  /** Secret: X user IDs allowed to sign in, comma or space separated. Empty means nobody. */
  ALLOWED_X_USER_IDS?: string;

  /** Same meaning as for the local server. */
  X_TOOLS?: string;
  X_REQUIRE_ACCOUNT?: string;
  X_ENABLE_DM?: string;
  X_SCOPES?: string;
  X_DEFAULT_ACCOUNT?: string;
  /** Seconds to wait for X to process a video before returning its media_id (default 20). */
  X_MEDIA_WAIT_SECONDS?: string;
  /** Overrides for tests against a mock X API. */
  X_API_BASE?: string;
  X_AUTHORIZE_URL?: string;
}

/** What the connector's access token carries into /mcp requests. */
export interface GrantProps {
  xUserId: string;
  username: string;
}

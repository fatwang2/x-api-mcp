// Remote x-api-mcp: a Cloudflare Worker that serves the same tools over Streamable HTTP, behind
// its own OAuth server. Signing in to the connector goes through X, and only X accounts on the
// ALLOWED_X_USER_IDS list get in; that sign-in also stores the account for the tools to use.
import { OAuthProvider, AuthorizationError, CimdFetchError, authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { fetchAccount, saveAccount } from "../src/accounts.js";
import { XClient } from "../src/client.js";
import { buildAuthorizeUrl, createPkce, revokeToken } from "../src/oauth.js";
import { createServer } from "../src/server.js";
import { finishAddAccount, isAddAccountState, webAuth } from "./add-account.js";
import type { Env, GrantProps } from "./env.js";
import { consentPage, htmlResponse, messagePage } from "./pages.js";
import { allowedUserIds, publicBaseUrl, remoteConfig } from "./settings.js";
import { DurableStore } from "./token-store.js";

export { XTokenStore } from "./token-store.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** /mcp: stateless Streamable HTTP, one MCP server per request. */
const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as ExecutionContext & { props: GrantProps }).props;
    // The allowlist is checked again on every request, so removing an ID cuts off existing grants.
    if (!props?.xUserId || !allowedUserIds(env).has(props.xUserId)) {
      return json(403, { error: "forbidden", error_description: "This X account is no longer allowed on this server." });
    }
    if (request.method !== "POST") {
      // No server-initiated stream and no sessions: every tool call is a single request/response.
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    }
    const store = DurableStore.forEnv(env);
    const client = new XClient(remoteConfig(env), store);
    const server = createServer(client, {
      webAuth: webAuth(client),
      writeLog: store,
      mcp: { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

/** Everything else: the consent page, the hand-off to X and X's callback. */
const appHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/authorize" && request.method === "GET") return await showConsent(request, env);
      if (url.pathname === "/authorize" && request.method === "POST") return await startXSignIn(request, env);
      if (url.pathname === "/x/callback" && request.method === "GET") return await xCallback(request, env);
      if (url.pathname === "/" && request.method === "GET") {
        return new Response(`x-api-mcp remote server. Add ${publicBaseUrl(env)}/mcp as a custom connector.\n`, {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      return new Response("Not found", { status: 404 });
    } catch (e) {
      if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
      if (e instanceof AuthorizationError) return htmlResponse(messagePage("Could not continue", e.description), 400);
      if (e instanceof CimdFetchError) return htmlResponse(messagePage("Could not continue", "This app could not be verified."), 400);
      throw e;
    }
  },
};

async function showConsent(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  return htmlResponse(consentPage(details, consent.handle), 200, consent.headers);
}

async function startXSignIn(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle);
  const cfg = remoteConfig(env);
  const { verifier, challenge } = createPkce();
  const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
  headers.set("Location", buildAuthorizeUrl(cfg, cfg.clientId!, state, challenge));
  return new Response(null, { status: 302, headers });
}

/**
 * X sends the browser back here both for the connector sign-in (state from beginUpstream) and
 * for add_account links (state kept in the token store).
 */
async function xCallback(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const store = DurableStore.forEnv(env);
  if (await isAddAccountState(store, params.get("state"))) {
    const client = new XClient(remoteConfig(env), store);
    try {
      const username = await finishAddAccount(client, params.get("state")!, params.get("code"), params.get("error"));
      return htmlResponse(messagePage("Account added", `@${username} is connected to x-api-mcp. You can close this tab.`));
    } catch (e) {
      return htmlResponse(messagePage("Could not add the account", (e as Error).message), 400);
    }
  }
  return finishXSignIn(request, env);
}

async function finishXSignIn(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const params = new URL(request.url).searchParams;
  const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);
  const code = params.get("code");
  if (params.get("error") || !code) {
    headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
    return new Response(null, { status: 302, headers });
  }

  const cfg = remoteConfig(env);
  const store = DurableStore.forEnv(env);
  const client = new XClient(cfg, store);
  let account;
  try {
    account = await fetchAccount(client, cfg.clientId!, code, data.verifier, cfg.redirectUri);
  } catch (e) {
    return htmlResponse(messagePage("Sign-in failed", (e as Error).message), 502, headers);
  }

  if (!allowedUserIds(env).has(account.user_id)) {
    // Not on the allowlist: keep nothing and give the tokens back to X.
    try {
      if (account.refresh_token) await revokeToken(cfg, cfg.clientId!, account.refresh_token, "refresh_token");
      await revokeToken(cfg, cfg.clientId!, account.access_token, "access_token");
    } catch {
      // Revocation is best effort; the tokens are not stored anywhere.
    }
    return htmlResponse(
      messagePage("Not allowed", `@${account.username} is not on this server's allowlist, so it can't connect.`),
      403,
      headers,
    );
  }

  await saveAccount(store, account);
  const props: GrantProps = { xUserId: account.user_id, username: account.username };
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: account.user_id,
    metadata: { username: account.username },
    scope: original.scope,
    props,
  });
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}

let cached: { base: string; provider: OAuthProvider<Env> } | undefined;

/** The provider needs the public URL for its metadata, which only exists once env is available. */
function provider(env: Env): OAuthProvider<Env> {
  const base = publicBaseUrl(env);
  if (cached?.base !== base) {
    cached = {
      base,
      provider: new OAuthProvider<Env>({
        apiRoute: "/mcp",
        apiHandler: mcpHandler,
        defaultHandler: appHandler,
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/token",
        clientRegistrationEndpoint: "/register",
        resourceMetadata: {
          resource: `${base}/mcp`,
          authorization_servers: [base],
          bearer_methods_supported: ["header"],
          resource_name: "x-api-mcp",
        },
      }),
    };
  }
  return cached.provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return provider(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

# Remote server (Cloudflare Workers)

The same tools as the local stdio server, served over Streamable HTTP so claude.ai and other
remote MCP clients can connect. This is self-hosted only: each deployment uses its own X App,
its own domain and its own allowlist. Work in progress; this stage serves read-only tools.

How it fits together:

- `index.ts`: the Worker. `@cloudflare/workers-oauth-provider` makes it the OAuth server for MCP
  clients (`/authorize`, `/token`, `/register`, metadata). `/authorize` shows a consent page,
  then hands the browser to X; `/x/callback` exchanges X's code, checks the X user ID against
  `ALLOWED_X_USER_IDS`, stores the account and finishes the connector sign-in. `/mcp` serves
  the tools, stateless, one MCP server per request.
- `token-store.ts`: the `XTokenStore` Durable Object that holds the X accounts and tokens, with
  a lease lock so concurrent requests never refresh the same token twice (X rotates refresh
  tokens), and `DurableStore`, the `Store` implementation the shared code uses.
- `settings.ts`: config from Worker vars and secrets. `ALLOWED_X_USER_IDS` empty means nobody.

Nothing about a particular deployment lives in the repository. Copy `wrangler.example.toml` to
`wrangler.toml` (git ignores it), set your values there, and put `X_CLIENT_ID`,
`X_CLIENT_SECRET` and `ALLOWED_X_USER_IDS` in with `npx wrangler secret put`.

Checks: `npm run worker:typecheck`, `npm run worker:build` (bundles without deploying) and
`npm run test:worker` (runs the Worker locally with `wrangler dev` against a mock X API).

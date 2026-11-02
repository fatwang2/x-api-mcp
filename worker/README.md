# Remote server (Cloudflare Workers)

The same tools as the local stdio server, served over Streamable HTTP so claude.ai and other
remote MCP clients can connect. This is self-hosted only: each deployment uses its own X App,
its own domain and its own allowlist.

How it fits together:

- `index.ts`: the Worker. `@cloudflare/workers-oauth-provider` makes it the OAuth server for MCP
  clients (`/authorize`, `/token`, `/register`, metadata). `/authorize` shows a consent page,
  then hands the browser to X; `/x/callback` exchanges X's code, checks the X user ID against
  `ALLOWED_X_USER_IDS`, stores the account and finishes the connector sign-in. `/mcp` serves
  the tools, stateless, one MCP server per request.
- `token-store.ts`: the `XTokenStore` Durable Object that holds the X accounts and tokens, with
  a lease lock so concurrent requests never refresh the same token twice (X rotates refresh
  tokens), and `DurableStore`, the `Store` implementation the shared code uses.
- `add-account.ts`: `add_account` on the Worker. It returns an X sign-in link; `/x/callback`
  tells it apart from the connector sign-in by its `state` and saves the account.
- `uploads.ts`: media. Tools can take a public `media_url` (https only, no private or local
  hosts, checked again after each redirect), small `base64` (2 MB, since MCP requests are
  capped at 4 MB), or an `r2_key`. `create_upload_link` makes a one-time link to
  `/upload/<token>` (15 minutes, one file, type and size checked; only a hash of the token is
  stored) where the user uploads from their own device into the `X_MEDIA` R2 bucket, and
  `list_uploads` lists what is there. Videos are streamed to X in 4 MB segments, and a tool call
  waits at most `X_MEDIA_WAIT_SECONDS` for processing before handing back the media_id for
  `get_media_status`. The local `file_path` source does not exist here.
- `settings.ts`: config from Worker vars and secrets. `ALLOWED_X_USER_IDS` empty means nobody.
  `X_REQUIRE_ACCOUNT` defaults on, so write tools always name the account they act as.

Every write is kept in a log in the Durable Object (last 1000), readable with `get_write_log`.

Nothing about a particular deployment lives in the repository. Copy `wrangler.example.toml` to
`wrangler.toml` (git ignores it), set your values there, and put `X_CLIENT_ID`,
`X_CLIENT_SECRET` and `ALLOWED_X_USER_IDS` in with `npx wrangler secret put`.

Checks: `npm run worker:typecheck`, `npm run worker:build` (bundles without deploying) and
`npm run test:worker` (runs the Worker locally with `wrangler dev` against a mock X API).

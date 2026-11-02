# x-api-mcp

A **local stdio MCP server** for the official X API v2, built around multi-account posting: posts, replies, threads, deletes, and image/GIF/video uploads (including chunked upload). It also covers likes, reposts, bookmarks, follows, timelines, search, DMs, Lists and trends.

It runs on your own computer, started by your AI client as a child process. OAuth tokens stay in `~/.x-api-mcp/tokens.json` (mode 0600) and never pass through a third-party server.

For claude.ai on the web and phone, which can't start local processes, the same tools also run as a [**self-hosted remote server**](#remote-server-self-hosted) on your own Cloudflare account.

## Why x-api-mcp

X offers two MCP servers of its own (see [X's MCP docs](https://docs.x.com/tools/mcp)). Neither is built for posting from several accounts day to day:

| | x-api-mcp | X hosted MCP (`api.x.com/mcp`) | xmcp (X's self-hosted server) |
| --- | --- | --- | --- |
| Post, reply, quote, threads | Yes | No; writes are limited to bookmarks and Articles | Yes, one endpoint per tool |
| Upload images, GIFs, video | Yes, chunked upload waits for processing | No | Raw upload endpoints |
| DMs, follows, likes, Lists | Yes | No (lookups only) | Yes |
| Several X accounts | Yes, pick one per call | Through `xurl` (`-u` picks the account) | One per server process |
| Stays signed in | Yes, tokens saved and refreshed | Via `xurl` | No, re-authorize on every restart |
| Install | One plugin or `npx` line | `xurl mcp` bridge | Python, `.env` file, run a local web server |
| Tool count | 26, grouped by action | Curated set | About 120, generated from the API spec |
| Web and phone chat | Yes, with your own [remote server](#remote-server-self-hosted) | Yes | Only if you host it yourself |
| Safety rails | Agent skill and server instructions (confirm before posting, name the account), tool annotations, optional `X_REQUIRE_ACCOUNT` and write-only mode; the remote server also keeps a write log | None beyond read-only access | Tool allowlist |

Use the hosted MCP when you only need to read and search X. Use x-api-mcp when an agent should post, reply, upload media or manage interactions for one or more accounts, with tokens kept on your computer. All three use your own X App and its pay-per-use credits.

## Quick start

1. [Create an X App](#create-an-x-app) and copy its Client ID.
2. [Install](#install) x-api-mcp in your AI client.
3. Ask the agent to [add your X account](#add-x-accounts), then start posting.

You don't need to clone this repository or build anything; every install method runs the published npm package.

## Create an X App

Each user brings their own X App, and API usage is billed to that App's credits.

1. Create an App at [console.x.com](https://console.x.com) and add pay-per-use credits.
2. Under **User authentication settings**:
   - App permissions: **Read and write** (add **Direct Messages** if you want DM tools)
   - Type of App: **Native App** (public client, no secret needed, recommended). A Web App also works; set `X_CLIENT_SECRET` as well.
   - Callback URI: `http://127.0.0.1:8765/callback` (must exactly match `X_REDIRECT_URI`)
3. Copy the OAuth 2.0 **Client ID**.

## Install

| Client | How to install | Where the Client ID goes |
| --- | --- | --- |
| Claude Code | [Claude plugin](#claude-code) | Plugin settings form |
| Claude desktop app (Cowork) | [Claude plugin](#claude-desktop-app-cowork) | `set_client_id` from chat |
| Codex CLI, ChatGPT desktop app | [Codex plugin](#codex) | `set_client_id` from chat |
| Cursor | [Cursor plugin](#cursor) or [MCP config](#any-other-mcp-client) | Plugin settings, or `X_CLIENT_ID` |
| Grok Bot | [Ready-made bot template](#grok-bot) | `set_client_id` from chat |
| Claude desktop chat, Windsurf, Cline and other MCP clients | [MCP config](#any-other-mcp-client) | `X_CLIENT_ID` in the config |
| claude.ai on the web and phone, other remote MCP clients | [Self-hosted remote server](#remote-server-self-hosted) | A secret on your Worker |

All plugin installs include the same MCP server plus a skill that tells the agent how to use it safely: confirm before acting, always name the account, mind the costs, and how to authorize. Everything runs locally, so plugins work only where the client runs on your computer. For web and mobile chat, deploy the [remote server](#remote-server-self-hosted).

Wherever the Client ID isn't asked for at install time, either ask the agent to call `set_client_id` with it, or run `npx x-api-mcp config --client-id your-client-id` once in a terminal. It is saved in `~/.x-api-mcp/app.json`; an `X_CLIENT_ID` environment variable wins when both are set.

### Claude Code

```
/plugin install x-api-mcp --marketplace fatwang2/x-api-mcp
```

Choose a scope, then fill in your Client ID and options in the settings dialog (reopen it with `/plugin configure x-api-mcp@x-api-mcp`). From a shell: `claude plugin install x-api-mcp --marketplace fatwang2/x-api-mcp`.

### Claude desktop app (Cowork)

In **Customize > Plugins**, add the GitHub marketplace `fatwang2/x-api-mcp` and install **x-api-mcp**. It runs in Cowork sessions on your computer. Cowork doesn't show plugin settings, so set the Client ID with `set_client_id`. For regular desktop chat, use the [MCP config](#any-other-mcp-client) instead.

### Codex

```
codex plugin marketplace add fatwang2/x-api-mcp
```

Then install **X API** from that marketplace in the Plugins Directory (Codex CLI or the ChatGPT desktop app), and set the Client ID with `set_client_id`.

### Cursor

Install **x-api-mcp** from **Customize** once it is listed, or have a Teams/Enterprise admin import this repository as a team marketplace (**Dashboard > Plugins & MCPs > Add Marketplace > Import from Repo**). Then fill in the Client ID and options under **Configure** on the plugin. Until then, the [MCP config](#any-other-mcp-client) works in Cursor too (`.cursor/mcp.json`).

### Grok Bot

Open the [X API MCP template](https://x.ai/bot/_ywDVKoIufUaFJ-zZ7tVJ) and select **Add to Grok Bot**. It runs this MCP server with the same safety rules (it confirms every post with you). Then give it your Client ID, which it saves with `set_client_id`, and [add your X account](#add-x-accounts).

### Any other MCP client

Add this to your client's MCP config (`claude_desktop_config.json`, `.cursor/mcp.json`, ...):

```json
{
  "mcpServers": {
    "x": {
      "command": "npx",
      "args": ["-y", "x-api-mcp"],
      "env": { "X_CLIENT_ID": "your-client-id", "X_REQUIRE_ACCOUNT": "1" }
    }
  }
}
```

Or, for Claude Code without the plugin:

```bash
claude mcp add x -e X_CLIENT_ID=your-client-id -- npx -y x-api-mcp
```

Requires Node.js 20 or later.

## Remote server (self-hosted)

The remote server is the same set of tools on a Cloudflare Worker, added to Claude as a custom connector. Use it when you want to post from claude.ai on the web or your phone. There is no shared instance: you deploy your own, on your own Cloudflare account, with your own X App, and only the X accounts you allow can sign in.

| | Local server | Remote server |
| --- | --- | --- |
| Runs on | Your computer, started by the client | A Worker on your Cloudflare account (free plan is enough to start) |
| Works in | Claude Code, desktop apps, Codex, Cursor and other local clients | claude.ai on the web, phone and desktop, and any client that supports remote MCP with OAuth |
| X App | Native App (no secret) | A separate **Web App** with a Client Secret |
| Tokens | `~/.x-api-mcp/tokens.json` | A Durable Object in your account |
| Who can use it | Whoever runs it | X accounts on `ALLOWED_X_USER_IDS` sign in to the connector; they can add more accounts to act as |
| Media | `file_path`, base64 | Public `media_url`, base64 up to 2 MB, and files uploaded on a one-time page into your R2 bucket |
| Extra tools | `set_client_id`, `complete_authorization` | `get_write_log`, `create_upload_link`, `list_uploads` |

### 1. Create an X Web App

Use a separate App from the one your local server uses, so each can be revoked on its own.

1. At [console.x.com](https://console.x.com), create an App and add pay-per-use credits.
2. Under **User authentication settings**: App permissions **Read and write** (plus **Direct Messages** if you want DM tools), Type of App **Web App**, Callback URI `https://<your-worker-host>/x/callback`.
3. Copy the OAuth 2.0 **Client ID** and **Client Secret**.

`<your-worker-host>` is either `x-api-mcp.<your-subdomain>.workers.dev` or your own domain. You can create the App first with your best guess and fix the Callback URI after deploying.

### 2. Deploy

**With the button:** it copies this repository into your GitHub account, creates the KV namespace, Durable Object and R2 bucket, and asks for the four secrets below.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/fatwang2/x-api-mcp)

**By hand** (Node.js 20 or later):

```bash
git clone https://github.com/fatwang2/x-api-mcp && cd x-api-mcp
npm install
npx wrangler login
cp .dev.vars.example .dev.vars           # fill in the four secrets (git ignores this file)
npx wrangler deploy --secrets-file .dev.vars
npx wrangler r2 bucket lifecycle add x-api-mcp-media expire-uploads uploads/ --expire-days 7
```

The first deploy creates the KV namespace and the R2 bucket. You can delete `.dev.vars` afterwards; the secrets live on the Worker, and `npx wrangler secret put <NAME>` changes one later.

The secrets:

| Secret | Value |
| --- | --- |
| `X_PUBLIC_BASE_URL` | `https://<your-worker-host>`, with no path |
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | From the X Web App |
| `ALLOWED_X_USER_IDS` | Numeric X user IDs allowed to sign in, comma separated. Empty allows nobody. If you don't know yours, sign in once: the refusal page shows it |

**Your own domain:** keep it out of the repository. Copy `wrangler.jsonc` to `wrangler.local.jsonc` (git ignores it), add `"routes": [{ "pattern": "x-api-mcp.example.com", "custom_domain": true }]` with your domain, and deploy with `npx wrangler deploy -c wrangler.local.jsonc`. Then set `X_PUBLIC_BASE_URL` and the X Callback URI to that domain.

Settings in `wrangler.jsonc`: `X_TOOLS` (`all` or `read`), `X_REQUIRE_ACCOUNT` (on; write tools must name their account), `X_MEDIA_WAIT_SECONDS` (how long an upload waits for X to process a video, default 20). `X_ENABLE_DM`, `X_SCOPES` and `X_DEFAULT_ACCOUNT` work as on the local server.

### 3. Add the connector to Claude

In claude.ai, open **Settings → Connectors → Add custom connector**, enter `https://<your-worker-host>/mcp`, and connect. You approve the connection on your server's page, then sign in with an allowed X account. That account is saved as the first one.

Set the write tools (`create_post`, `create_thread`, `delete_post`, `post_action`, `user_action`, `list_action`, `send_dm`) to ask for approval every time in the connector's tool settings. The server also tells Claude to confirm each visible action, and every write is recorded; ask Claude for `get_write_log` to see what was done.

Before relying on it, try it with a test account: post once, check `get_write_log`, then delete the post.

### Using it

- **More X accounts:** ask Claude to `add_account`. It gives you an X sign-in link; open it in a browser signed in to that account and approve. Accounts added this way don't need to be on the allowlist, since only a signed-in owner can start one.
- **Images and video:** give Claude a public https link (`media_url`), or ask for an upload link: `create_upload_link` returns a page that takes one file from your phone or computer within 15 minutes, and Claude attaches it by its `r2_key`. Videos up to 100 MB go through that page (Cloudflare's request size limit on Free and Pro plans). If X is still processing a video, Claude checks `get_media_status` and posts once it's ready.
- **Updating:** pull the latest code and deploy again (with the button, push to the copied repository).

## Add X accounts

On the local server, call `add_account` from chat (or run `npx x-api-mcp login` in a terminal) and open the returned URL. (On the remote server, see [Using it](#using-it).) Repeat to add more accounts. How the callback comes back depends on where the browser is:

- **Loopback** (browser on the same computer as the server): a listener on `127.0.0.1:8765` saves the token automatically.
- **Paste** (browser on another device, as with chat bots, remote agents or SSH): after approving, the browser lands on an error page at `http://127.0.0.1:8765/callback?...`. Copy that full URL and paste it back right away; the agent passes it to `complete_authorization`. X codes expire about 30 seconds after approval.

`X_AUTH_MODE=auto` (the default) uses paste over SSH and loopback otherwise. Set `X_AUTH_MODE=paste` explicitly for chat-bot hosts.

The first authorized account becomes the default. Set `X_REQUIRE_ACCOUNT=1` to make every write name its account, which is recommended with several accounts. Access tokens are refreshed automatically. X rotates refresh tokens, so concurrent refreshes from several MCP processes are serialized with a file lock.

## Tools

Endpoints are grouped by action rather than one tool per endpoint, so agents can choose easily. `X_TOOLS=write` registers only the account and write tools; DM tools appear only with `X_ENABLE_DM=1`. Every tool takes an optional `account` (defaults to the default account). Users can be given as `@username`, `username` or a numeric ID.

| Group | Tool | What it does |
| --- | --- | --- |
| Accounts | `set_client_id` `list_accounts` `add_account` `auth_status` `complete_authorization` `set_default_account` `remove_account` | App setup, multi-account OAuth and management; local except for the OAuth exchange |
| | `get_me` | Profile of the authorized account (read) |
| Posting | `create_post` | Post, reply, quote, poll, attach media (local files can be passed directly) |
| | `create_thread` | Publish a thread in order; stops at the first failure and returns what was posted |
| | `delete_post` | Delete a post |
| | `post_action` | like / unlike / repost / unrepost / bookmark / unbookmark / hide_reply / unhide_reply |
| Media | `upload_media` `get_media_status` | Images up to 5 MB in one request; GIFs, videos and large files via chunked upload, waiting for processing; optional alt text |
| Reading | `search` | `type=posts` searches the last 7 days, `type=users` searches accounts |
| | `get_posts` | Look up posts by ID |
| | `get_timeline` | home / posts / mentions / liked / bookmarks |
| | `get_post_engagement` | Liking users / reposted by / quote posts |
| Users | `get_users` | Look up profiles by username or ID |
| | `get_user_relations` | followers / following, plus your own muting / blocking lists |
| | `user_action` | follow / unfollow / mute / unmute / block / unblock |
| DMs | `send_dm` `get_dm_events` | Send a DM to a user or conversation (with media) / read DMs. Only with `X_ENABLE_DM=1` |
| Lists | `list_action` `get_lists` | Create, update, delete Lists and manage members / read owned Lists, List info, members and posts |
| Trends | `get_trends` | Personalized trends |

Almost every call is billed per use; see the [pricing page](https://docs.x.com/x-api/getting-started/pricing) and your console for current rates. Posts containing a URL cost noticeably more. X documents `quote_post_id` and blocking as Enterprise-only.

By default authorization requests every scope these tools use except DM scopes, because an App without Direct Messages permission rejects the whole request when they are asked for. If an account was authorized with fewer scopes, calls that need a missing scope fail before reaching X with a hint to run `add_account` again.

The remote server leaves out `set_client_id` and `complete_authorization`, has no `file_path` media source, and adds `get_write_log`, `create_upload_link` and `list_uploads`.

Not covered: Spaces, bookmark folders, DM deletion, streaming endpoints, Ads and compliance endpoints.

## Configuration

All settings are optional environment variables. Plugin installs fill them from the plugin's settings form where the host has one.

| Variable | Default | Notes |
| --- | --- | --- |
| `X_CLIENT_ID` | none | Your App's Client ID. Can be saved with `set_client_id` instead |
| `X_CLIENT_SECRET` | none | Only for Web Apps (confidential clients) |
| `X_AUTH_MODE` | `auto` | `loopback`, `paste`, or `auto` (paste over SSH) |
| `X_TOOLS` | `all` | `write` registers only account and write tools; `read` only account and read tools |
| `X_REQUIRE_ACCOUNT` | off | `1` makes write tools refuse calls without `account` |
| `X_ENABLE_DM` | off | `1` requests `dm.read dm.write` and registers the DM tools. The App needs Direct Messages permission |
| `X_REDIRECT_URI` | `http://127.0.0.1:8765/callback` | Must match the App settings |
| `X_SCOPES` | All non-DM scopes the tools use (see `src/config.ts`) | Set to narrow permissions |
| `X_API_MCP_HOME` | `~/.x-api-mcp` | Storage directory for tokens and the saved Client ID |
| `X_DEFAULT_ACCOUNT` | none | Used when no default account is set locally |

## CLI

```
x-api-mcp                       Run the MCP server on stdio
x-api-mcp config --client-id <id> [--client-secret <s>]
                                Save your App's Client ID locally
x-api-mcp login                 Authorize a new account in the browser
x-api-mcp accounts              List accounts (* marks the default)
x-api-mcp default <username>    Set the default account
x-api-mcp logout <username>     Remove an account and revoke its tokens
x-api-mcp post [--account a] <text>   Publish a quick test post
```

## Privacy Policy

x-api-mcp runs entirely on your computer. It has no server of its own and the author collects no data.

- **What it stores:** your X App's Client ID (and secret, if you use one) in `~/.x-api-mcp/app.json`, and OAuth access and refresh tokens plus basic account details (username, user ID, display name, granted scopes) in `~/.x-api-mcp/tokens.json`. Both files are readable only by your user account (mode 0600). Nothing else is stored.
- **Where data goes:** requests go directly from your computer to the X API (`api.x.com`) and X's OAuth pages, using your own App. Post text, media files, DMs and other content you ask the agent to send are transmitted only to X. No analytics or telemetry are collected.
- **Third parties:** your use of the X API is governed by the [X Developer Agreement and Policy](https://developer.x.com/en/developer-terms) and [X's Privacy Policy](https://x.com/en/privacy). Content returned by the tools is passed to the AI agent you run them in, under that agent provider's terms.
- **Remote server:** if you deploy it, the same data lives in your own Cloudflare account instead: X tokens and account details in a Durable Object, a log of writes (last 1000), and the connector's OAuth grants in KV. Files uploaded through `create_upload_link` are kept in your R2 bucket until your lifecycle rule removes them. Nothing goes to the author of this project.
- **Removal:** `remove_account` (or `x-api-mcp logout <username>`) revokes an account's tokens at X and deletes them locally. Deleting `~/.x-api-mcp` removes everything.
- **Contact:** open an issue at https://github.com/fatwang2/x-api-mcp/issues.

## Development

This section is for contributors. To use x-api-mcp you only need [Install](#install).

```bash
git clone https://github.com/fatwang2/x-api-mcp && cd x-api-mcp
npm install
npm test   # builds, then runs end-to-end tests against a local mock of the X API
```

To try a local build in a client, point its MCP config at `node /absolute/path/to/x-api-mcp/dist/index.js` instead of `npx -y x-api-mcp`.

`npm run test:worker` runs the remote server locally with `wrangler dev` against the same kind of mock (no Cloudflare account needed); `npm run worker:typecheck` and `npm run worker:build` check and bundle it without deploying.

The tests cover OAuth (loopback and paste), refresh-token rotation, the concurrency lock, threads, chunked upload, interactions, DMs, tool-group switches and the stdio protocol.

Layout: `src/oauth.ts` (PKCE and token endpoint), `src/auth.ts` (authorization flow and loopback callback), `src/store.ts` (token file and lock), `src/client.ts` (API client with auto refresh and scope checks), `src/posts.ts` (posting), `src/social.ts` (interactions, relationships, timelines, DMs, Lists), `src/shape.ts` (response trimming), `src/media.ts`, `src/server.ts` (MCP tool registration), `src/index.ts` (entry point and CLI). The remote server lives in `worker/` (see [`worker/README.md`](worker/README.md)) and reuses everything in `src/` except the file store and the local auth flow.

### Plugin files

The repository root is the plugin for every host; they share the agent skill in [`skills/x-api-mcp/SKILL.md`](skills/x-api-mcp/SKILL.md) and launch `npx -y x-api-mcp@<version>`.

| File | Read by |
| --- | --- |
| `.claude-plugin/plugin.json`, `.mcp.json`, `.claude-plugin/marketplace.json` | Claude Code and Cowork (`userConfig` settings) |
| `.cursor-plugin/plugin.json` (reuses `mcp.json`) | Cursor (`variables` settings) |
| `plugin.json`, `mcp.json`, `.agents/plugins/marketplace.json` | Codex and other [Agent Plugins](https://agent-plugins.org/specification) hosts; Codex listing details live under `extensions.com.openai` |

Validate the Claude plugin with `claude plugin validate .claude-plugin/plugin.json` (and the marketplace with `claude plugin validate .`). `npm version` keeps the version in all of these files in step with `package.json` (`scripts/sync-version.mjs`).

### Releasing

Releases are published by GitHub Actions when a version tag is pushed:

```bash
npm version patch          # or minor / major; also updates the version pinned in the plugin files
git push --follow-tags
```

`.github/workflows/release.yml` checks that the tag matches `package.json`, runs the tests, publishes to npm with provenance and creates a GitHub release. It runs in the `npm` GitHub environment and authenticates with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (GitHub repository `fatwang2/x-api-mcp`, workflow `release.yml`, environment `npm`), so no npm token is stored. A version that is already on npm is skipped.

## References

- [OAuth 2.0 PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code), [Create Post](https://docs.x.com/x-api/posts/create-post), [Chunked media upload](https://docs.x.com/x-api/media/quickstart/media-upload-chunked)
- [xdevplatform/xurl](https://github.com/xdevplatform/xurl), [xdevplatform/xmcp](https://github.com/xdevplatform/xmcp)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

## License

MIT

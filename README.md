# x-api-mcp

A **local stdio MCP server** for the official X API v2, built around multi-account posting: posts, replies, threads, deletes, and image/GIF/video uploads (including chunked upload). It also covers likes, reposts, bookmarks, follows, timelines, search, DMs, Lists and trends.

X's official remote MCP server can't post. This project fills that gap.

## Why stdio

The server runs on your own machine, launched by your MCP client (Claude Desktop, Claude Code, Cursor, ...) as a child process. OAuth and access/refresh tokens stay in `~/.x-api-mcp/tokens.json` (mode 0600) and never pass through a third-party server.

## Create an X App

Each user brings their own X App, and API usage is billed to that App's credits.

1. Create an App at [console.x.com](https://console.x.com) and add pay-per-use credits.
2. Under **User authentication settings**:
   - App permissions: **Read and write** (add **Direct Messages** if you want DM tools)
   - Type of App: **Native App** (public client, no secret needed, recommended). A Web App also works; set `X_CLIENT_SECRET` as well.
   - Callback URI: `http://127.0.0.1:8765/callback` (must exactly match `X_REDIRECT_URI`)
3. Copy the OAuth 2.0 **Client ID**.

## Install

### As a Claude plugin

```
/plugin install x-api-mcp --marketplace fatwang2/x-api-mcp
```

The plugin bundles the MCP server and a skill that tells the agent how to use it safely (confirm before acting, always name the account, mind the costs, how to authorize). It asks for your Client ID and a few options when enabled. Hosts that don't prompt for plugin settings can call `set_client_id` instead.

### As a plain MCP server

Claude Desktop / Cursor (`claude_desktop_config.json` / `.cursor/mcp.json`):

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

Claude Code:

```bash
claude mcp add x -e X_CLIENT_ID=your-client-id -- npx -y x-api-mcp
```

The Client ID can also be saved once with `npx x-api-mcp config --client-id your-client-id` or from chat with the `set_client_id` tool. It is stored in `~/.x-api-mcp/app.json`, and `X_CLIENT_ID` wins when both are set.

The agent guidance lives in [`skills/x-api-mcp/SKILL.md`](skills/x-api-mcp/SKILL.md). The `plugin.json` and `mcp.json` at the repository root describe the same bundle for hosts that use the agent-plugins format.

## Authorize accounts

Call `add_account` from chat (or run `npx x-api-mcp login` in a terminal) and open the returned URL. Repeat to add more accounts. How the callback comes back depends on where the browser is:

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

Not covered: Spaces, bookmark folders, DM deletion, streaming endpoints, Ads and compliance endpoints.

## Environment variables

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

## Development

```bash
npm install
npm test   # builds, then runs end-to-end tests against a local mock of the X API
```

The tests cover OAuth (loopback and paste), refresh-token rotation, the concurrency lock, threads, chunked upload, interactions, DMs, tool-group switches and the stdio protocol. Validate the plugin bundle with `claude plugin validate .`.

Layout: `src/oauth.ts` (PKCE and token endpoint), `src/auth.ts` (authorization flow and loopback callback), `src/store.ts` (token file and lock), `src/client.ts` (API client with auto refresh and scope checks), `src/posts.ts` (posting), `src/social.ts` (interactions, relationships, timelines, DMs, Lists), `src/shape.ts` (response trimming), `src/media.ts`, `src/server.ts` (MCP tool registration), `src/index.ts` (entry point and CLI).

## Releasing

Releases are published by GitHub Actions when a version tag is pushed:

```bash
npm version patch          # or minor / major; also updates the version pinned in the plugin files
git push --follow-tags
```

`.github/workflows/release.yml` checks that the tag matches `package.json`, runs the tests, publishes to npm with provenance and creates a GitHub release. It runs in the `npm` GitHub environment and authenticates with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (GitHub repository `fatwang2/x-api-mcp`, workflow `release.yml`, environment `npm`), so no npm token is stored. A version that is already on npm is skipped.

## Privacy Policy

x-api-mcp runs entirely on your computer. It has no server of its own and the author collects no data.

- **What it stores:** your X App's Client ID (and secret, if you use one) in `~/.x-api-mcp/app.json`, and OAuth access and refresh tokens plus basic account details (username, user ID, display name, granted scopes) in `~/.x-api-mcp/tokens.json`. Both files are readable only by your user account (mode 0600). Nothing else is stored.
- **Where data goes:** requests go directly from your computer to the X API (`api.x.com`) and X's OAuth pages, using your own App. Post text, media files, DMs and other content you ask the agent to send are transmitted only to X. No analytics or telemetry are collected.
- **Third parties:** your use of the X API is governed by the [X Developer Agreement and Policy](https://developer.x.com/en/developer-terms) and [X's Privacy Policy](https://x.com/en/privacy). Content returned by the tools is passed to the AI agent you run them in, under that agent provider's terms.
- **Removal:** `remove_account` (or `x-api-mcp logout <username>`) revokes an account's tokens at X and deletes them locally. Deleting `~/.x-api-mcp` removes everything.
- **Contact:** open an issue at https://github.com/fatwang2/x-api-mcp/issues.

## References

- [OAuth 2.0 PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code), [Create Post](https://docs.x.com/x-api/posts/create-post), [Chunked media upload](https://docs.x.com/x-api/media/quickstart/media-upload-chunked)
- [xdevplatform/xurl](https://github.com/xdevplatform/xurl), [xdevplatform/xmcp](https://github.com/xdevplatform/xmcp)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

## License

MIT

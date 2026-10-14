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

## Install and configure

```bash
npm install && npm run build
```

Claude Desktop / Cursor (`claude_desktop_config.json` / `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "x": {
      "command": "node",
      "args": ["/absolute/path/to/x-api-mcp/dist/index.js"],
      "env": { "X_CLIENT_ID": "your-client-id" }
    }
  }
}
```

Claude Code:

```bash
claude mcp add x -e X_CLIENT_ID=your-client-id -- node /absolute/path/to/x-api-mcp/dist/index.js
```

## Authorize accounts

Either way works, and you can repeat it to add more accounts:

- **From chat:** ask the agent to call `add_account`, open the returned URL and click Authorize. A local listener catches the callback and saves the token.
- **From the terminal:** `X_CLIENT_ID=... node dist/index.js login` opens the browser and waits for the callback.

The first authorized account becomes the default. Pick another per call with `account: "username"`, or switch with `set_default_account`. Access tokens are refreshed automatically before they expire. X rotates refresh tokens, so concurrent refreshes from several MCP processes are serialized with a file lock.

## Tools

Endpoints are grouped by action rather than one tool per endpoint: 25 tools in total, so agents can choose easily. Every tool takes an optional `account` (defaults to the default account). Users can be given as `@username`, `username` or a numeric ID.

| Group | Tool | What it does |
| --- | --- | --- |
| Accounts | `list_accounts` `add_account` `auth_status` `complete_authorization` `set_default_account` `remove_account` `get_me` | Multi-account OAuth and management; only `get_me` calls the API |
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
| DMs | `send_dm` `get_dm_events` | Send a DM to a user or conversation (with media) / read DMs |
| Lists | `list_action` `get_lists` | Create, update, delete Lists and manage members / read owned Lists, List info, members and posts |
| Trends | `get_trends` | Personalized trends |

Almost every call is billed per use; see the [pricing page](https://docs.x.com/x-api/getting-started/pricing) and your console for current rates. Posts containing a URL cost noticeably more. X documents `quote_post_id` and blocking as Enterprise-only.

By default authorization requests every scope these tools use. If an account was authorized with fewer scopes, calls that need a missing scope fail before reaching X with a hint to run `add_account` again.

Not covered: Spaces, bookmark folders, DM deletion, streaming endpoints, Ads and compliance endpoints.

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `X_CLIENT_ID` | none | Required |
| `X_CLIENT_SECRET` | none | Only for Web Apps (confidential clients) |
| `X_REDIRECT_URI` | `http://127.0.0.1:8765/callback` | Must match the App settings |
| `X_SCOPES` | All scopes the tools use (see `src/config.ts`) | Set to narrow permissions |
| `X_API_MCP_HOME` | `~/.x-api-mcp` | Token storage directory |
| `X_DEFAULT_ACCOUNT` | none | Used when no default account is set locally |

## CLI

```
x-api-mcp                       Run the MCP server on stdio
x-api-mcp login                 Authorize a new account in the browser
x-api-mcp accounts              List accounts (* marks the default)
x-api-mcp default <username>    Set the default account
x-api-mcp logout <username>     Remove an account and revoke its tokens
x-api-mcp post [--account a] <text>   Publish a quick test post
```

## Development

```bash
npm test   # builds, then runs end-to-end tests against a local mock of the X API
```

The tests cover OAuth, refresh-token rotation, the concurrency lock, threads, chunked upload, interactions, DMs and the stdio protocol.

Layout: `src/oauth.ts` (PKCE and token endpoint), `src/auth.ts` (authorization flow and loopback callback), `src/store.ts` (token file and lock), `src/client.ts` (API client with auto refresh and scope checks), `src/posts.ts` (posting), `src/social.ts` (interactions, relationships, timelines, DMs, Lists), `src/shape.ts` (response trimming), `src/media.ts`, `src/server.ts` (MCP tool registration), `src/index.ts` (entry point and CLI).

## References

- [OAuth 2.0 PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code), [Create Post](https://docs.x.com/x-api/posts/create-post), [Chunked media upload](https://docs.x.com/x-api/media/quickstart/media-upload-chunked)
- [xdevplatform/xurl](https://github.com/xdevplatform/xurl), [xdevplatform/xmcp](https://github.com/xdevplatform/xmcp)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

## License

MIT

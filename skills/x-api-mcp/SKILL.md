---
name: x-api-mcp
description: Rules for acting on X (Twitter) through the x-api-mcp tools - posting, replies, threads, DMs, follows, likes, multi-account selection, costs, and authorizing accounts. Use whenever an x-api-mcp tool is about to be called.
---

# Using x-api-mcp

These tools act on real X accounts and every API call is billed to the user's own X App. Follow these rules every time.

## Confirm before acting

Before any action that is visible to others, show the user exactly what will happen and wait for an explicit yes:

- `create_post`, `create_thread`: the account, the full text of every post, attached media, and the post being replied to or quoted.
- `send_dm`: the account, the recipient, and the full message.
- `user_action` (follow, unfollow, mute, block, ...), `post_action` (like, repost, bookmark, hide reply, ...), `delete_post`, `list_action`: the account, the action and its target.

One confirmation covers only the action it describes. If the text, account or target changes, ask again. Never post, message, follow or like on your own initiative.

## Always name the account

Pass `account` on every call, even when only one account is authorized. Call `list_accounts` (free) when unsure which accounts exist, and ask the user which one to use if they did not say. Never rely on the default account for anything that writes.

## Costs

X bills each call to the user's App (pay-per-use). Approximate prices; check the console for current rates:

| Action | Approx. cost |
| --- | --- |
| Post without a link | $0.015 |
| Post containing a URL | $0.20 |
| Delete, like, follow and other writes | about $0.01 each |
| Reads (posts, users, followers, timelines, search) | billed per item returned, e.g. $0.005 per post, $0.01 per user |

- Mention the cost before posting anything with a link, and before threads with many posts.
- Keep `max_results` small on reads, and do not page through results unless the user asked for it.
- `list_accounts`, `set_client_id`, `set_default_account` and `auth_status` are free and local.

## Follows and other relationship actions

Follow few accounts, chosen deliberately, and only ones the user named or approved one by one. Never follow, unfollow or like in bulk or in loops; X treats that as spam and may restrict the account.

## Reading posts

Read tools cost money. When the host agent already has its own free way to read public posts (for example Grok Bot's built-in public X reading), use that instead and keep these tools for writing. Some installs register only write tools (`X_TOOLS=write`).

## Authorizing an account

1. If `add_account` says no Client ID is configured, ask the user for the OAuth 2.0 Client ID of their own X App (console.x.com, Native App, callback `http://127.0.0.1:8765/callback`) and call `set_client_id`.
2. Call `add_account` and give the user `authorize_url` together with the `note` it returns.
3. Follow the returned `mode`:
   - `loopback`: the user approves in a browser on the same computer as this server, and the token is saved automatically. Confirm with `auth_status` or `list_accounts`.
   - `paste`: the browser is on another device (a chat bot, a remote agent, SSH). After approving, the browser opens `http://127.0.0.1:8765/callback?state=...&code=...` and shows an error page. That is expected. Ask the user to copy the whole URL from the address bar and send it immediately, then call `complete_authorization` with it at once. X codes expire about 30 seconds after approval; if it fails with an invalid or expired code, call `add_account` again.
4. If the X authorization page shows "Something went wrong", check that the App's callback URL matches exactly and that the requested permissions are enabled for the App (Direct Messages scopes are requested only when `X_ENABLE_DM` is on).

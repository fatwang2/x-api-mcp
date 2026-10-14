import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AuthManager } from "./auth.js";
import { XClient } from "./client.js";
import { mediaStatus, uploadMedia } from "./media.js";
import { createPost, createThread, deletePost, getMe, searchRecent } from "./posts.js";
import {
  getDmEvents,
  getLists,
  getPostEngagement,
  getPosts,
  getTimeline,
  getTrends,
  getUserRelations,
  getUsers,
  listAction,
  postAction,
  searchUsers,
  sendDm,
  userAction,
} from "./social.js";
import { VERSION } from "./version.js";

const account = z
  .string()
  .optional()
  .describe("X username of an authorized account (see list_accounts). Omit to use the default account.");

const mediaFiles = z
  .array(z.object({ file_path: z.string().describe("Absolute path to a local image/GIF/video"), alt_text: z.string().max(1000).optional() }))
  .max(4)
  .optional()
  .describe("Local files to upload and attach in one step (max 4 images, or 1 GIF/video).");

const mediaIds = z.array(z.string()).max(4).optional().describe("media_id values returned by upload_media");

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(e: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: (e as Error)?.message ?? String(e) }] };
}
const run =
  <A>(fn: (a: A) => Promise<unknown>) =>
  async (a: A) => {
    try {
      return ok(await fn(a));
    } catch (e) {
      return fail(e);
    }
  };

export function createServer(client: XClient, auth: AuthManager): McpServer {
  const server = new McpServer({ name: "x-api-mcp", version: VERSION });

  // ---- accounts -------------------------------------------------------------------------

  server.registerTool(
    "list_accounts",
    {
      description: "List X accounts authorized on this machine and which one is the default. Local only, no API cost.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run(async () => {
      const data = client.store.read();
      return {
        default_account: data.default_account ?? null,
        accounts: Object.entries(data.accounts).map(([key, a]) => ({
          username: a.username,
          name: a.name,
          user_id: a.user_id,
          is_default: data.default_account === key,
          scope: a.scope,
          has_refresh_token: !!a.refresh_token,
          access_token_expires_at: new Date(a.expires_at).toISOString(),
          authorized_at: a.authorized_at,
        })),
      };
    }),
  );

  server.registerTool(
    "add_account",
    {
      description:
        "Start OAuth 2.0 (PKCE) to authorize another X account. Returns authorize_url for the user to open in a browser " +
        "logged in to that account. A local listener catches the callback and saves the token automatically; then call " +
        "auth_status with the returned state. Tokens are stored only on this machine.",
      inputSchema: {
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(300)
          .optional()
          .describe("Block up to this many seconds for the user to finish in the browser (default 0: return the URL immediately)."),
      },
      annotations: { openWorldHint: true },
    },
    run(async ({ wait_seconds }) => {
      const r = await auth.start();
      if (wait_seconds && r.listening) {
        const s = await auth.wait(r.state, wait_seconds * 1000);
        return { ...r, result: s };
      }
      return r;
    }),
  );

  server.registerTool(
    "auth_status",
    {
      description: "Check whether an authorization started with add_account has finished. Optionally wait for it.",
      inputSchema: {
        state: z.string().describe("state returned by add_account"),
        wait_seconds: z.number().int().min(0).max(300).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run(async ({ state, wait_seconds }) => (wait_seconds ? auth.wait(state, wait_seconds * 1000) : auth.status(state))),
  );

  server.registerTool(
    "complete_authorization",
    {
      description:
        "Fallback when the automatic callback listener is unavailable: finish add_account with the full callback URL " +
        "from the browser address bar (contains code and state). X codes expire ~30 seconds after approval.",
      inputSchema: { redirect_url: z.string().describe("Full callback URL, e.g. http://127.0.0.1:8765/callback?state=...&code=...") },
      annotations: { openWorldHint: true },
    },
    run(({ redirect_url }) => auth.complete({ redirect_url })),
  );

  server.registerTool(
    "set_default_account",
    {
      description: "Choose which authorized account is used when a tool call omits `account`.",
      inputSchema: { account: z.string() },
      annotations: { openWorldHint: false, idempotentHint: true },
    },
    run(async ({ account }) => {
      const key = client.resolveAccount(account);
      await client.store.withLock(async () => {
        const data = client.store.read();
        data.default_account = key;
        client.store.write(data);
      });
      return { default_account: client.getAccount(key).username };
    }),
  );

  server.registerTool(
    "remove_account",
    {
      description: "Forget an authorized account on this machine and revoke its tokens at X.",
      inputSchema: {
        account: z.string(),
        revoke: z.boolean().optional().describe("Also revoke the tokens at X (default true)"),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    run(({ account, revoke }) => auth.remove(account, revoke ?? true)),
  );

  server.registerTool(
    "get_me",
    {
      description: "Fetch the authenticated user's profile via GET /2/users/me (billed as a user read).",
      inputSchema: { account },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(({ account }) => getMe(client, account)),
  );

  // ---- posting --------------------------------------------------------------------------

  server.registerTool(
    "create_post",
    {
      description:
        "Publish a post as the given account; also used to reply (reply_to_post_id). Attach media via media_files " +
        "(uploads for you) or media_ids. Spends pay-per-use credits (roughly $0.015 per post, much more if the text " +
        "contains a URL; check current pricing in the X console). Only call when the user has confirmed the exact text and account.",
      inputSchema: {
        account,
        text: z.string().optional().describe("Post text. Required unless media is attached."),
        reply_to_post_id: z.string().optional().describe("Post ID to reply to"),
        quote_post_id: z.string().optional().describe("Post ID to quote (X currently limits this to Enterprise access)"),
        media_ids: mediaIds,
        media_files: mediaFiles,
        poll: z
          .object({
            options: z.array(z.string().min(1).max(25)).min(2).max(4),
            duration_minutes: z.number().int().min(5).max(10080),
          })
          .optional(),
        reply_settings: z.enum(["following", "mentionedUsers", "subscribers", "verified"]).optional().describe("Who can reply"),
        community_id: z.string().optional(),
        made_with_ai: z.boolean().optional().describe("Disclose AI-generated media"),
        paid_partnership: z.boolean().optional().describe("Disclose a paid partnership"),
      },
      annotations: { openWorldHint: true },
    },
    run((a) => createPost(client, a)),
  );

  server.registerTool(
    "create_thread",
    {
      description:
        "Publish a thread: each post replies to the previous one. Stops at the first failure and reports what was posted. " +
        "Each post is billed like create_post.",
      inputSchema: {
        account,
        posts: z
          .array(z.object({ text: z.string().optional(), media_ids: mediaIds, media_files: mediaFiles }))
          .min(1)
          .max(25),
        reply_to_post_id: z.string().optional().describe("Attach the thread under an existing post"),
      },
      annotations: { openWorldHint: true },
    },
    async (a) => {
      try {
        const r = await createThread(client, a);
        return r.complete ? ok(r) : { ...ok(r), isError: true };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "delete_post",
    {
      description: "Delete a post owned by the given account (billed per request).",
      inputSchema: { account, post_id: z.string() },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(({ account, post_id }) => deletePost(client, account, post_id)),
  );

  server.registerTool(
    "post_action",
    {
      description:
        "Interact with a post as the given account: like, unlike, repost, unrepost, bookmark, unbookmark, " +
        "hide_reply or unhide_reply (replies to your own posts).",
      inputSchema: {
        account,
        action: z.enum(["like", "unlike", "repost", "unrepost", "bookmark", "unbookmark", "hide_reply", "unhide_reply"]),
        post_id: z.string(),
      },
      annotations: { openWorldHint: true, idempotentHint: true },
    },
    run((a) => postAction(client, a)),
  );

  // ---- media ----------------------------------------------------------------------------

  server.registerTool(
    "upload_media",
    {
      description:
        "Upload an image, GIF or video and return its media_id for create_post. Images <= 5 MB go in one request; " +
        "GIFs, videos and larger files use chunked upload and wait for processing. Optional alt text.",
      inputSchema: {
        account,
        file_path: z.string().optional().describe("Absolute path to a local file (jpg/png/webp/gif/mp4/mov)"),
        base64: z.string().optional().describe("Base64 data (or data: URL) instead of file_path"),
        mime_type: z.string().optional().describe("Required for base64 without a data: prefix"),
        media_category: z
          .enum(["tweet_image", "tweet_gif", "tweet_video", "dm_image", "dm_gif", "dm_video", "subtitles"])
          .optional()
          .describe("Inferred from the file type for posts; use dm_* for direct messages"),
        alt_text: z.string().max(1000).optional(),
      },
      annotations: { openWorldHint: true },
    },
    run((a) => uploadMedia(client, a)),
  );

  server.registerTool(
    "get_media_status",
    {
      description: "Check processing status of an uploaded video/GIF.",
      inputSchema: { account, media_id: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ account, media_id }) => (await mediaStatus(client, account, media_id)).data),
  );

  // ---- reading --------------------------------------------------------------------------

  const paging = {
    max_results: z.number().int().min(1).max(1000).optional().describe("Page size; clamped to what the endpoint allows"),
    pagination_token: z.string().optional().describe("meta.next_token from the previous page"),
  };
  const user = z.string().describe('A user: "@username", "username", or a numeric user ID');

  server.registerTool(
    "search",
    {
      description:
        "Search X. type=posts: posts from the last 7 days (billed per post returned, keep max_results small). " +
        "type=users: search accounts by keyword.",
      inputSchema: {
        account,
        type: z.enum(["posts", "users"]).optional().describe("Default posts"),
        query: z.string().min(1).max(4096).describe("For posts, X search syntax, e.g. 'from:xdevelopers -is:retweet'"),
        max_results: z.number().int().min(1).max(1000).optional().describe("posts: 10-100 (default 10); users: 1-1000 (default 10)"),
        sort_order: z.enum(["recency", "relevancy"]).optional().describe("posts only"),
        start_time: z.string().optional().describe("posts only; ISO 8601 within the last 7 days"),
        end_time: z.string().optional().describe("posts only"),
        next_token: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(({ type, ...a }) => (type === "users" ? searchUsers(client, a) : searchRecent(client, a))),
  );

  server.registerTool(
    "get_posts",
    {
      description: "Look up posts by ID (1-100), with author, metrics, media and referenced posts. Billed per post.",
      inputSchema: { account, ids: z.array(z.string()).min(1).max(100) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run((a) => getPosts(client, a)),
  );

  server.registerTool(
    "get_timeline",
    {
      description:
        "Read a timeline. type: home (your reverse-chronological home feed), posts (a user's posts), mentions, " +
        "liked (posts a user liked), bookmarks (yours). `user` defaults to the account itself. Billed per post returned.",
      inputSchema: {
        account,
        type: z.enum(["home", "posts", "mentions", "liked", "bookmarks"]),
        user: user.optional(),
        ...paging,
        exclude: z.array(z.enum(["replies", "retweets"])).optional().describe("home/posts only"),
        start_time: z.string().optional().describe("home/posts/mentions; ISO 8601"),
        end_time: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run((a) => getTimeline(client, a)),
  );

  server.registerTool(
    "get_post_engagement",
    {
      description: "Who engaged with a post. type: liking_users, reposted_by (users), or quotes (quote posts).",
      inputSchema: { account, post_id: z.string(), type: z.enum(["liking_users", "reposted_by", "quotes"]), ...paging },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run((a) => getPostEngagement(client, a)),
  );

  // ---- users ----------------------------------------------------------------------------

  server.registerTool(
    "get_users",
    {
      description: "Look up user profiles by usernames or by numeric IDs (up to 100). Billed per user.",
      inputSchema: {
        account,
        usernames: z.array(z.string()).max(100).optional(),
        ids: z.array(z.string()).max(100).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run((a) => getUsers(client, a)),
  );

  server.registerTool(
    "get_user_relations",
    {
      description:
        "List followers or following of a user (default: the account itself), or the account's own muting/blocking list.",
      inputSchema: { account, type: z.enum(["followers", "following", "muting", "blocking"]), user: user.optional(), ...paging },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run((a) => getUserRelations(client, a)),
  );

  server.registerTool(
    "user_action",
    {
      description:
        "Follow, unfollow, mute, unmute, block or unblock a user as the given account. " +
        "X documents block as Enterprise-only, so it may be refused on pay-per-use apps.",
      inputSchema: { account, action: z.enum(["follow", "unfollow", "mute", "unmute", "block", "unblock"]), user },
      annotations: { openWorldHint: true, idempotentHint: true },
    },
    run((a) => userAction(client, a)),
  );

  // ---- direct messages ------------------------------------------------------------------

  server.registerTool(
    "send_dm",
    {
      description:
        "Send a direct message to a user (`to`) or into an existing conversation (`conversation_id`). " +
        "Media in media_files is uploaded with DM categories automatically. Only send when the user confirmed recipient and text.",
      inputSchema: {
        account,
        to: user.optional(),
        conversation_id: z.string().optional(),
        text: z.string().optional(),
        media_ids: z.array(z.string()).max(1).optional().describe("A media_id uploaded with a dm_* media_category"),
        media_files: mediaFiles,
      },
      annotations: { openWorldHint: true },
    },
    run((a) => sendDm(client, a)),
  );

  server.registerTool(
    "get_dm_events",
    {
      description: "Read recent direct messages: all conversations, one user (`with`), or one conversation_id.",
      inputSchema: { account, with: user.optional(), conversation_id: z.string().optional(), ...paging },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run((a) => getDmEvents(client, a)),
  );

  // ---- lists & trends -------------------------------------------------------------------

  server.registerTool(
    "list_action",
    {
      description: "Manage X Lists: create, update, delete, add_member, remove_member.",
      inputSchema: {
        account,
        action: z.enum(["create", "update", "delete", "add_member", "remove_member"]),
        list_id: z.string().optional().describe("Required except for create"),
        name: z.string().min(1).max(25).optional(),
        description: z.string().max(100).optional(),
        private: z.boolean().optional(),
        user: user.optional().describe("Member for add_member / remove_member"),
      },
      annotations: { openWorldHint: true },
    },
    run((a) => listAction(client, a)),
  );

  server.registerTool(
    "get_lists",
    {
      description: "Read Lists. type: owned (lists a user owns, default the account), info, members, or posts of list_id.",
      inputSchema: { account, type: z.enum(["owned", "info", "members", "posts"]), list_id: z.string().optional(), user: user.optional(), ...paging },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run((a) => getLists(client, a)),
  );

  server.registerTool(
    "get_trends",
    {
      description: "Personalized trends for the account.",
      inputSchema: { account },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run((a) => getTrends(client, a)),
  );

  return server;
}

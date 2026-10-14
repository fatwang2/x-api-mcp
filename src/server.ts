import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AuthManager } from "./auth.js";
import { XClient } from "./client.js";
import { mediaStatus, uploadMedia } from "./media.js";
import { createPost, createThread, deletePost, getMe, searchRecent } from "./posts.js";
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
        media_category: z.enum(["tweet_image", "tweet_gif", "tweet_video", "subtitles"]).optional(),
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

  server.registerTool(
    "search_recent_posts",
    {
      description:
        "Search posts from the last 7 days (GET /2/tweets/search/recent). Billed per post returned, so keep max_results small.",
      inputSchema: {
        account,
        query: z.string().min(1).max(4096).describe("X search query, e.g. 'from:xdevelopers -is:retweet'"),
        max_results: z.number().int().min(10).max(100).optional().describe("10-100, default 10"),
        sort_order: z.enum(["recency", "relevancy"]).optional(),
        start_time: z.string().optional().describe("ISO 8601, within the last 7 days"),
        end_time: z.string().optional(),
        next_token: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run((a) => searchRecent(client, a)),
  );

  return server;
}

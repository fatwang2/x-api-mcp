import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { removeAccount } from "./accounts.js";
import type { AuthManager } from "./auth.js";
import { XClient } from "./client.js";
import { type MediaSources, mediaStatus, offeredSources, uploadMedia } from "./media.js";
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

/** The media source fields this server offers (file_path locally; r2_key and media_url on the Worker). */
function mediaSourceFields(src: MediaSources) {
  return {
    ...(src.readFile ? { file_path: z.string().optional().describe("Absolute path to a local image/GIF/video") } : {}),
    ...(src.readR2 ? { r2_key: z.string().optional().describe("Key of a file uploaded through create_upload_link (see list_uploads)") } : {}),
    ...(src.urls ? { media_url: z.string().optional().describe("Public https URL of an image/GIF/video to fetch and upload") } : {}),
  };
}

function mediaFilesSchema(src: MediaSources) {
  const fields = mediaSourceFields(src);
  return z
    .array(z.object({ ...fields, alt_text: z.string().max(1000).optional() }))
    .max(4)
    .optional()
    .describe(
      `Media to upload and attach in one step, each item with one of ${Object.keys(fields).join(", ")} ` +
        "(max 4 images, or 1 GIF/video). A video that X is still processing makes the call fail with its media_id; " +
        "check get_media_status, then post with media_ids.",
    );
}

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

type Group = "account" | "read" | "write" | "dm-read" | "dm-write";

/** Rules for the model, sent to every client as the server's instructions (and in the plugin's skill). */
export const SERVER_INSTRUCTIONS = [
  "These tools act on real X accounts and every API call is billed to the user's own X App.",
  "Before anything visible to others (create_post, create_thread, send_dm, delete_post, post_action, user_action, list_action), " +
    "show the user the account, the exact text or the action and its target, and wait for an explicit yes. " +
    "One confirmation covers only the action it describes; ask again if the text, account or target changes.",
  "Never post, message, follow, like or repost on your own initiative, and never do any of these in bulk or in loops.",
  "Always pass `account` on calls that write, even with one account authorized; call list_accounts (free) when unsure and ask which to use.",
  "Mention the cost before posting anything with a link (about $0.20 per post) or long threads. Keep max_results small on reads.",
].join("\n");

const CONFIRMED = " Only call after the user confirmed the account and this exact action.";

export interface WriteLogEntry {
  at: string;
  tool: string;
  account?: string;
  /** Post, user, list or media IDs and the action involved, when the call names or returns them. */
  [detail: string]: unknown;
}

/** Record of every write the server performed, kept where the deployment can store it. */
export interface WriteLog {
  append(entry: WriteLogEntry): Promise<void>;
  /** Newest first. */
  list(limit: number): Promise<WriteLogEntry[]>;
}

/** Adding accounts from a remote server: add_account returns a sign-in link the server finishes itself. */
export interface WebAuth {
  start(): Promise<{ authorize_url: string; state: string; note: string }>;
  status(state: string): Promise<unknown>;
}

/** One-time browser upload links and the files they produced (R2 on the Worker). */
export interface Uploads {
  createLink(): Promise<unknown>;
  list(limit: number): Promise<unknown>;
}

export interface ServerOptions {
  /**
   * Account setup that only works on the user's own machine: the local OAuth flow (add_account,
   * auth_status, complete_authorization) and saving the X App's Client ID (set_client_id). The
   * remote Worker leaves this out and adds accounts through its own sign-in.
   */
  local?: {
    auth: AuthManager;
    saveClientId(clientId: string, clientSecret?: string): void;
  };
  /** Remote account setup: add_account and auth_status backed by the server's own callback. */
  webAuth?: WebAuth;
  /** When set, every successful write is recorded and get_write_log can read it back. */
  writeLog?: WriteLog;
  /** Browser uploads into the server's own storage (create_upload_link, list_uploads). */
  uploads?: Uploads;
  /** Extra options for the underlying MCP server (e.g. a JSON schema validator). */
  mcp?: ConstructorParameters<typeof McpServer>[1];
}

export function createServer(client: XClient, opts: ServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: "x-api-mcp", version: VERSION },
    { instructions: SERVER_INSTRUCTIONS, ...opts.mcp },
  );
  const cfg = client.cfg;
  const mediaFiles = mediaFilesSchema(client.media);

  /** Wrap a write tool so each call that did something is appended to the write log. */
  const logged =
    (tool: string, cb: (a: any) => any, log: WriteLog) =>
    async (a: any) => {
      const res = await cb(a);
      let data: any;
      try {
        data = JSON.parse(res?.content?.[0]?.text ?? "null");
      } catch {
        data = undefined;
      }
      if (res?.isError && !data?.posted?.length) return res;
      const ids = [data?.id, data?.post_id, ...(data?.posted ?? []).map((p: any) => p?.id)].filter(Boolean);
      const entry: WriteLogEntry = {
        at: new Date().toISOString(),
        tool,
        account: a?.account ?? (await client.resolveAccount().catch(() => undefined)),
        ...(a?.action ? { action: a.action } : {}),
        ...(a?.post_id ? { post_id: a.post_id } : {}),
        ...(a?.user ? { user: a.user } : {}),
        ...(a?.to ? { to: a.to } : {}),
        ...(a?.list_id ? { list_id: a.list_id } : {}),
        ...(ids.length ? { result_ids: [...new Set(ids.map(String))] } : {}),
        ...(res?.isError ? { partial: true } : {}),
      };
      try {
        await log.append(entry);
      } catch {
        // The write already happened; a failed log append must not turn it into an error.
      }
      return res;
    };

  /**
   * Register a tool unless config turns its group off: X_TOOLS picks read and/or write tools,
   * DM tools need X_ENABLE_DM, and X_REQUIRE_ACCOUNT makes write tools refuse an omitted account.
   */
  const register = (group: Group, name: string, config: any, cb: (a: any) => any) => {
    const kind = group.replace("dm-", "") as "account" | "read" | "write";
    if (group.startsWith("dm-") && !cfg.dmEnabled) return;
    if (kind !== "account" && !cfg.toolGroups.has(kind)) return;
    let handler = cb;
    if (kind === "write" && cfg.requireAccount) {
      handler = (a: any) =>
        a?.account
          ? cb(a)
          : fail(new Error(`"account" is required for ${name} (X_REQUIRE_ACCOUNT is on). Call list_accounts and pass the username to act as.`));
      config = { ...config, inputSchema: { ...config.inputSchema, account: z.string().describe("X username of the authorized account to act as (required)") } };
    }
    const writes = kind === "write" && !config.annotations?.readOnlyHint;
    if (writes) {
      config = { ...config, annotations: { readOnlyHint: false, ...config.annotations } };
      if (opts.writeLog) handler = logged(name, handler, opts.writeLog);
    }
    server.registerTool(name, config, handler);
  };

  // ---- accounts -------------------------------------------------------------------------

  register("account", "list_accounts",
    {
      description: "List the authorized X accounts and which one is the default. No API cost.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run(async () => {
      const data = await client.store.read();
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

  const local = opts.local;
  if (local) {
    const auth = local.auth;

    register(
      "account",
      "set_client_id",
      {
        description:
          "Save the OAuth 2.0 Client ID of the user's own X App (from console.x.com) on this machine, for hosts that " +
          "cannot pass the X_CLIENT_ID environment variable. Needed once before add_account. No API call.",
        inputSchema: {
          client_id: z.string().min(1),
          client_secret: z.string().optional().describe("Only for Web App (confidential) clients; Native Apps have none"),
        },
        annotations: { openWorldHint: false, idempotentHint: true },
      },
      run(async ({ client_id, client_secret }: { client_id: string; client_secret?: string }) => {
        local.saveClientId(client_id, client_secret);
        return {
          saved: true,
          active: cfg.clientId === client_id.trim(),
          ...(cfg.clientIdSource === "env" ? { note: "X_CLIENT_ID is set in the environment and takes precedence over the saved value." } : {}),
          next: "Call add_account to authorize an X account.",
        };
      }),
    );

    register("account", "add_account",
      {
        description:
          "Start OAuth 2.0 (PKCE) to authorize another X account. Returns authorize_url for the user to open in a browser " +
          "logged in to that account, and a note to relay to them. mode=loopback: a local listener saves the token " +
          "automatically; confirm with auth_status. mode=paste: ask the user to paste the callback URL from the address " +
          "bar right after approving and pass it to complete_authorization at once. Tokens are stored only on this machine.",
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

    register("account", "auth_status",
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

    register("account", "complete_authorization",
      {
        description:
          "Fallback when the automatic callback listener is unavailable: finish add_account with the full callback URL " +
          "from the browser address bar (contains code and state). X codes expire ~30 seconds after approval.",
        inputSchema: { redirect_url: z.string().describe("Full callback URL, e.g. http://127.0.0.1:8765/callback?state=...&code=...") },
        annotations: { openWorldHint: true },
      },
      run(({ redirect_url }) => auth.complete({ redirect_url })),
    );
  }

  if (!local && opts.webAuth) {
    const web = opts.webAuth;

    register("account", "add_account",
      {
        description:
          "Authorize another X account on this server. Returns authorize_url for the user to open in any browser " +
          "signed in to that account; after they click Authorize, the server saves the account by itself. Then confirm " +
          "with auth_status or list_accounts. The link works once and expires after 15 minutes.",
        annotations: { openWorldHint: true },
      },
      run(() => web.start()),
    );

    register("account", "auth_status",
      {
        description: "Check whether an authorization started with add_account has finished.",
        inputSchema: { state: z.string().describe("state returned by add_account") },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      run(({ state }) => web.status(state)),
    );
  }

  if (opts.writeLog) {
    const log = opts.writeLog;
    register("account", "get_write_log",
      {
        description:
          "List the most recent writes made through this server (posts, threads, deletes, likes, follows, DMs, list changes), " +
          "newest first, with the account and post IDs. No API cost.",
        inputSchema: { limit: z.number().int().min(1).max(200).optional().describe("How many entries (default 20)") },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      run(async ({ limit }) => ({ entries: await log.list(limit ?? 20) })),
    );
  }

  register("account", "set_default_account",
    {
      description: "Choose which authorized account is used when a tool call omits `account`.",
      inputSchema: { account: z.string() },
      annotations: { openWorldHint: false, idempotentHint: true },
    },
    run(async ({ account }) => {
      const key = await client.resolveAccount(account);
      await client.store.withLock(async () => {
        const data = await client.store.read();
        data.default_account = key;
        await client.store.write(data);
      });
      return { default_account: (await client.getAccount(key)).username };
    }),
  );

  register("account", "remove_account",
    {
      description: "Forget an authorized account and revoke its tokens at X.",
      inputSchema: {
        account: z.string(),
        revoke: z.boolean().optional().describe("Also revoke the tokens at X (default true)"),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    run(({ account, revoke }) => removeAccount(client, account, revoke ?? true)),
  );

  register("read", "get_me",
    {
      description: "Fetch the authenticated user's profile via GET /2/users/me (billed as a user read).",
      inputSchema: { account },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(({ account }) => getMe(client, account)),
  );

  // ---- posting --------------------------------------------------------------------------

  register("write", "create_post",
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
        made_with_ai: z.boolean().optional().describe("Disclose AI-generated media"),
        paid_partnership: z.boolean().optional().describe("Disclose a paid partnership"),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    run((a) => createPost(client, a)),
  );

  register("write", "create_thread",
    {
      description:
        "Publish a thread: each post replies to the previous one. Stops at the first failure and reports what was posted. " +
        "Each post is billed like create_post. Only call when the user has confirmed the exact text of every post and the account.",
      inputSchema: {
        account,
        posts: z
          .array(z.object({ text: z.string().optional(), media_ids: mediaIds, media_files: mediaFiles }))
          .min(1)
          .max(25),
        reply_to_post_id: z.string().optional().describe("Attach the thread under an existing post"),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
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

  register("write", "delete_post",
    {
      description: "Delete a post owned by the given account (billed per request)." + CONFIRMED,
      inputSchema: { account, post_id: z.string() },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    run(({ account, post_id }) => deletePost(client, account, post_id)),
  );

  register("write", "post_action",
    {
      description:
        "Interact with a post as the given account: like, unlike, repost, unrepost, bookmark, unbookmark, " +
        "hide_reply or unhide_reply (replies to your own posts)." + CONFIRMED,
      inputSchema: {
        account,
        action: z.enum(["like", "unlike", "repost", "unrepost", "bookmark", "unbookmark", "hide_reply", "unhide_reply"]),
        post_id: z.string(),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    run((a) => postAction(client, a)),
  );

  // ---- media ----------------------------------------------------------------------------

  register("write", "upload_media",
    {
      description:
        "Upload an image, GIF or video and return its media_id for create_post. Images <= 5 MB go in one request; " +
        "GIFs, videos and larger files are sent in 4 MB chunks. If X is still processing a video when this returns, " +
        "the result says so: call get_media_status until it succeeds before posting. Optional alt text. " +
        `Give one source: ${offeredSources(client.media).join(", ")}.`,
      inputSchema: {
        account,
        ...mediaSourceFields(client.media),
        base64: z
          .string()
          .optional()
          .describe(
            "Base64 data (or a data: URL)" +
              (client.media.base64MaxBytes ? `, at most ${Math.floor(client.media.base64MaxBytes / 1048576)} MB decoded` : ""),
          ),
        mime_type: z.string().optional().describe("Required for base64 without a data: prefix when the type can't be guessed"),
        media_category: z
          .enum(["tweet_image", "tweet_gif", "tweet_video", "dm_image", "dm_gif", "dm_video", "subtitles"])
          .optional()
          .describe("Inferred from the file type for posts; use dm_* for direct messages"),
        alt_text: z.string().max(1000).optional(),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    run((a) => uploadMedia(client, a)),
  );

  if (opts.uploads && cfg.toolGroups.has("write")) {
    const uploads = opts.uploads;
    server.registerTool("create_upload_link",
      {
        description:
          "Make a one-time link where the user can upload an image or video from their own device into this server's storage " +
          "(the link expires in 15 minutes and works once). Give the link to the user; after they upload, call list_uploads " +
          "and attach the file with media_files [{ r2_key }] or upload_media r2_key. Free; posts nothing.",
        inputSchema: {},
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      run(() => uploads.createLink()),
    );
    server.registerTool("list_uploads",
      {
        description: "List files uploaded through create_upload_link, newest first, with the r2_key to attach them. Free.",
        inputSchema: { limit: z.number().int().min(1).max(100).optional().describe("How many (default 10)") },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      run(({ limit }) => uploads.list(limit ?? 10)),
    );
  }

  register("write", "get_media_status",
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

  register("read", "search",
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

  register("read", "get_posts",
    {
      description: "Look up posts by ID (1-100), with author, metrics, media and referenced posts. Billed per post.",
      inputSchema: { account, ids: z.array(z.string()).min(1).max(100) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run((a) => getPosts(client, a)),
  );

  register("read", "get_timeline",
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

  register("read", "get_post_engagement",
    {
      description: "Who engaged with a post. type: liking_users, reposted_by (users), or quotes (quote posts).",
      inputSchema: { account, post_id: z.string(), type: z.enum(["liking_users", "reposted_by", "quotes"]), ...paging },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run((a) => getPostEngagement(client, a)),
  );

  // ---- users ----------------------------------------------------------------------------

  register("read", "get_users",
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

  register("read", "get_user_relations",
    {
      description:
        "List followers or following of a user (default: the account itself), or the account's own muting/blocking list.",
      inputSchema: { account, type: z.enum(["followers", "following", "muting", "blocking"]), user: user.optional(), ...paging },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run((a) => getUserRelations(client, a)),
  );

  register("write", "user_action",
    {
      description:
        "Follow, unfollow, mute, unmute, block or unblock a user as the given account. " +
        "X documents block as Enterprise-only, so it may be refused on pay-per-use apps." + CONFIRMED,
      inputSchema: { account, action: z.enum(["follow", "unfollow", "mute", "unmute", "block", "unblock"]), user },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    run((a) => userAction(client, a)),
  );

  // ---- direct messages ------------------------------------------------------------------

  register("dm-write", "send_dm",
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
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    run((a) => sendDm(client, a)),
  );

  register("dm-read", "get_dm_events",
    {
      description: "Read recent direct messages: all conversations, one user (`with`), or one conversation_id.",
      inputSchema: { account, with: user.optional(), conversation_id: z.string().optional(), ...paging },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run((a) => getDmEvents(client, a)),
  );

  // ---- lists & trends -------------------------------------------------------------------

  register("write", "list_action",
    {
      description: "Manage X Lists: create, update, delete, add_member, remove_member." + CONFIRMED,
      inputSchema: {
        account,
        action: z.enum(["create", "update", "delete", "add_member", "remove_member"]),
        list_id: z.string().optional().describe("Required except for create"),
        name: z.string().min(1).max(25).optional(),
        description: z.string().max(100).optional(),
        private: z.boolean().optional(),
        user: user.optional().describe("Member for add_member / remove_member"),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    run((a) => listAction(client, a)),
  );

  register("read", "get_lists",
    {
      description: "Read Lists. type: owned (lists a user owns, default the account), info, members, or posts of list_id.",
      inputSchema: { account, type: z.enum(["owned", "info", "members", "posts"]), list_id: z.string().optional(), user: user.optional(), ...paging },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run((a) => getLists(client, a)),
  );

  register("read", "get_trends",
    {
      description: "Personalized trends for the account.",
      inputSchema: { account },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run((a) => getTrends(client, a)),
  );

  return server;
}

import { XClient } from "./client.js";
import { uploadMedia } from "./media.js";

export interface MediaFile {
  file_path: string;
  alt_text?: string;
}

export interface PostInput {
  account?: string;
  text?: string;
  reply_to_post_id?: string;
  quote_post_id?: string;
  media_ids?: string[];
  media_files?: MediaFile[];
  poll?: { options: string[]; duration_minutes: number };
  reply_settings?: "following" | "mentionedUsers" | "subscribers" | "verified";
  community_id?: string;
  made_with_ai?: boolean;
  paid_partnership?: boolean;
}

export interface PostResult {
  id: string;
  text: string;
  url: string;
  account: string;
  media_ids?: string[];
}

export async function createPost(client: XClient, input: PostInput): Promise<PostResult> {
  const key = client.resolveAccount(input.account);
  const account = client.getAccount(key);
  const mediaIds = [...(input.media_ids ?? []).map(String)];
  for (const f of input.media_files ?? []) {
    const m = await uploadMedia(client, { account: key, file_path: f.file_path, alt_text: f.alt_text });
    mediaIds.push(m.media_id);
  }
  if (mediaIds.length > 4) throw new Error("A post can carry at most 4 media items.");
  if (!input.text && !mediaIds.length) throw new Error("text or media is required.");
  if (input.poll && mediaIds.length) throw new Error("A post cannot have both a poll and media.");

  const body: Record<string, unknown> = {};
  if (input.text) body.text = input.text;
  if (input.reply_to_post_id) body.reply = { in_reply_to_tweet_id: String(input.reply_to_post_id) };
  if (input.quote_post_id) body.quote_tweet_id = String(input.quote_post_id);
  if (mediaIds.length) body.media = { media_ids: mediaIds };
  if (input.poll) body.poll = input.poll;
  if (input.reply_settings) body.reply_settings = input.reply_settings;
  if (input.community_id) body.community_id = String(input.community_id);
  if (input.made_with_ai) body.made_with_ai = true;
  if (input.paid_partnership) body.paid_partnership = true;

  const j = await client.request(key, "POST", "/2/tweets", { json: body });
  return {
    id: j.data.id,
    text: j.data.text,
    url: `https://x.com/${account.username}/status/${j.data.id}`,
    account: account.username,
    ...(mediaIds.length ? { media_ids: mediaIds } : {}),
  };
}

export interface ThreadInput {
  account?: string;
  posts: Array<Pick<PostInput, "text" | "media_ids" | "media_files">>;
  reply_to_post_id?: string;
}

export interface ThreadResult {
  complete: boolean;
  posted: PostResult[];
  error?: { index: number; message: string };
}

/** Publish posts in order, each replying to the previous one. Stops at the first failure. */
export async function createThread(client: XClient, input: ThreadInput): Promise<ThreadResult> {
  if (!input.posts.length) throw new Error("posts must not be empty.");
  const key = client.resolveAccount(input.account);
  const posted: PostResult[] = [];
  let parent = input.reply_to_post_id;
  for (let i = 0; i < input.posts.length; i++) {
    try {
      const p = await createPost(client, { ...input.posts[i], account: key, reply_to_post_id: parent });
      posted.push(p);
      parent = p.id;
    } catch (e) {
      return { complete: false, posted, error: { index: i, message: (e as Error).message } };
    }
  }
  return { complete: true, posted };
}

export async function deletePost(client: XClient, account: string | undefined, postId: string) {
  const j = await client.request(client.resolveAccount(account), "DELETE", `/2/tweets/${encodeURIComponent(postId)}`);
  return { post_id: postId, deleted: !!j.data?.deleted };
}

export async function getMe(client: XClient, account?: string) {
  const key = client.resolveAccount(account);
  const j = await client.request(key, "GET", "/2/users/me", {
    query: {
      "user.fields":
        "created_at,description,location,profile_image_url,protected,public_metrics,url,verified,verified_type",
    },
  });
  // Keep stored display info fresh.
  await client.store.withLock(async () => {
    const data = client.store.read();
    const a = data.accounts[key];
    if (a && j.data) {
      a.name = j.data.name;
      a.username = j.data.username;
      client.store.write(data);
    }
  });
  return j.data;
}

export interface SearchInput {
  account?: string;
  query: string;
  max_results?: number;
  sort_order?: "recency" | "relevancy";
  start_time?: string;
  end_time?: string;
  next_token?: string;
}

export async function searchRecent(client: XClient, input: SearchInput) {
  const j = await client.request(client.resolveAccount(input.account), "GET", "/2/tweets/search/recent", {
    query: {
      query: input.query,
      max_results: Math.min(Math.max(input.max_results ?? 10, 10), 100),
      sort_order: input.sort_order,
      start_time: input.start_time,
      end_time: input.end_time,
      next_token: input.next_token,
      "post.fields": "created_at,author_id,conversation_id,public_metrics,lang",
      expansions: "author_id",
      "user.fields": "username,name,verified",
    },
  });
  const users = new Map<string, any>((j.includes?.users ?? []).map((u: any) => [u.id, u]));
  return {
    posts: (j.data ?? []).map((p: any) => {
      const u = users.get(p.author_id);
      return {
        ...p,
        author: u ? { username: u.username, name: u.name, verified: u.verified } : undefined,
        url: u ? `https://x.com/${u.username}/status/${p.id}` : `https://x.com/i/status/${p.id}`,
      };
    }),
    meta: j.meta,
  };
}

import { XClient } from "./client.js";
import { MediaCategory, uploadMedia } from "./media.js";
import { MediaFile } from "./posts.js";
import { POST_QUERY, USER_QUERY, shapePosts, shapeUsers } from "./shape.js";
import { accountKey } from "./store.js";

const enc = encodeURIComponent;
const clamp = (v: number | undefined, min: number, max: number, dflt: number) =>
  Math.min(Math.max(v ?? dflt, min), max);

/**
 * Turn a user reference into a numeric user ID. Digits are taken as an ID; "@name" or "name"
 * is looked up (free for locally authorized accounts, otherwise one user read).
 */
export async function resolveUserId(client: XClient, account: string, user: string): Promise<string> {
  const u = user.trim();
  if (/^\d{1,19}$/.test(u)) return u;
  const name = u.replace(/^@/, "");
  const local = client.store.read().accounts[accountKey(name)];
  if (local) return local.user_id;
  const j = await client.request(account, "GET", `/2/users/by/username/${enc(name)}`, { scopes: ["users.read"] });
  return j.data.id;
}

// ---- post interactions ------------------------------------------------------------------

export type PostActionName =
  | "like"
  | "unlike"
  | "repost"
  | "unrepost"
  | "bookmark"
  | "unbookmark"
  | "hide_reply"
  | "unhide_reply";

export async function postAction(client: XClient, a: { account?: string; action: PostActionName; post_id: string }) {
  const key = client.resolveAccount(a.account);
  const me = client.userId(key);
  const id = String(a.post_id);
  const [method, path, json, scopes]: [string, string, unknown, string[]] = {
    like: ["POST", `/2/users/${me}/likes`, { tweet_id: id }, ["like.write"]],
    unlike: ["DELETE", `/2/users/${me}/likes/${enc(id)}`, undefined, ["like.write"]],
    repost: ["POST", `/2/users/${me}/retweets`, { tweet_id: id }, ["tweet.write"]],
    unrepost: ["DELETE", `/2/users/${me}/retweets/${enc(id)}`, undefined, ["tweet.write"]],
    bookmark: ["POST", `/2/users/${me}/bookmarks`, { tweet_id: id }, ["bookmark.write"]],
    unbookmark: ["DELETE", `/2/users/${me}/bookmarks/${enc(id)}`, undefined, ["bookmark.write"]],
    hide_reply: ["PUT", `/2/tweets/${enc(id)}/hidden`, { hidden: true }, ["tweet.moderate.write"]],
    unhide_reply: ["PUT", `/2/tweets/${enc(id)}/hidden`, { hidden: false }, ["tweet.moderate.write"]],
  }[a.action] as [string, string, unknown, string[]];
  const j = await client.request(key, method, path, { json, scopes });
  return { action: a.action, post_id: id, result: j.data };
}

// ---- user relationships -----------------------------------------------------------------

export type UserActionName = "follow" | "unfollow" | "mute" | "unmute" | "block" | "unblock";

export async function userAction(client: XClient, a: { account?: string; action: UserActionName; user: string }) {
  const key = client.resolveAccount(a.account);
  const me = client.userId(key);
  const target = await resolveUserId(client, key, a.user);
  const coll = { follow: "following", unfollow: "following", mute: "muting", unmute: "muting", block: "blocking", unblock: "blocking" }[a.action];
  const scope = { following: "follows.write", muting: "mute.write", blocking: "block.write" }[coll]!;
  const undo = a.action.startsWith("un");
  const j = undo
    ? await client.request(key, "DELETE", `/2/users/${me}/${coll}/${target}`, { scopes: [scope] })
    : await client.request(key, "POST", `/2/users/${me}/${coll}`, { json: { target_user_id: target }, scopes: [scope] });
  return { action: a.action, user: a.user, user_id: target, result: j.data };
}

export async function getUserRelations(
  client: XClient,
  a: { account?: string; type: "followers" | "following" | "muting" | "blocking"; user?: string; max_results?: number; pagination_token?: string },
) {
  const key = client.resolveAccount(a.account);
  const self = a.type === "muting" || a.type === "blocking";
  if (self && a.user) throw new Error(`${a.type} can only be listed for the authorized account itself.`);
  const uid = a.user ? await resolveUserId(client, key, a.user) : client.userId(key);
  const scope = { followers: "follows.read", following: "follows.read", muting: "mute.read", blocking: "block.read" }[a.type];
  const j = await client.request(key, "GET", `/2/users/${uid}/${a.type}`, {
    scopes: [scope, "users.read"],
    query: { max_results: clamp(a.max_results, 1, 1000, 100), pagination_token: a.pagination_token, ...USER_QUERY },
  });
  return shapeUsers(j);
}

export async function getUsers(client: XClient, a: { account?: string; usernames?: string[]; ids?: string[] }) {
  const key = client.resolveAccount(a.account);
  if (a.usernames?.length) {
    const names = a.usernames.map((u) => u.replace(/^@/, "")).join(",");
    return shapeUsers(await client.request(key, "GET", "/2/users/by", { scopes: ["users.read"], query: { usernames: names, ...USER_QUERY } }));
  }
  if (a.ids?.length) {
    return shapeUsers(await client.request(key, "GET", "/2/users", { scopes: ["users.read"], query: { ids: a.ids.join(","), ...USER_QUERY } }));
  }
  throw new Error("Pass usernames or ids.");
}

export async function searchUsers(client: XClient, a: { account?: string; query: string; max_results?: number; next_token?: string }) {
  const j = await client.request(client.resolveAccount(a.account), "GET", "/2/users/search", {
    scopes: ["users.read"],
    query: { query: a.query, max_results: clamp(a.max_results, 1, 1000, 10), next_token: a.next_token, ...USER_QUERY },
  });
  return shapeUsers(j);
}

// ---- reading posts ----------------------------------------------------------------------

export async function getPosts(client: XClient, a: { account?: string; ids: string[] }) {
  const j = await client.request(client.resolveAccount(a.account), "GET", "/2/tweets", {
    scopes: ["tweet.read"],
    query: { ids: a.ids.join(","), ...POST_QUERY },
  });
  return shapePosts(j);
}

export type TimelineType = "home" | "posts" | "mentions" | "liked" | "bookmarks";

export async function getTimeline(
  client: XClient,
  a: {
    account?: string;
    type: TimelineType;
    user?: string;
    max_results?: number;
    pagination_token?: string;
    exclude?: Array<"replies" | "retweets">;
    start_time?: string;
    end_time?: string;
  },
) {
  const key = client.resolveAccount(a.account);
  const selfOnly = a.type === "home" || a.type === "bookmarks";
  if (selfOnly && a.user) throw new Error(`The ${a.type} timeline is only available for the authorized account itself.`);
  const uid = a.user ? await resolveUserId(client, key, a.user) : client.userId(key);
  const [path, min, scopes] = {
    home: [`/2/users/${uid}/timelines/reverse_chronological`, 1, ["tweet.read"]],
    posts: [`/2/users/${uid}/tweets`, 5, ["tweet.read"]],
    mentions: [`/2/users/${uid}/mentions`, 5, ["tweet.read"]],
    liked: [`/2/users/${uid}/liked_tweets`, 5, ["like.read"]],
    bookmarks: [`/2/users/${uid}/bookmarks`, 1, ["bookmark.read"]],
  }[a.type] as [string, number, string[]];
  const timeQuery = a.type === "home" || a.type === "posts" || a.type === "mentions";
  const j = await client.request(key, "GET", path, {
    scopes,
    query: {
      max_results: clamp(a.max_results, min, 100, 10),
      pagination_token: a.pagination_token,
      ...(a.exclude?.length && (a.type === "home" || a.type === "posts") ? { exclude: a.exclude.join(",") } : {}),
      ...(timeQuery ? { start_time: a.start_time, end_time: a.end_time } : {}),
      ...POST_QUERY,
    },
  });
  return shapePosts(j);
}

export async function getPostEngagement(
  client: XClient,
  a: { account?: string; post_id: string; type: "liking_users" | "reposted_by" | "quotes"; max_results?: number; pagination_token?: string },
) {
  const key = client.resolveAccount(a.account);
  const id = enc(a.post_id);
  if (a.type === "quotes") {
    const j = await client.request(key, "GET", `/2/tweets/${id}/quote_tweets`, {
      scopes: ["tweet.read"],
      query: { max_results: clamp(a.max_results, 10, 100, 10), pagination_token: a.pagination_token, ...POST_QUERY },
    });
    return shapePosts(j);
  }
  const path = a.type === "liking_users" ? `/2/tweets/${id}/liking_users` : `/2/tweets/${id}/retweeted_by`;
  const j = await client.request(key, "GET", path, {
    scopes: a.type === "liking_users" ? ["like.read"] : ["tweet.read"],
    query: { max_results: clamp(a.max_results, 1, 100, 20), pagination_token: a.pagination_token, ...USER_QUERY },
  });
  return shapeUsers(j);
}

// ---- direct messages --------------------------------------------------------------------

function dmCategory(path: string): MediaCategory {
  const ext = path.toLowerCase().split(".").pop();
  if (ext === "gif") return "dm_gif";
  if (ext === "mp4" || ext === "mov") return "dm_video";
  return "dm_image";
}

export async function sendDm(
  client: XClient,
  a: { account?: string; to?: string; conversation_id?: string; text?: string; media_ids?: string[]; media_files?: MediaFile[] },
) {
  const key = client.resolveAccount(a.account);
  if (!a.to === !a.conversation_id) throw new Error("Pass exactly one of `to` (a user) or `conversation_id`.");
  const ids = [...(a.media_ids ?? [])];
  for (const f of a.media_files ?? []) {
    ids.push((await uploadMedia(client, { account: key, file_path: f.file_path, alt_text: f.alt_text, media_category: dmCategory(f.file_path) })).media_id);
  }
  if (!a.text && !ids.length) throw new Error("text or media is required.");
  const body: Record<string, unknown> = {};
  if (a.text) body.text = a.text;
  if (ids.length) body.attachments = ids.map((media_id) => ({ media_id }));
  const path = a.to
    ? `/2/dm_conversations/with/${await resolveUserId(client, key, a.to)}/messages`
    : `/2/dm_conversations/${enc(a.conversation_id!)}/messages`;
  const j = await client.request(key, "POST", path, { json: body, scopes: ["dm.write"] });
  return j.data;
}

export async function getDmEvents(
  client: XClient,
  a: { account?: string; with?: string; conversation_id?: string; max_results?: number; pagination_token?: string },
) {
  const key = client.resolveAccount(a.account);
  const path = a.with
    ? `/2/dm_conversations/with/${await resolveUserId(client, key, a.with)}/dm_events`
    : a.conversation_id
      ? `/2/dm_conversations/${enc(a.conversation_id)}/dm_events`
      : "/2/dm_events";
  const j = await client.request(key, "GET", path, {
    scopes: ["dm.read"],
    query: {
      max_results: clamp(a.max_results, 1, 100, 20),
      pagination_token: a.pagination_token,
      event_types: "MessageCreate",
      "dm_event.fields": "id,text,created_at,sender_id,dm_conversation_id,event_type,attachments",
      expansions: "sender_id",
      "user.fields": "username,name",
    },
  });
  const users = new Map<string, any>((j.includes?.users ?? []).map((u: any) => [u.id, u]));
  return {
    events: (j.data ?? []).map((e: any) => {
      const u = users.get(e.sender_id);
      return u ? { ...e, sender: { username: u.username, name: u.name } } : e;
    }),
    ...(j.meta ? { meta: j.meta } : {}),
  };
}

// ---- lists ------------------------------------------------------------------------------

export type ListActionName = "create" | "update" | "delete" | "add_member" | "remove_member";

export async function listAction(
  client: XClient,
  a: { account?: string; action: ListActionName; list_id?: string; name?: string; description?: string; private?: boolean; user?: string },
) {
  const key = client.resolveAccount(a.account);
  const scopes = ["list.write"];
  const needList = () => {
    if (!a.list_id) throw new Error(`list_id is required for ${a.action}.`);
    return enc(a.list_id);
  };
  const needUser = async () => {
    if (!a.user) throw new Error(`user is required for ${a.action}.`);
    return resolveUserId(client, key, a.user);
  };
  const meta = () => {
    const b: Record<string, unknown> = {};
    if (a.name !== undefined) b.name = a.name;
    if (a.description !== undefined) b.description = a.description;
    if (a.private !== undefined) b.private = a.private;
    return b;
  };
  let j;
  switch (a.action) {
    case "create":
      if (!a.name) throw new Error("name is required to create a list.");
      j = await client.request(key, "POST", "/2/lists", { json: meta(), scopes });
      break;
    case "update":
      j = await client.request(key, "PUT", `/2/lists/${needList()}`, { json: meta(), scopes });
      break;
    case "delete":
      j = await client.request(key, "DELETE", `/2/lists/${needList()}`, { scopes });
      break;
    case "add_member":
      j = await client.request(key, "POST", `/2/lists/${needList()}/members`, { json: { user_id: await needUser() }, scopes });
      break;
    case "remove_member":
      j = await client.request(key, "DELETE", `/2/lists/${needList()}/members/${await needUser()}`, { scopes });
      break;
  }
  return { action: a.action, ...(a.list_id ? { list_id: a.list_id } : {}), result: j?.data };
}

export async function getLists(
  client: XClient,
  a: { account?: string; type: "owned" | "info" | "members" | "posts"; list_id?: string; user?: string; max_results?: number; pagination_token?: string },
) {
  const key = client.resolveAccount(a.account);
  const scopes = ["list.read"];
  if (a.type === "owned") {
    const uid = a.user ? await resolveUserId(client, key, a.user) : client.userId(key);
    const j = await client.request(key, "GET", `/2/users/${uid}/owned_lists`, {
      scopes,
      query: { max_results: clamp(a.max_results, 1, 100, 100), pagination_token: a.pagination_token, "list.fields": "description,member_count,follower_count,private,created_at" },
    });
    return { lists: j.data ?? [], ...(j.meta ? { meta: j.meta } : {}) };
  }
  if (!a.list_id) throw new Error(`list_id is required for ${a.type}.`);
  const id = enc(a.list_id);
  if (a.type === "info") {
    const j = await client.request(key, "GET", `/2/lists/${id}`, {
      scopes,
      query: { "list.fields": "description,member_count,follower_count,private,created_at,owner_id" },
    });
    return j.data;
  }
  if (a.type === "members") {
    const j = await client.request(key, "GET", `/2/lists/${id}/members`, {
      scopes,
      query: { max_results: clamp(a.max_results, 1, 100, 100), pagination_token: a.pagination_token, ...USER_QUERY },
    });
    return shapeUsers(j);
  }
  const j = await client.request(key, "GET", `/2/lists/${id}/tweets`, {
    scopes,
    query: { max_results: clamp(a.max_results, 1, 100, 20), pagination_token: a.pagination_token, ...POST_QUERY },
  });
  return shapePosts(j);
}

// ---- trends -----------------------------------------------------------------------------

export async function getTrends(client: XClient, a: { account?: string }) {
  const j = await client.request(client.resolveAccount(a.account), "GET", "/2/users/personalized_trends", {
    scopes: ["users.read"],
    query: { "personalized_trend.fields": "category,post_count,trend_name,trending_since" },
  });
  return { trends: j.data ?? [] };
}

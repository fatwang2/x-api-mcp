// Query presets and response shaping for read endpoints: keep payloads small and add post URLs.

export const POST_QUERY = {
  "post.fields": "created_at,conversation_id,public_metrics,lang,note_post,attachments",
  expansions: "author_id,referenced_posts,attachments.media_keys",
  "user.fields": "username,name,verified",
  "media.fields": "type,url,preview_image_url,alt_text",
};

export const USER_QUERY = {
  "user.fields": "created_at,description,location,profile_image_url,protected,public_metrics,url,verified,verified_type",
};

const postUrl = (id: string, username?: string) =>
  username ? `https://x.com/${username}/status/${id}` : `https://x.com/i/status/${id}`;

export function shapePosts(j: any) {
  const users = new Map<string, any>((j.includes?.users ?? []).map((u: any) => [u.id, u]));
  const media = new Map<string, any>((j.includes?.media ?? []).map((m: any) => [m.media_key, m]));
  const shape = (p: any) => {
    const u = users.get(p.author_id);
    const { attachments, ...rest } = p;
    const m = (attachments?.media_keys ?? []).map((k: string) => media.get(k)).filter(Boolean);
    return {
      ...rest,
      ...(u ? { author: { username: u.username, name: u.name, verified: u.verified } } : {}),
      ...(m.length ? { media: m } : {}),
      url: postUrl(p.id, u?.username),
    };
  };
  const data = j.data === undefined ? [] : Array.isArray(j.data) ? j.data : [j.data];
  return {
    posts: data.map(shape),
    ...(j.includes?.posts?.length ? { referenced_posts: j.includes.posts.map(shape) } : {}),
    ...(j.meta ? { meta: j.meta } : {}),
    ...(j.errors?.length ? { errors: j.errors } : {}),
  };
}

export function shapeUsers(j: any) {
  const data = j.data === undefined ? [] : Array.isArray(j.data) ? j.data : [j.data];
  return {
    users: data,
    ...(j.meta ? { meta: j.meta } : {}),
    ...(j.errors?.length ? { errors: j.errors } : {}),
  };
}

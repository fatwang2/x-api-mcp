import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

export const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const layout = (title: string, body: string) => `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
${body}
</body>`;

/** Consent page shown before handing the browser to X. Everything from the client is escaped. */
export function consentPage(d: ConsentDescription, handle: string): string {
  const name = escapeHtml(d.clientName);
  const origin = d.clientDomain
    ? `Published by <strong>${escapeHtml(d.clientDomain)}</strong>.`
    : "This app registered itself, so its name is not verified.";
  return layout(
    `Connect ${d.clientName} to x-api-mcp`,
    `<h2>Allow ${name} to use your X accounts through this server?</h2>
<p>${origin} Access will be sent to <strong>${escapeHtml(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>" : ""}
<p>You will sign in with X next. Only X accounts on this server's allowlist can finish connecting.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <p><button name="decision" value="approve">Continue with X</button> <button name="decision" value="deny">Cancel</button></p>
</form>`,
  );
}

export function messagePage(title: string, message: string): string {
  return layout(title, `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p>`);
}

export function htmlResponse(html: string, status = 200, headers = new Headers()): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(html, { status, headers });
}

export class XApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
    readonly rateLimitReset?: number,
  ) {
    super(message);
    this.name = "XApiError";
  }
}

export async function parseBody(r: Response): Promise<any> {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export function describeError(body: any): string {
  if (!body || typeof body !== "object") return String(body ?? "");
  if (Array.isArray(body.errors) && body.errors.length) {
    return body.errors
      .map((e: any) => e.detail || e.message || e.title || JSON.stringify(e))
      .join("; ");
  }
  if (body.detail) return String(body.detail);
  if (body.error_description) return `${body.error}: ${body.error_description}`;
  if (body.error) return String(body.error);
  if (body.title) return String(body.title);
  return JSON.stringify(body);
}

// Response and request helpers shared by the Worker routes and the rooms.
import type { JsonObject } from "./parse.ts";

/** What bodyJson, setPaused, chatAction and the Twitch helpers throw: an Error with the HTTP status to answer. */
export type HttpError = Error & { status?: number; reason?: string; reconnect?: unknown; connectedElsewhere?: unknown };

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
/** A JSON answer that is never cached or sniffed. */
export const json = (data: unknown, status = 200): Response => Response.json(data, { status, headers: NO_STORE });
/** The {ok:false, reason, error} refusal of uploads, sprites and the admin actions. */
export const refuse = (status: number, reason: string, error?: string): Response =>
  json({ ok: false, reason, error }, status);
/** A PNG answer with the given Cache-Control. */
export const png = (bytes: ArrayBuffer, cache: string): Response =>
  new Response(bytes, {
    headers: { "Content-Type": "image/png", "Cache-Control": cache, "X-Content-Type-Options": "nosniff" },
  });
/** An Error the Worker's catch answers with this status and the extra fields (reason, reconnect, connectedElsewhere). */
export const httpError = (message: string, status: number, extra: object = {}): HttpError =>
  Object.assign(new Error(message), { status, ...extra });
/** Bytes as base64, in chunks so a large file never overflows the argument list. */
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
/** Base64 as bytes; throws (from atob) on text that is not base64. */
export const fromBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
/** A POST with a JSON body. */
export const postJson = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** The raw body, refused with 413 past limit bytes (by Content-Length, or while reading). */
export async function readBody(request: Request, limit: number): Promise<Uint8Array> {
  if (Number(request.headers.get("Content-Length")) > limit) throw httpError("Request too large", 413);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > limit) {
      await reader.cancel();
      throw httpError("Request too large", 413);
    }
    chunks.push(value);
  }
  const raw = new Uint8Array(bytes);
  let at = 0;
  for (const chunk of chunks) {
    raw.set(chunk, at);
    at += chunk.length;
  }
  return raw;
}

/** The body as a JSON object (an empty body reads {}); throws an HttpError with status 400 or 413 otherwise. */
export async function bodyJson(request: Request, limit = 2200000): Promise<JsonObject> {
  const raw = await readBody(request, limit);
  let value;
  try {
    value = raw.length ? JSON.parse(new TextDecoder().decode(raw)) : {};
  } catch {
    throw httpError("Invalid JSON", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw httpError("JSON object required", 400);
  return value;
}

/**
 * Awaits a bodyJson read, or answers its failure as a refusal: a 413 with tooLarge's [reason, message] when given,
 * anything else with the invalid reason and bodyJson's message.
 */
export async function bodyOr(
  read: Promise<JsonObject>,
  tooLarge: [string, string] | null,
  invalid = "invalid_upload",
): Promise<JsonObject | Response> {
  try {
    return await read;
  } catch (error) {
    const e = error as HttpError; // bodyJson throws an HttpError (status 400 or 413)
    if (e.status === 413 && tooLarge) return refuse(413, ...tooLarge);
    return refuse(e.status || 400, invalid, e.message || "Invalid JSON");
  }
}

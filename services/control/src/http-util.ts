import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";

/** Largest request body read, in bytes, unless a route names its own cap. */
export const MAX_BODY_BYTES = 4096;
export type Envelope<T> = { success: boolean; data: T | null; error: { code: string; message?: string } | null };

export const BAD_REQUEST = "That request is not valid.";
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly closeConnection = false) { super(message); }
}

export function send(res: ServerResponse, status: number, body: Envelope<unknown>, closeConnection = false, retryAfterSeconds?: number): void {
  if (res.headersSent) { res.end(); return; }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Content-Length": Buffer.byteLength(text), ...(closeConnection ? { Connection: "close" } : {}),
    ...(retryAfterSeconds !== undefined ? { "Retry-After": String(retryAfterSeconds) } : {}),
  });
  res.end(text);
}
export const ok = (res: ServerResponse, data: unknown): void => send(res, 200, { success: true, data, error: null });
export const fail = (res: ServerResponse, status: number, code: string, message: string, closeConnection = false, retryAfterSeconds?: number): void =>
  send(res, status, { success: false, data: null, error: { code, message } }, closeConnection, retryAfterSeconds);

/** A closed-code refusal (409): the body carries the code and optional closed data, never a message. */
export const failClosed = (res: ServerResponse, status: number, code: string, data: unknown = null): void =>
  send(res, status, { success: false, data, error: { code } });

/**
 * Reads at most `max` bytes (MAX_BODY_BYTES unless the route names a cap). A declared length over the cap is refused at once (nothing is read); an undeclared or understated one
 * is cut off the moment the running total passes the cap. Resolves to the text ("" for no body).
 */
export function readBody(req: IncomingMessage, max = MAX_BODY_BYTES): Promise<string> {
  const declared = req.headers["content-length"];
  if (declared !== undefined && (!/^[0-9]{1,15}$/.test(declared) || Number(declared) > max)) {
    return Promise.reject(new HttpError(413, "payload_too_large", "That request is too large.", true));
  }
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) { chunks.length = 0; reject(new HttpError(413, "payload_too_large", "That request is too large.", true)); req.removeAllListeners("data"); req.resume(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => reject(new HttpError(400, "bad_request", BAD_REQUEST)));
  });
}

/** The body as a parsed JSON object, or undefined when there is none. A body needs `application/json`. */
export async function jsonBody(req: IncomingMessage, max = MAX_BODY_BYTES): Promise<unknown> {
  const text = await readBody(req, max);
  if (text === "") return undefined;
  const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(400, "bad_request", BAD_REQUEST);
  try { return JSON.parse(text) as unknown; } catch { throw new HttpError(400, "bad_request", BAD_REQUEST); }
}

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(400, "bad_request", BAD_REQUEST);
  return r.data;
}


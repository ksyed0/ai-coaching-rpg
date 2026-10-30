import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { isValidSessionId } from "@acr/events";
import { z } from "zod";
import type { ControlConfig } from "./config.js";
import { ControlError, type ControlErrorCode, type Supervisor } from "./supervisor.js";

/** Largest request body read, in bytes. */
export const MAX_BODY_BYTES = 4096;

type Envelope<T> = { success: boolean; data: T | null; error: { code: string; message: string } | null };

const STATUS: Record<ControlErrorCode, number> = {
  bad_request: 400, unknown_scenario: 400, not_found: 404, conflict: 409, capacity: 429, timeout: 504, start_failed: 502, unavailable: 503,
};
const BAD_REQUEST = "That request is not valid.";
const UNAUTHORIZED = "Unauthorized.";
const INTERNAL = "Something went wrong.";
const MAX_FIELD = 200;

const CreateBody = z.strictObject({ scenarioId: z.string().min(1).max(MAX_FIELD) });
const ReissueBody = z.strictObject({ roleId: z.string().min(1).max(MAX_FIELD).optional(), by: z.string().max(MAX_FIELD).optional() });
const NoBody = z.strictObject({});

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly closeConnection = false) { super(message); }
}

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

/** Constant time: both sides are hashed to the same length first, so neither the length nor the content leaks through timing. */
function tokenOk(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== "string") return false;
  return timingSafeEqual(digest(given), digest(expected));
}

function send(res: ServerResponse, status: number, body: Envelope<unknown>, closeConnection = false): void {
  if (res.headersSent) { res.end(); return; }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Content-Length": Buffer.byteLength(text), ...(closeConnection ? { Connection: "close" } : {}),
  });
  res.end(text);
}
const ok = (res: ServerResponse, data: unknown): void => send(res, 200, { success: true, data, error: null });
const fail = (res: ServerResponse, status: number, code: string, message: string, closeConnection = false): void =>
  send(res, status, { success: false, data: null, error: { code, message } }, closeConnection);

/**
 * Reads at most MAX_BODY_BYTES. A declared length over the cap is refused at once (nothing is read); an undeclared or understated one
 * is cut off the moment the running total passes the cap. Resolves to the text ("" for no body).
 */
function readBody(req: IncomingMessage): Promise<string> {
  const declared = req.headers["content-length"];
  if (declared !== undefined && (!/^[0-9]{1,15}$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    return Promise.reject(new HttpError(413, "payload_too_large", "That request is too large.", true));
  }
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { chunks.length = 0; reject(new HttpError(413, "payload_too_large", "That request is too large.", true)); req.removeAllListeners("data"); req.resume(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => reject(new HttpError(400, "bad_request", BAD_REQUEST)));
  });
}

/** The body as a parsed JSON object, or undefined when there is none. A body needs `application/json`. */
async function jsonBody(req: IncomingMessage): Promise<unknown> {
  const text = await readBody(req);
  if (text === "") return undefined;
  const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(400, "bad_request", BAD_REQUEST);
  try { return JSON.parse(text) as unknown; } catch { throw new HttpError(400, "bad_request", BAD_REQUEST); }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(400, "bad_request", BAD_REQUEST);
  return r.data;
}

const errorName = (err: unknown): string => {
  const n = err instanceof Error ? err.name : "";
  return /^[A-Za-z0-9_]{1,64}$/.test(n) ? n : err instanceof Error ? "Error" : "unknown";
};

/**
 * The control service's HTTP surface (loopback only, called by the BFF). The service token is checked BEFORE anything else, so an
 * unauthenticated caller learns nothing, not even which paths exist. Codes and the facilitator token appear only in response bodies:
 * nothing here logs a body, a path with an id, a message or a port.
 */
export function createApi(deps: {
  config: ControlConfig; supervisor: Supervisor; scenarios: () => Promise<{ id: string; title: string }[]>; log?: (m: string) => void;
}): RequestListener {
  const { config, supervisor, scenarios } = deps;
  const log = deps.log ?? (() => {});

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "";
    let pathname: string;
    try { pathname = new URL(req.url ?? "/", "http://localhost").pathname; } catch { throw new HttpError(404, "not_found", "Not found."); }
    const seg = pathname.split("/").slice(1);
    if (seg[seg.length - 1] === "" && seg.length > 1) seg.pop();
    const notFound = (): never => { throw new HttpError(404, "not_found", "Not found."); };
    const sessionId = (raw: string): string => {
      let id: string;
      try { id = decodeURIComponent(raw); } catch { return notFound(); }
      if (!isValidSessionId(id)) return notFound();
      return id;
    };

    if (seg[0] === "scenarios" && seg.length === 1 && method === "GET") return ok(res, await scenarios());
    if (seg[0] !== "sessions") return notFound();
    if (seg.length === 1) {
      if (method === "GET") return ok(res, supervisor.list());
      if (method === "POST") return ok(res, await supervisor.create(parse(CreateBody, await jsonBody(req)).scenarioId));
      return notFound();
    }
    const id = sessionId(seg[1]!);
    if (seg.length === 2 && method === "GET") {
      const info = supervisor.get(id);
      if (!info) throw new HttpError(404, "not_found", "That session does not exist.");
      return ok(res, info);
    }
    if (seg.length === 3 && seg[2] === "facilitator" && method === "GET") {
      const f = supervisor.facilitator(id);
      if (!f) throw new HttpError(404, "not_found", "That session does not exist.");
      return ok(res, { port: f.port, token: f.token });
    }
    if (seg.length === 3 && seg[2] === "restart" && method === "POST") {
      parse(NoBody, (await jsonBody(req)) ?? {});
      return ok(res, await supervisor.restart(id));
    }
    if (seg.length === 4 && seg[2] === "codes" && seg[3] === "reissue" && method === "POST") {
      const body = parse(ReissueBody, (await jsonBody(req)) ?? {});
      if (body.roleId !== undefined) return ok(res, { code: await supervisor.reissue(id, body.roleId, body.by) });
      return ok(res, { codes: await supervisor.reissueAll(id, body.by) });
    }
    return notFound();
  }

  return (req, res) => {
    void (async () => {
      try {
        if (!tokenOk(req.headers["x-service-token"], config.serviceToken)) {
          fail(res, 401, "unauthorized", UNAUTHORIZED, true);
          req.resume();
          return;
        }
        await route(req, res);
      } catch (err) {
        if (err instanceof HttpError) { fail(res, err.status, err.code, err.message, err.closeConnection); return; }
        if (err instanceof ControlError && err.code in STATUS) { fail(res, STATUS[err.code], err.code, err.message); return; }
        log(`request failed (${errorName(err)})`);
        fail(res, 500, "internal", INTERNAL);
      }
    })();
  };
}

// POSTs to the BFF. The cookie is HttpOnly: the browser sends it (same-origin credentials) and this code never sees it.

/** A refusal may carry structured detail in `data` (the facilitator's start gate); it is present only then. */
export type ApiResult = { ok: true; data: unknown } | { ok: false; status: number; code: string; message: string; data?: unknown; retryAfter?: number };
/** What an action reports to a component: the server's (BFF-written) message on a refusal, or "" to use a generic one. */
export type ActionResult = { ok: true } | { ok: false; message: string };

/** The custom header the BFF's CSRF guard requires on every state-changing request (guards.ts checkOrigin). */
export const REQUESTED_WITH = "scenecoach";
const MAX_MESSAGE_CHARS = 300;

const globalFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

export async function postJson(path: string, body: unknown, fetchImpl: typeof fetch = globalFetch): Promise<ApiResult> {
  return send(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": REQUESTED_WITH },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, fetchImpl);
}

/** A PUT with a JSON body (the participant's self-ratings). */
export async function putJson(path: string, body: unknown, fetchImpl: typeof fetch = globalFetch): Promise<ApiResult> {
  return send(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Requested-With": REQUESTED_WITH },
    body: JSON.stringify(body),
  }, fetchImpl);
}

/** A read: same envelope, no body and no cache (the console's polls must never see a stale answer). */
export async function getJson(path: string, fetchImpl: typeof fetch = globalFetch): Promise<ApiResult> {
  return send(path, { method: "GET", cache: "no-store" }, fetchImpl);
}

async function send(path: string, init: RequestInit, fetchImpl: typeof fetch): Promise<ApiResult> {
  let res: Response;
  try {
    res = await fetchImpl(path, { ...init, credentials: "same-origin" });
  } catch {
    return { ok: false, status: 0, code: "network", message: "" };
  }
  let env: unknown = null;
  try { env = await res.json(); } catch { /* not an envelope */ }
  const e = (typeof env === "object" && env !== null ? env : {}) as Envelope;
  if (res.ok && e.success === true) return { ok: true, data: e.data ?? null };
  return failureOf(res, e);
}

type Envelope = { success?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } | null };

function failureOf(res: Response, e: Envelope): Extract<ApiResult, { ok: false }> {
  const code = typeof e.error?.code === "string" ? e.error.code : "unknown";
  const msg = e.error?.message;
  const ra = Number(res.headers.get("Retry-After"));
  return {
    ok: false, status: res.status, code,
    message: typeof msg === "string" && msg.length <= MAX_MESSAGE_CHARS ? msg : "",
    ...(typeof e.data === "object" && e.data !== null ? { data: e.data } : {}),
    ...(Number.isFinite(ra) && ra > 0 && ra <= 86_400 ? { retryAfter: Math.ceil(ra) } : {}),
  };
}

/** A file the BFF answered with (the facilitator's export): its text and the name to save it under. */
export type FileResult = { ok: true; text: string; fileName: string } | Extract<ApiResult, { ok: false }>;

/** The only download names accepted from Content-Disposition: `report-<safe id>.md`; anything else is saved as `report.md`. */
const FILE_NAME = /^report-[A-Za-z0-9_-]{1,64}\.md$/;

/**
 * A POST whose success is a Markdown attachment (`text/markdown`), read as text and never rendered. A refusal is the usual JSON envelope;
 * a success of any other type is refused as `generic` (nothing is saved).
 */
export async function postForFile(path: string, body: unknown, fetchImpl: typeof fetch = globalFetch): Promise<FileResult> {
  let res: Response;
  try {
    res = await fetchImpl(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": REQUESTED_WITH },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    return { ok: false, status: 0, code: "network", message: "" };
  }
  if (!res.ok) {
    let env: unknown = null;
    try { env = await res.json(); } catch { /* not an envelope */ }
    return failureOf(res, (typeof env === "object" && env !== null ? env : {}) as Envelope);
  }
  if (!/^text\/markdown(;|$)/i.test(res.headers.get("Content-Type") ?? "")) return { ok: false, status: res.status, code: "generic", message: "" };
  let text: string;
  try { text = await res.text(); } catch { return { ok: false, status: 0, code: "network", message: "" }; }
  const named = /filename="([^"]*)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "";
  return { ok: true, text, fileName: FILE_NAME.test(named) ? named : "report.md" };
}

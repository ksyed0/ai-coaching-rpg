// POSTs to the BFF. The cookie is HttpOnly: the browser sends it (same-origin credentials) and this code never sees it.

/** A refusal may carry structured detail in `data` (the facilitator's start gate); it is present only then. */
export type ApiResult = { ok: true; data: unknown } | { ok: false; status: number; code: string; message: string; data?: unknown };
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
  const e = (typeof env === "object" && env !== null ? env : {}) as { success?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } | null };
  if (res.ok && e.success === true) return { ok: true, data: e.data ?? null };
  const code = typeof e.error?.code === "string" ? e.error.code : "unknown";
  const msg = e.error?.message;
  return {
    ok: false, status: res.status, code,
    message: typeof msg === "string" && msg.length <= MAX_MESSAGE_CHARS ? msg : "",
    ...(typeof e.data === "object" && e.data !== null ? { data: e.data } : {}),
  };
}

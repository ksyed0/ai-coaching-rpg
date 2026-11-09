import http from "node:http";

/** US-0072 (EPIC-0003 voice A1c, Task 1): how long one probe waits for an answer. */
export const HTTP_PROBE_TIMEOUT_MS = 2_000;

/**
 * US-0072 (EPIC-0003 voice A1c): "does anything answer HTTP at this loopback address?" for `voice:up`, `voice:check` and control's
 * LiveKit probe. Every caller probes loopback (LiveKit's API on 127.0.0.1:7880, whisper-server), so only `http:` on the literal hosts
 * `127.0.0.1` and `[::1]`, with no user or password, is probed; any other URL (`data:`, `https:`, `localhost`, a LAN address, a malformed
 * one) is false without a request (review A F10; `localhost` is left out: no caller needs it and it goes through name resolution).
 *
 * One GET through `node:http` with `agent: false`, never `fetch` and never the global agent: with `NODE_USE_ENV_PROXY=1` both of those
 * send the request to `HTTP_PROXY`, the full URL included (verified on Node 22.23.1 against a loopback stand-in proxy), and the URL may
 * carry a secret path (the STT request path). A fresh agent has no proxy. A redirect is never followed (node:http does not follow).
 * Bounded by `timeoutMs` (default 2 s) through an injectable `timeout` signal factory, so a test can abort it without waiting in real
 * time. True for ANY HTTP response (a 404 or a 500 still means a server is listening); false for a network error, a refused URL or the
 * timeout. The response is destroyed unread. Never throws and never logs: nothing about the URL may reach a log or an error.
 */
export async function httpAnswers(url: string, o: { timeoutMs?: number; timeout?: (ms: number) => AbortSignal } = {}): Promise<boolean> {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "http:" || !loopback || u.username !== "" || u.password !== "") return false;
  let signal: AbortSignal;
  try { signal = (o.timeout ?? ((ms: number) => AbortSignal.timeout(ms)))(o.timeoutMs ?? HTTP_PROBE_TIMEOUT_MS); } catch { return false; }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (v: boolean): void => { if (!settled) { settled = true; resolve(v); } };
    try {
      const req = http.request(u, { method: "GET", agent: false, signal, headers: { connection: "close" } }, (res) => { res.destroy(); finish(true); });
      req.on("error", () => finish(false));
      req.end();
    } catch { finish(false); }
  });
}

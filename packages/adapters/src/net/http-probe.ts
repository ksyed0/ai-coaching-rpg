/** US-0072 (EPIC-0003 voice A1c, Task 1): how long one probe waits for an answer. */
export const HTTP_PROBE_TIMEOUT_MS = 2_000;

/**
 * US-0072 (EPIC-0003 voice A1c): "does anything answer HTTP at this address?" for `voice:up`, `voice:check` and control's LiveKit probe.
 * One GET, `redirect: "manual"` (never followed), bounded by `timeoutMs` (default 2 s) through an injectable `timeout` signal factory so a
 * test can abort it without waiting in real time. True for ANY HTTP response (a 404 or a 500 still means a server is listening); false
 * for a network error, a malformed URL or the timeout. The body is cancelled. Never throws and never logs: the URL may carry a secret
 * path (the STT request path), so nothing about it may reach a log or an error.
 */
export async function httpAnswers(
  url: string,
  o: { timeoutMs?: number; fetchFn?: typeof fetch; timeout?: (ms: number) => AbortSignal } = {},
): Promise<boolean> {
  try {
    const signal = (o.timeout ?? ((ms: number) => AbortSignal.timeout(ms)))(o.timeoutMs ?? HTTP_PROBE_TIMEOUT_MS);
    const res = await (o.fetchFn ?? fetch)(url, { method: "GET", redirect: "manual", signal });
    try { await res.body?.cancel(); } catch { /* the answer already counts; a body that cannot be cancelled changes nothing */ }
    return true;
  } catch { return false; }
}

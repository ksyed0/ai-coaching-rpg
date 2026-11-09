import { httpAnswers } from "@acr/adapters";

/** US-0072 (EPIC-0003 voice A1c, Task 11): how long control waits for LiveKit to answer one probe. */
export const LIVEKIT_PROBE_TIMEOUT_MS = 2000;

/**
 * US-0072 (A1c Task 11, K7): control's own probe of LIVEKIT_HOST (the host and port the speech worker connects to): "does LiveKit answer
 * HTTP at all?", a GET of `<origin>/` with no credential. Any HTTP answer within LIVEKIT_PROBE_TIMEOUT_MS is true (what LiveKit answers on
 * `/` is not verified, so the status is not read); a refused connection, a reset or the timeout is false. `httpAnswers` probes only
 * loopback `http:` (LIVEKIT_HOST is loopback by its own rule), never through an environment proxy, never throws and never logs.
 * `o.timeout` is the abort-signal factory (tests abort without waiting in real time).
 */
export function livekitProbe(host: URL, o: { timeout?: (ms: number) => AbortSignal } = {}): () => Promise<boolean> {
  const url = `${host.origin}/`;
  return () => httpAnswers(url, { timeoutMs: LIVEKIT_PROBE_TIMEOUT_MS, ...(o.timeout ? { timeout: o.timeout } : {}) });
}

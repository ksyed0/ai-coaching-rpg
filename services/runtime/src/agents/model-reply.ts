import type { ChatRequest, ModelProvider } from "@acr/adapters";
import { describeModelFailure, describeRetryProgress } from "./model-failure.js";

export type CollectedReply = { text: string; failure: string | null };

/**
 * Streams one model reply under the NPC deadlines and assembles it in full. Shared by the AI characters (NpcAgent) and the demo's
 * generated player bots, so both are bounded the same way: a first-token timeout, one overall deadline, and an abort that also
 * stops the model call. Never throws: a failure is returned as a short, sanitized reason (`failure`), with whatever text arrived.
 * `signal` (the caller's own abort, e.g. a run being cancelled) aborts the call and counts as a failure.
 */
export async function collectModelReply(
  provider: ModelProvider, req: ChatRequest, o: { firstTokenTimeoutMs: number; replyTimeoutMs: number; signal?: AbortSignal },
): Promise<CollectedReply> {
  const ac = new AbortController();
  const onOuter = () => ac.abort();
  if (o.signal?.aborted) return { text: "", failure: "run aborted" };
  o.signal?.addEventListener("abort", onOuter, { once: true });
  let text = "";
  let failure: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let replyTimer: ReturnType<typeof setTimeout> | undefined;
  // One overall deadline covers the whole reply so a mid-stream stall cannot wedge the scene.
  const deadline = new Promise<"deadline">((r) => { replyTimer = setTimeout(() => r("deadline"), o.replyTimeoutMs); });
  try {
    const it = provider.stream(req, ac.signal)[Symbol.asyncIterator]();
    const firstP = it.next();
    firstP.catch(() => undefined); // if a timeout wins, a later rejection must not go unhandled
    const first = await Promise.race([
      firstP,
      deadline,
      new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), o.firstTokenTimeoutMs); }),
    ]);
    if (first === "timeout") { ac.abort(); failure = `no first token within timeout${describeRetryProgress(ac.signal)}`; }
    else if (first === "deadline") { ac.abort(); failure = `reply did not finish within the overall deadline${describeRetryProgress(ac.signal)}`; }
    else if (!first.done) {
      text += first.value;
      for (;;) {
        const nextP = it.next();
        nextP.catch(() => undefined);
        const r = await Promise.race([nextP, deadline]);
        if (r === "deadline") { ac.abort(); failure = "reply did not finish within the overall deadline"; break; }
        if (r.done) break;
        text += r.value;
      }
    }
  } catch (err) {
    ac.abort();
    failure = describeModelFailure(err);
  } finally {
    clearTimeout(timer);
    clearTimeout(replyTimer);
    o.signal?.removeEventListener("abort", onOuter);
  }
  if (!failure && o.signal?.aborted) failure = "run aborted";
  return { text, failure };
}

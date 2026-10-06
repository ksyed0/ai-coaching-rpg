import { ModelProviderError, type ChatRequest, type ModelProvider } from "@acr/adapters";
import type { GmNoVerdictReason, GmVia } from "@acr/events";
import { describeModelFailure, describeRetryProgress } from "./model-failure.js";
import { buildGmReaskRequest } from "./gm-prompt.js";
import { parseGmReply } from "./gm-parse.js";

/** One raw model reply of an evaluation and how it was read. */
export type GmReplyTrace = {
  attempt: 1 | 2; raw: string;
  /** A model error that stood in for the reply (a reasoning-only reply), else absent. */
  error?: string;
  parse: { ok: true; verdict: boolean; via: GmVia } | { ok: false; reason: GmNoVerdictReason };
};

/** What one Game Master evaluation came to. `alert`: the model failed or the deadline passed (a warning for the facilitator, no re-ask). */
export type GmOutcome =
  | { kind: "verdict"; verdict: boolean; reasoning: string; via: GmVia; attempts: number }
  | { kind: "no_verdict"; reason: GmNoVerdictReason; attempts: number }
  | { kind: "alert"; message: string };

type Call = { kind: "text"; text: string } | { kind: "deadline" } | { kind: "error"; err: unknown };

/** One model call under the evaluation's shared deadline. Never throws. */
async function call(provider: ModelProvider, req: ChatRequest, ac: AbortController, deadline: Promise<"deadline">): Promise<Call> {
  let text = "";
  try {
    const it = provider.stream(req, ac.signal)[Symbol.asyncIterator]();
    for (;;) {
      const nextP = it.next();
      nextP.catch(() => undefined); // if the deadline wins, a later rejection must not go unhandled
      const r = await Promise.race([nextP, deadline]);
      if (r === "deadline") { ac.abort(); return { kind: "deadline" }; }
      if (r.done) return { kind: "text", text };
      text += r.value;
    }
  } catch (err) {
    ac.abort();
    return { kind: "error", err };
  }
}

/**
 * One Game Master evaluation, the production path (also used by `pnpm gm-eval`): ask, parse tolerantly, and when the reply has no usable
 * verdict ask ONCE more (when `reask`), all inside one deadline. A model error or the deadline is not re-asked (the retry wrapper and the
 * deadline already cover them) and gives an `alert`; a reasoning-only reply (the model spent its whole budget thinking) counts as a parse
 * failure. Never throws on model problems.
 */
export async function runGmEvaluation(o: {
  provider: ModelProvider; request: ChatRequest; condition: string; timeoutMs: number; reask: boolean; onReply?: (r: GmReplyTrace) => void;
}): Promise<GmOutcome> {
  // One deadline per evaluation (retries, backoff and the re-ask happen inside it): a stalled model can no longer hold the
  // caller's in-flight guard forever. The abort also cuts a retry backoff short at once.
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((r) => { timer = setTimeout(() => r("deadline"), o.timeoutMs); });
  try {
    let attempts = 0;
    let reply = "";
    let reason: GmNoVerdictReason = "empty";
    for (;;) {
      attempts++;
      const got = await call(o.provider, attempts === 1 ? o.request : buildGmReaskRequest(o.request, reply), ac, deadline);
      if (got.kind === "deadline") return { kind: "alert", message: `GM: model call exceeded its deadline of ${o.timeoutMs} ms for "${o.condition}"${describeRetryProgress(ac.signal)}` };
      let error: string | undefined;
      if (got.kind === "error") {
        // An exhausted reasoning budget is a reply with no answer: it is re-asked like any other unusable reply.
        if (!(got.err instanceof ModelProviderError && got.err.kind === "reasoning_budget")) return { kind: "alert", message: `GM: ${describeModelFailure(got.err, ` for "${o.condition}"`)}` };
        reply = ""; error = got.err.kind;
      } else reply = got.text;
      const parsed = error ? ({ ok: false, reason: "reasoning_only" } as const) : parseGmReply(reply);
      const attempt = attempts === 1 ? 1 : 2;
      const via: GmVia | undefined = parsed.ok ? (attempt === 1 ? parsed.via : "reask") : undefined;
      try {
        o.onReply?.({ attempt, raw: reply, ...(error ? { error } : {}), parse: parsed.ok ? { ok: true, verdict: parsed.verdict, via: via! } : { ok: false, reason: parsed.reason } });
      } catch { /* a failing trace must never affect the evaluation */ }
      if (parsed.ok) return { kind: "verdict", verdict: parsed.verdict, reasoning: parsed.reasoning, via: via!, attempts };
      reason = parsed.reason;
      if (!o.reask || attempts >= 2) return { kind: "no_verdict", reason, attempts };
    }
  } finally {
    clearTimeout(timer);
  }
}

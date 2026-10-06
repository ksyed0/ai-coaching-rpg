import { randomBytes } from "node:crypto";
import { ModelProviderError, type ChatRequest, type ModelProvider } from "@acr/adapters";
import type { GmNoVerdictReason, GmVia } from "@acr/events";
import { describeModelFailure, describeRetryProgress } from "./model-failure.js";
import { buildGmReaskRequest } from "./gm-prompt.js";
import { parseGmReply } from "./gm-parse.js";

/** A fresh unguessable nonce for one evaluation (96 random bits as 24 hex characters). Never logged. */
export function newGmNonce(): string { return randomBytes(12).toString("hex"); }

/** One raw model reply of an evaluation and how it was read. */
export type GmReplyTrace = {
  attempt: 1 | 2; raw: string;
  /** A model error that stood in for the reply (a reasoning-only reply), else absent. */
  error?: string;
  /** Verdict objects set aside because they lacked the evaluation's nonce. */
  ignored?: number;
  parse: { ok: true; verdict: boolean; via: GmVia } | { ok: false; reason: GmNoVerdictReason };
};

/** What one Game Master evaluation came to. `alert`: the model failed or the deadline passed (a warning for the facilitator, no re-ask). */
export type GmOutcome =
  | { kind: "verdict"; verdict: boolean; reasoning: string; via: GmVia; attempts: number }
  | { kind: "no_verdict"; reason: GmNoVerdictReason; attempts: number }
  | { kind: "alert"; message: string };

type Call = { kind: "text"; text: string } | { kind: "deadline"; signal: AbortSignal } | { kind: "error"; err: unknown };

/**
 * One model call under the evaluation's shared deadline. Never throws. Each call has its OWN AbortController (linked to the evaluation's): an
 * error ends that call only, so the re-ask after it is not born aborted; only the deadline aborts the whole evaluation.
 */
async function call(provider: ModelProvider, req: ChatRequest, evalAc: AbortController, deadline: Promise<"deadline">): Promise<Call> {
  const ac = new AbortController();
  const link = () => ac.abort();
  evalAc.signal.addEventListener("abort", link, { once: true });
  let text = "";
  try {
    const it = provider.stream(req, ac.signal)[Symbol.asyncIterator]();
    for (;;) {
      const nextP = it.next();
      nextP.catch(() => undefined); // if the deadline wins, a later rejection must not go unhandled
      const r = await Promise.race([nextP, deadline]);
      if (r === "deadline") { evalAc.abort(); return { kind: "deadline", signal: ac.signal }; }
      if (r.done) return { kind: "text", text };
      text += r.value;
    }
  } catch (err) {
    ac.abort(); // only this call
    return { kind: "error", err };
  } finally {
    evalAc.signal.removeEventListener("abort", link);
  }
}

/** A reply with no answer text: the model spent its whole budget thinking (a retryable budget error) or stopped after only reasoning. Both are parse failures. */
function isReasoningOnly(err: unknown): boolean {
  return err instanceof ModelProviderError && (err.kind === "reasoning_budget" || (err.kind === "unknown" && /only reasoning and no answer/i.test(err.message)));
}

/**
 * One Game Master evaluation, the production path (also used by `pnpm gm-eval`): ask, parse tolerantly, and when the reply has no usable
 * verdict ask ONCE more (when `reask`), all inside one deadline. A model error or the deadline in the first call gives an `alert` (no re-ask:
 * the retry wrapper and the deadline already cover them); the deadline during the re-ask gives `no_verdict` with the first reply's reason.
 * A reasoning-only reply counts as a parse failure. `nonce` is the id the prompt asked for (see parseGmReply). Never throws on model problems.
 */
export async function runGmEvaluation(o: {
  provider: ModelProvider; request: ChatRequest; condition: string; timeoutMs: number; reask: boolean; nonce?: string; onReply?: (r: GmReplyTrace) => void;
}): Promise<GmOutcome> {
  const evalAc = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((r) => { timer = setTimeout(() => r("deadline"), o.timeoutMs); });
  try {
    let attempts = 0;
    let reply = "";
    let reason: GmNoVerdictReason = "empty";
    for (;;) {
      attempts++;
      const got = await call(o.provider, attempts === 1 ? o.request : buildGmReaskRequest(o.request, reply, o.nonce), evalAc, deadline);
      if (got.kind === "deadline") {
        if (attempts > 1) return { kind: "no_verdict", reason, attempts };
        return { kind: "alert", message: `GM: model call exceeded its deadline of ${o.timeoutMs} ms for "${o.condition}"${describeRetryProgress(got.signal)}` };
      }
      let error: string | undefined;
      if (got.kind === "error") {
        if (!isReasoningOnly(got.err)) return { kind: "alert", message: `GM: ${describeModelFailure(got.err, ` for "${o.condition}"`)}` };
        reply = ""; error = (got.err as ModelProviderError).kind;
      } else reply = got.text;
      const parsed = error ? ({ ok: false, reason: "reasoning_only", ignored: 0 } as const) : parseGmReply(reply, { nonce: o.nonce });
      const attempt = attempts === 1 ? 1 : 2;
      const via: GmVia | undefined = parsed.ok ? (attempt === 1 ? parsed.via : "reask") : undefined;
      try {
        o.onReply?.({ attempt, raw: reply, ...(error ? { error } : {}), ...(parsed.ignored > 0 ? { ignored: parsed.ignored } : {}),
          parse: parsed.ok ? { ok: true, verdict: parsed.verdict, via: via! } : { ok: false, reason: parsed.reason } });
      } catch { /* a failing trace must never affect the evaluation */ }
      if (parsed.ok) return { kind: "verdict", verdict: parsed.verdict, reasoning: parsed.reasoning, via: via!, attempts };
      reason = parsed.reason; // the last attempt's reason (a deadline in the re-ask keeps the first one)
      if (!o.reask || attempts >= 2) return { kind: "no_verdict", reason, attempts };
    }
  } finally {
    clearTimeout(timer);
  }
}

import { ModelProviderError, type ChatRequest, type ModelProvider } from "@acr/adapters";
import type { GmNoVerdictReason, GmVia } from "@acr/events";
import type { SessionEngine } from "../engine/session-engine.js";
import { describeModelFailure, describeRetryProgress } from "./model-failure.js";
import { DEFAULT_REPLY_TIMEOUT_MS, gmDeadlineMs } from "./timeouts.js";
import { buildGmReaskRequest, buildGmRequest } from "./gm-prompt.js";
import { parseGmReply } from "./gm-parse.js";
import { DEFAULT_GM_EVERY_N_UTTERANCES } from "./gm-config.js";
import { DEFAULT_GM_MAX_TOKENS } from "./token-budgets.js";

/** The Game Master judges each gm_detects condition after this many NEW utterances in a scene. */
export const GM_EVERY_N_UTTERANCES = DEFAULT_GM_EVERY_N_UTTERANCES;

/** One raw Game Master model reply and how it was read (`--gm-trace` / `GM_TRACE_FILE`). Holds the dialogue-derived reply: facilitator-grade data, never part of the session log. */
export type GmTraceRecord = {
  /** The last event seq when the prompt was built: the prompt can be rebuilt from the session log up to this seq. */
  seq: number; sceneId: string; condition: string; attempt: 1 | 2; raw: string;
  /** A model error that stood in for the reply (a reasoning-only reply), else absent. */
  error?: string;
  parse: { ok: true; verdict: boolean; via: GmVia } | { ok: false; reason: GmNoVerdictReason };
};
type Call = { kind: "text"; text: string } | { kind: "deadline" } | { kind: "error"; err: unknown };
export class GameMaster {
  private readonly engine: SessionEngine;
  private readonly provider: ModelProvider;
  readonly everyN: number;
  private evaluatedCount = 0; // utterances in the current scene at the last evaluation
  private lastSceneId: string | null = null;
  private readonly onError: (err: unknown) => void;
  readonly evaluationTimeoutMs: number;
  /** The model's max_tokens for one verdict (GM_MAX_TOKENS). */
  readonly maxTokens: number;
  /** Sampling temperature (GM_TEMPERATURE); undefined leaves the provider default. */
  readonly temperature: number | undefined;
  private evaluating = false; // R19: at most one evaluation in flight
  /** One bounded re-ask after a reply with no usable verdict (GM_REASK; default on). */
  readonly reask: boolean;
  private readonly trace: ((rec: GmTraceRecord) => void) | undefined;

  constructor(opts: { engine: SessionEngine; provider: ModelProvider; everyNUtterances?: number; onError?: (err: unknown) => void; evaluationTimeoutMs?: number; maxTokens?: number; temperature?: number; reask?: boolean; trace?: (rec: GmTraceRecord) => void }) {
    this.reask = opts.reask ?? true; this.trace = opts.trace;
    this.engine = opts.engine; this.provider = opts.provider; this.everyN = opts.everyNUtterances ?? GM_EVERY_N_UTTERANCES;
    this.maxTokens = opts.maxTokens ?? DEFAULT_GM_MAX_TOKENS;
    this.temperature = opts.temperature;
    this.evaluationTimeoutMs = opts.evaluationTimeoutMs ?? gmDeadlineMs(DEFAULT_REPLY_TIMEOUT_MS);
    this.onError = opts.onError ?? ((err) => console.error("[GameMaster] evaluation failed:", err));
  }

  /**
   * Called by the host about once a second. Always runs engine.tick (timers, injects, exits). Every N new
   * utterances it also evaluates each gm_detects condition. A tick that arrives while an evaluation is in
   * flight skips evaluation (no duplicate model calls or decisions). Never throws on model problems: a model
   * error or deadline records no decision and raises a facilitator.alert (warning); a reply with no usable verdict is re-asked once
   * (GM_REASK) and then recorded as the facilitator-only gm.no_verdict event with its reason. Engine/log failures go to onError (default console.error) plus a best-effort warning alert. The attempt still counts, so a failing model is retried
   * after N more utterances rather than on every tick. Verdicts are bound to the scene captured before the
   * model call (engine rejects stale ones, R18).
   */
  async tick(): Promise<void> {
    await this.engine.tick();
    if (this.evaluating) return;
    const scene = this.engine.currentScene();
    if (!scene || this.engine.state.paused || this.engine.state.status !== "running") return;
    if (scene.id !== this.lastSceneId) { this.lastSceneId = scene.id; this.evaluatedCount = 0; }
    const count = this.engine.state.transcript.filter((u) => u.sceneId === scene.id).length;
    if (count === 0 || count - this.evaluatedCount < this.everyN) return;
    this.evaluatedCount = count;
    this.evaluating = true;
    try {
      for (const cond of scene.exit_when.any_of) {
        if (typeof cond !== "object") continue;
        if (this.engine.state.currentScene?.id !== scene.id) break; // scene moved on mid-evaluation
        await this.evaluate(scene, cond.gm_detects);
      }
      await this.engine.tick();
    } catch (err) {
      // Never throw into the host's ticker, but never be silent either: report to onError, then make a
      // best-effort facilitator alert (which can itself fail when the log is what failed).
      this.report(err);
      try { await this.engine.alert(`GM: evaluation failed: ${err instanceof Error ? err.message : String(err)}`, "warning"); }
      catch (alertErr) { this.report(alertErr); }
    } finally {
      this.evaluating = false;
    }
  }

  /**
   * One more evaluation of the current scene, for a caller that has just seen the last reply of a turn. The normal tick can
   * judge while a player's line is recorded, BEFORE the characters answer, and then waits for N more utterances. This runs only
   * when the scene was already evaluated (so a scene with too few lines still gets none) and utterances have arrived since,
   * and it counts them as evaluated. Returns whether it evaluated.
   */
  async finalEvaluation(expectSceneId?: string): Promise<boolean> {
    await this.engine.tick();
    if (this.evaluating) return false;
    const scene = this.engine.currentScene();
    if (!scene || this.engine.state.paused || this.engine.state.status !== "running") return false;
    if (expectSceneId !== undefined && scene.id !== expectSceneId) return false; // the scene changed since the caller looked
    if (scene.id !== this.lastSceneId || this.evaluatedCount === 0) return false;
    const count = this.engine.state.transcript.filter((u) => u.sceneId === scene.id).length;
    if (count <= this.evaluatedCount) return false;
    this.evaluatedCount = count;
    this.evaluating = true;
    try {
      for (const cond of scene.exit_when.any_of) {
        if (typeof cond !== "object") continue;
        if (this.engine.state.currentScene?.id !== scene.id) break;
        await this.evaluate(scene, cond.gm_detects);
      }
      await this.engine.tick();
    } catch (err) {
      this.report(err);
      try { await this.engine.alert(`GM: evaluation failed: ${err instanceof Error ? err.message : String(err)}`, "warning"); } catch (alertErr) { this.report(alertErr); }
    } finally { this.evaluating = false; }
    return true;
  }

  private report(err: unknown): void {
    try { this.onError(err); } catch { /* a throwing handler must not break the ticker */ }
  }

  /** One model call under the evaluation's shared deadline. Never throws. */
  private async call(req: ChatRequest, ac: AbortController, deadline: Promise<"deadline">): Promise<Call> {
    let text = "";
    try {
      const it = this.provider.stream(req, ac.signal)[Symbol.asyncIterator]();
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

  private traceRecord(rec: GmTraceRecord): void {
    try { this.trace?.(rec); } catch (err) { this.report(err); } // a failing trace file never affects the session
  }

  /**
   * One evaluation: ask, parse tolerantly, and when the reply has no usable verdict ask ONCE more (inside the same deadline).
   * A model error or the deadline is not re-asked (the retry wrapper and the deadline already cover them) and raises a warning alert;
   * a reasoning-only reply (the model spent its whole budget thinking) counts as a parse failure. No usable verdict after the last
   * attempt records the facilitator-only gm.no_verdict with its reason.
   */
  private async evaluate(scene: NonNullable<ReturnType<SessionEngine["currentScene"]>>, condition: string): Promise<void> {
    const expectSceneId = scene.id;
    // One deadline per evaluation (retries, backoff and the re-ask happen inside it): a stalled model can no longer hold the
    // in-flight guard forever. The abort also cuts a retry backoff short at once.
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"deadline">((r) => { timer = setTimeout(() => r("deadline"), this.evaluationTimeoutMs); });
    try {
      const seq = this.engine.state.lastSeq;
      const base = buildGmRequest({ scene, condition, state: this.engine.state, maxTokens: this.maxTokens, temperature: this.temperature });
      let attempts = 0;
      let reply = "";
      let reason: GmNoVerdictReason = "empty";
      for (;;) {
        attempts++;
        const got = await this.call(attempts === 1 ? base : buildGmReaskRequest(base, reply), ac, deadline);
        if (got.kind === "deadline") {
          await this.engine.alert(`GM: model call exceeded its deadline of ${this.evaluationTimeoutMs} ms for "${condition}"${describeRetryProgress(ac.signal)}`, "warning", { expectSceneId });
          return;
        }
        let error: string | undefined;
        if (got.kind === "error") {
          // An exhausted reasoning budget is a reply with no answer: it is re-asked like any other unusable reply.
          if (!(got.err instanceof ModelProviderError && got.err.kind === "reasoning_budget")) {
            await this.engine.alert(`GM: ${describeModelFailure(got.err, ` for "${condition}"`)}`, "warning", { expectSceneId });
            return;
          }
          reply = ""; error = got.err.kind;
        } else reply = got.text;
        const parsed = error ? ({ ok: false, reason: "reasoning_only" } as const) : parseGmReply(reply);
        const attempt = attempts === 1 ? 1 : 2;
        this.traceRecord({ seq, sceneId: expectSceneId, condition, attempt, raw: reply, ...(error ? { error } : {}),
          parse: parsed.ok ? { ok: true, verdict: parsed.verdict, via: attempt === 1 ? parsed.via : "reask" } : { ok: false, reason: parsed.reason } });
        if (parsed.ok) {
          await this.engine.recordGmVerdict(condition, parsed.verdict, parsed.reasoning, { expectSceneId, via: attempt === 1 ? parsed.via : "reask" });
          return;
        }
        reason = parsed.reason;
        if (!this.reask || attempts >= 2) break;
      }
      await this.engine.recordGmNoVerdict(condition, reason, attempts, { expectSceneId });
    } finally {
      clearTimeout(timer);
    }
  }
}

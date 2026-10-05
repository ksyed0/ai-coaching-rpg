import type { ModelProvider } from "@acr/adapters";
import type { SessionEngine } from "../engine/session-engine.js";
import { describeModelFailure, describeRetryProgress } from "./model-failure.js";
import { DEFAULT_REPLY_TIMEOUT_MS, gmDeadlineMs } from "./timeouts.js";
import { buildGmRequest, parseGmVerdict } from "./gm-prompt.js";

/** The Game Master judges each gm_detects condition after this many NEW utterances in a scene. */
export const GM_EVERY_N_UTTERANCES = 3;

export class GameMaster {
  private readonly engine: SessionEngine;
  private readonly provider: ModelProvider;
  private readonly everyN: number;
  private evaluatedCount = 0; // utterances in the current scene at the last evaluation
  private lastSceneId: string | null = null;
  private readonly onError: (err: unknown) => void;
  private readonly evaluationTimeoutMs: number;
  private evaluating = false; // R19: at most one evaluation in flight

  constructor(opts: { engine: SessionEngine; provider: ModelProvider; everyNUtterances?: number; onError?: (err: unknown) => void; evaluationTimeoutMs?: number }) {
    this.engine = opts.engine; this.provider = opts.provider; this.everyN = opts.everyNUtterances ?? GM_EVERY_N_UTTERANCES;
    this.evaluationTimeoutMs = opts.evaluationTimeoutMs ?? gmDeadlineMs(DEFAULT_REPLY_TIMEOUT_MS);
    this.onError = opts.onError ?? ((err) => console.error("[GameMaster] evaluation failed:", err));
  }

  /**
   * Called by the host about once a second. Always runs engine.tick (timers, injects, exits). Every N new
   * utterances it also evaluates each gm_detects condition. A tick that arrives while an evaluation is in
   * flight skips evaluation (no duplicate model calls or decisions). Never throws on model problems: a model
   * error, empty reply or unparseable verdict records no decision and raises a facilitator.alert instead
   * (warning for errors, info for empty/unparseable). Engine/log failures go to onError (default console.error) plus a best-effort warning alert. The attempt still counts, so a failing model is retried
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

  private async evaluate(scene: NonNullable<ReturnType<SessionEngine["currentScene"]>>, condition: string): Promise<void> {
    const expectSceneId = scene.id;
    let text = "";
    // One deadline per evaluation (retries and their backoff happen inside it): a stalled model can no longer hold the
    // in-flight guard forever. The abort also cuts a retry backoff short at once.
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const deadline = new Promise<"deadline">((r) => { timer = setTimeout(() => r("deadline"), this.evaluationTimeoutMs); });
    try {
      const it = this.provider.stream(buildGmRequest({ scene, condition, state: this.engine.state }), ac.signal)[Symbol.asyncIterator]();
      for (;;) {
        const nextP = it.next();
        nextP.catch(() => undefined); // if the deadline wins, a later rejection must not go unhandled
        const r = await Promise.race([nextP, deadline]);
        if (r === "deadline") { ac.abort(); expired = true; break; }
        if (r.done) break;
        text += r.value;
      }
    } catch (err) {
      ac.abort();
      await this.engine.alert(`GM: ${describeModelFailure(err, ` for "${condition}"`)}`, "warning", { expectSceneId });
      return;
    } finally {
      clearTimeout(timer);
    }
    if (expired) {
      await this.engine.alert(`GM: model call exceeded its deadline of ${this.evaluationTimeoutMs} ms for "${condition}"${describeRetryProgress(ac.signal)}`, "warning", { expectSceneId });
      return;
    }
    const parsed = parseGmVerdict(text);
    if (!parsed) {
      await this.engine.alert(`GM: no usable verdict for "${condition}"`, "info", { expectSceneId });
      return;
    }
    await this.engine.recordGmVerdict(condition, parsed.verdict, parsed.reasoning, { expectSceneId });
  }
}

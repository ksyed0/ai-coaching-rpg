import type { ModelProvider } from "@acr/adapters";
import type { SessionEngine } from "../engine/session-engine.js";
import { DEFAULT_REPLY_TIMEOUT_MS, gmDeadlineMs } from "./timeouts.js";
import { buildGmEarnedRequest, buildGmRequest, selectGmLines } from "./gm-prompt.js";
import { newGmNonce, runGmEvaluation, type GmReplyTrace } from "./gm-evaluate.js";
import { DEFAULT_GM_EVERY_N_UTTERANCES, DEFAULT_GM_TRANSCRIPT_WINDOW, MAX_GM_TRANSCRIPT_WINDOW } from "./gm-config.js";
import { DEFAULT_GM_MAX_TOKENS } from "./token-budgets.js";

/**
 * US-0034: the most earned_when conditions judged in one evaluation round (the least recently checked first, so every pending one is still
 * reached). Bounds a round to (exit conditions + this) Game Master evaluations, each inside GM_TIMEOUT_MS, however many hidden facts carry a condition.
 */
export const MAX_EARNED_CHECKS_PER_ROUND = 2;

/** The Game Master judges each gm_detects condition after this many NEW utterances in a scene. */
export const GM_EVERY_N_UTTERANCES = DEFAULT_GM_EVERY_N_UTTERANCES;

/** One raw Game Master model reply and how it was read (`--gm-trace` / `GM_TRACE_FILE`). Holds a model reply about the dialogue: facilitator-grade data, never part of the session log. */
export type GmTraceRecord = {
  /** The last event seq when the prompt was built: the prompt can be rebuilt from the session log up to this seq. */
  seq: number; sceneId: string; condition: string;
  /** US-0034: present when the evaluation judged a hidden fact's earned_when condition (by role id and fact number; never the fact text). */
  earned?: { roleId: string; fact: number };
  /** US-0019: the window the prompt was built with (see selectGmLines; the latest utterances of the scene up to `seq` plus the kept opening and AI character lines), so the prompt can still be rebuilt from the log. Always set by the Game Master; absent in traces written before US-0019. */
  window?: number;
} & GmReplyTrace;

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
  /** US-0034, GM_AUTO_RELEASE (off by default): release a hidden fact itself when it judges its earned_when condition true, instead of only suggesting it. */
  readonly autoRelease: boolean;
  /** US-0034: when each earned_when condition (`role#fact`) was last judged, in evaluation rounds, for the round-robin. In memory only: a restart starts the rotation again. */
  private readonly earnedLastRound = new Map<string, number>();
  private earnedRound = 0;
  /**
   * US-0019, GM_TRANSCRIPT_WINDOW: the least number of the scene's latest utterances a prompt holds (never fewer than `everyN`). A prompt is
   * widened to every line that arrived since the last prompt for the same condition was answered (`coveredSeq`), up to MAX_GM_TRANSCRIPT_WINDOW;
   * beyond that cap the lines left out are reported in a facilitator alert. So no line escapes every prompt of a condition silently, also when
   * lines arrive while a slow evaluation round is in flight.
   */
  readonly transcriptWindow: number;
  /** US-0019: per condition of the current scene (`exit\n<condition>` or `earned\n<role>#<fact>`), the last utterance seq that an answered prompt covered. In memory only: after a restart the first prompt of each condition covers the whole scene (up to the cap). */
  private readonly coveredSeq = new Map<string, number>();

  constructor(opts: { engine: SessionEngine; provider: ModelProvider; everyNUtterances?: number; onError?: (err: unknown) => void; evaluationTimeoutMs?: number; maxTokens?: number; temperature?: number; reask?: boolean; trace?: (rec: GmTraceRecord) => void; autoRelease?: boolean; transcriptWindow?: number }) {
    this.reask = opts.reask ?? true; this.trace = opts.trace; this.autoRelease = opts.autoRelease ?? false;
    this.engine = opts.engine; this.provider = opts.provider; this.everyN = opts.everyNUtterances ?? GM_EVERY_N_UTTERANCES;
    this.maxTokens = opts.maxTokens ?? DEFAULT_GM_MAX_TOKENS;
    const w = opts.transcriptWindow;
    this.transcriptWindow = Math.min(MAX_GM_TRANSCRIPT_WINDOW, Math.max(Math.floor(w !== undefined && Number.isFinite(w) ? w : DEFAULT_GM_TRANSCRIPT_WINDOW), this.everyN, 1));
    this.temperature = opts.temperature;
    this.evaluationTimeoutMs = opts.evaluationTimeoutMs ?? gmDeadlineMs(DEFAULT_REPLY_TIMEOUT_MS);
    this.onError = opts.onError ?? ((err) => console.error("[GameMaster] evaluation failed:", err));
  }

  /**
   * US-0018: after a restart, continue counting from what the log shows. `evaluatedCount`: the scene's utterances before its last
   * recorded decision (0 when none), so an evaluation that was in flight when the server stopped simply runs again at the next
   * cadence tick. Nothing else of the Game Master is state.
   */
  restore(sceneId: string | null, evaluatedCount: number): void {
    this.lastSceneId = sceneId;
    this.evaluatedCount = Math.max(0, Math.floor(evaluatedCount));
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
    if (scene.id !== this.lastSceneId) { this.lastSceneId = scene.id; this.evaluatedCount = 0; this.coveredSeq.clear(); }
    const count = this.engine.state.transcript.filter((u) => u.sceneId === scene.id).length;
    if (count === 0 || count - this.evaluatedCount < this.everyN) return;
    this.evaluatedCount = count;
    this.evaluating = true;
    try {
      await this.evaluateScene(scene);
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
      await this.evaluateScene(scene);
      await this.engine.tick();
    } catch (err) {
      this.report(err);
      try { await this.engine.alert(`GM: evaluation failed: ${err instanceof Error ? err.message : String(err)}`, "warning"); } catch (alertErr) { this.report(alertErr); }
    } finally { this.evaluating = false; }
    return true;
  }

  /** A recorded true exit verdict of the current scene: the scene exits at the next engine tick (gmVerdicts is reset on every scene entry). */
  private exitVerdictTrue(): boolean { return Object.values(this.engine.state.gmVerdicts).some((v) => v); }

  /**
   * One evaluation pass over a scene: each gm_detects exit condition in scenario order until one is recorded true (US-0019, AC-0060: the scene
   * ends at the next engine tick, so judging the rest would only cost model calls), then (US-0034) each pending earned_when condition of the AI
   * characters in it (pendingEarnedChecks: not yet judged earned, not released), at most MAX_EARNED_CHECKS_PER_ROUND of them, and none once an
   * exit verdict of this scene came back true. Stops when the scene moves on. Only a verdict the engine RECORDED counts (a stale one it refused
   * does not); false, no verdict and a model failure go on to the next condition. A scenario without earned_when makes no more calls than before.
   */
  private async evaluateScene(scene: NonNullable<ReturnType<SessionEngine["currentScene"]>>): Promise<void> {
    for (const cond of scene.exit_when.any_of) {
      if (typeof cond !== "object") continue;
      if (this.engine.state.currentScene?.id !== scene.id) return; // scene moved on mid-evaluation
      if (this.exitVerdictTrue()) return; // AC-0060: a condition was judged true: no further exit or earned_when check this round
      await this.evaluate(scene, cond.gm_detects);
    }
    // The scene is ending on a true exit verdict (it exits at the next engine tick): no earned_when check this round.
    if (this.exitVerdictTrue()) return;
    this.earnedRound++;
    const key = (c: { role: { id: string }; fact: number }) => `${c.role.id}#${c.fact}`;
    const pending = this.engine.pendingEarnedChecks()
      .map((c, i) => ({ c, i, last: this.earnedLastRound.get(key(c)) ?? 0 }))
      .sort((a, b) => a.last - b.last || a.i - b.i) // least recently judged first, then scene and fact order (a stable, deterministic rotation)
      .slice(0, MAX_EARNED_CHECKS_PER_ROUND);
    for (const { c } of pending) {
      if (this.engine.state.currentScene?.id !== scene.id) return;
      this.earnedLastRound.set(key(c), this.earnedRound);
      await this.evaluateEarned(scene, c);
    }
  }

  /**
   * US-0034: one evaluation of a hidden fact's earned_when condition, through the same nonce-signed path as an exit condition (runGmEvaluation:
   * a fresh nonce in the system prompt only, the strict parser, one bounded re-ask). Only a verdict carrying the nonce counts, and the role id and
   * fact number come from the scenario, never from the reply, so dialogue text can neither forge a suggestion nor choose which fact it names.
   * true: the engine records the facilitator-only gm.fact_earned once (and with GM_AUTO_RELEASE the release). false: nothing is recorded (asked
   * again at the next cadence). No usable verdict: a facilitator-only info alert. A model failure: the usual warning alert.
   */
  private async evaluateEarned(scene: NonNullable<ReturnType<SessionEngine["currentScene"]>>, check: ReturnType<SessionEngine["pendingEarnedChecks"]>[number]): Promise<void> {
    const expectSceneId = scene.id;
    const seq = this.engine.state.lastSeq;
    const { role, fact, condition } = check;
    const nonce = newGmNonce();
    const coverKey = `earned\n${role.id}#${fact}`;
    // m-1: the window, `covered` and the prompt come from ONE synchronous read of the state (no await in between); the alert follows.
    const { window, covered, dropped } = this.windowFor(scene, coverKey);
    const request = buildGmEarnedRequest({ scene, role, fact, condition, state: this.engine.state, maxTokens: this.maxTokens, temperature: this.temperature, nonce, window });
    await this.alertDropped(scene, dropped, `hidden fact ${fact} of ${role.id}`);
    const earned = { roleId: role.id, fact };
    const out = await runGmEvaluation({
      provider: this.provider, request, condition, timeoutMs: this.evaluationTimeoutMs, reask: this.reask, nonce,
      subject: `hidden fact ${fact} of ${role.id} (earned_when "${condition}")`,
      onReply: (r) => this.traceRecord({ seq, sceneId: expectSceneId, condition, earned, window, ...r }),
    });
    if (out.kind !== "alert") this.coveredSeq.set(coverKey, covered); // the model answered this prompt (a model failure or deadline leaves the lines uncovered)
    if (out.kind === "alert") await this.engine.alert(out.message, "warning", { expectSceneId });
    else if (out.kind === "no_verdict") await this.engine.alert(`GM: no usable verdict on whether hidden fact ${fact} of ${role.id} is earned (${out.reason}${out.attempts > 1 ? " after the re-ask" : ""})`, "info", { expectSceneId });
    else if (out.verdict) await this.engine.recordFactEarned(role.id, fact, out.reasoning, { expectSceneId, via: out.via, autoRelease: this.autoRelease });
  }

  /**
   * US-0019 (I-1): the window for the next prompt of one condition: at least GM_TRANSCRIPT_WINDOW, widened to every utterance of the scene after
   * the last seq an answered prompt for this condition covered, capped at MAX_GM_TRANSCRIPT_WINDOW. Synchronous on purpose (m-1): the caller
   * builds the prompt from the same state right after it, so `covered` (the latest utterance seq, always shown) and `dropped` (new lines the
   * cap leaves out) describe exactly the prompt that is sent; lines that arrive later are new for the next prompt.
   */
  private windowFor(scene: NonNullable<ReturnType<SessionEngine["currentScene"]>>, key: string): { window: number; covered: number; dropped: number } {
    const lines = this.engine.state.transcript.filter((u) => u.sceneId === scene.id);
    const last = this.coveredSeq.get(key) ?? 0;
    const fresh = lines.filter((u) => u.seq > last).length;
    const window = Math.min(MAX_GM_TRANSCRIPT_WINDOW, Math.max(this.transcriptWindow, fresh));
    let dropped = 0;
    if (fresh > window) {
      const shown = new Set(selectGmLines(lines, this.engine.state.roles, window).flatMap((e) => (e.kind === "line" ? [e.u.seq] : [])));
      dropped = lines.filter((u) => u.seq > last && !shown.has(u.seq)).length;
    }
    return { window, covered: lines.at(-1)?.seq ?? last, dropped };
  }

  /** The facilitator warning for new lines the cap left out of a prompt (numbers and the condition only), after the prompt was built. */
  private async alertDropped(scene: NonNullable<ReturnType<SessionEngine["currentScene"]>>, dropped: number, what: string): Promise<void> {
    if (dropped > 0) await this.engine.alert(`GM: ${dropped === 1 ? "1 line" : `${dropped} lines`} of this scene that arrived since the last evaluation of ${what} ${dropped === 1 ? "was" : "were"} not shown to the Game Master (more than ${MAX_GM_TRANSCRIPT_WINDOW} new lines at once)`, "warning", { expectSceneId: scene.id });
  }

  private report(err: unknown): void {
    try { this.onError(err); } catch { /* a throwing handler must not break the ticker */ }
  }

  private traceRecord(rec: GmTraceRecord): void {
    try { this.trace?.(rec); } catch (err) { this.report(err); } // a failing trace file never affects the session
  }

  /** One evaluation (see runGmEvaluation): the outcome is recorded as a gm.decision or a gm.no_verdict, or raised as a warning alert. */
  private async evaluate(scene: NonNullable<ReturnType<SessionEngine["currentScene"]>>, condition: string): Promise<void> {
    const expectSceneId = scene.id;
    const seq = this.engine.state.lastSeq;
    const nonce = newGmNonce(); // per evaluation, in the system prompt only; never logged
    const coverKey = `exit\n${condition}`;
    const { window, covered, dropped } = this.windowFor(scene, coverKey); // m-1: synchronous with the prompt build below
    const base = buildGmRequest({ scene, condition, state: this.engine.state, maxTokens: this.maxTokens, temperature: this.temperature, nonce, window });
    await this.alertDropped(scene, dropped, `"${condition}"`);
    const out = await runGmEvaluation({
      provider: this.provider, request: base, condition, timeoutMs: this.evaluationTimeoutMs, reask: this.reask, nonce,
      onReply: (r) => this.traceRecord({ seq, sceneId: expectSceneId, condition, window, ...r }),
    });
    if (out.kind !== "alert") this.coveredSeq.set(coverKey, covered);
    if (out.kind === "alert") await this.engine.alert(out.message, "warning", { expectSceneId });
    else if (out.kind === "verdict") await this.engine.recordGmVerdict(condition, out.verdict, out.reasoning, { expectSceneId, via: out.via });
    else await this.engine.recordGmNoVerdict(condition, out.reason, out.attempts, { expectSceneId });
  }
}

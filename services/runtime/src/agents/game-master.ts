import type { ModelProvider } from "@acr/adapters";
import type { SessionEngine } from "../engine/session-engine.js";
import { buildGmRequest, parseGmVerdict } from "./gm-prompt.js";

export class GameMaster {
  private readonly engine: SessionEngine;
  private readonly provider: ModelProvider;
  private readonly everyN: number;
  private evaluatedCount = 0; // utterances in the current scene at the last evaluation
  private lastSceneId: string | null = null;
  private evaluating = false; // R19: at most one evaluation in flight

  constructor(opts: { engine: SessionEngine; provider: ModelProvider; everyNUtterances?: number }) {
    this.engine = opts.engine; this.provider = opts.provider; this.everyN = opts.everyNUtterances ?? 3;
  }

  /**
   * Called by the host about once a second. Always runs engine.tick (timers, injects, exits). Every N new
   * utterances it also evaluates each gm_detects condition. A tick that arrives while an evaluation is in
   * flight skips evaluation (no duplicate model calls or decisions). Never throws on model problems: a model
   * error, empty reply or unparseable verdict records no decision and raises a facilitator.alert instead
   * (warning for errors, info for empty/unparseable). The attempt still counts, so a failing model is retried
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
    } catch {
      // never throw into the host's ticker; engine problems surface through the next tick
    } finally {
      this.evaluating = false;
    }
  }

  private async evaluate(scene: NonNullable<ReturnType<SessionEngine["currentScene"]>>, condition: string): Promise<void> {
    const expectSceneId = scene.id;
    let text = "";
    try {
      for await (const c of this.provider.stream(buildGmRequest({ scene, condition, state: this.engine.state }))) text += c;
    } catch (err) {
      await this.engine.alert(`GM: model error: ${err instanceof Error ? err.message : String(err)}`, "warning", { expectSceneId });
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

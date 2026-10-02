import type { SessionEvent } from "@acr/events";
import type { NpcRole } from "@acr/script";
import type { ModelProvider } from "@acr/adapters";
import { EngineError, type SessionEngine } from "../engine/session-engine.js";
import { buildNpcRequest } from "./npc-prompt.js";

/** Engine refusals that mean "this reply is no longer wanted": drop it rather than crash. */
const STALE_CODES = new Set(["paused", "not_in_scene", "ended"]);

export class NpcAgent {
  private readonly role: NpcRole;
  private readonly engine: SessionEngine;
  private readonly provider: ModelProvider;
  private readonly firstTokenTimeoutMs: number;

  constructor(opts: { role: NpcRole; engine: SessionEngine; provider: ModelProvider; firstTokenTimeoutMs?: number }) {
    this.role = opts.role; this.engine = opts.engine; this.provider = opts.provider;
    this.firstTokenTimeoutMs = opts.firstTokenTimeoutMs ?? 4_000;
  }

  /**
   * Returns the emitted utterance, or null when no NPC turn may happen (not in scene, paused, ended),
   * including when the engine refuses the reply because the state changed during the model call
   * (stale reply is dropped, nothing is said).
   * Timeout, stream error, or empty reply: a facilitator.alert is emitted and the fallback line is spoken.
   */
  async respond(): Promise<SessionEvent | null> {
    const scene = this.engine.currentScene();
    if (!scene || !scene.participants.includes(this.role.id) || this.engine.state.paused || this.engine.state.status !== "running") return null;
    const req = buildNpcRequest({ role: this.role, scene, state: this.engine.state });
    const ac = new AbortController();
    let text = "";
    let failure: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const it = this.provider.stream(req, ac.signal)[Symbol.asyncIterator]();
      const firstP = it.next();
      firstP.catch(() => undefined); // if the timeout wins, a later rejection must not go unhandled
      const first = await Promise.race([
        firstP,
        new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), this.firstTokenTimeoutMs); }),
      ]);
      if (first === "timeout") { ac.abort(); failure = "no first token within timeout"; }
      else if (!first.done) {
        text += first.value;
        for (let r = await it.next(); !r.done; r = await it.next()) text += r.value;
      }
    } catch (err) {
      ac.abort();
      failure = `model error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      clearTimeout(timer);
    }
    if (!failure && text.trim().length === 0) failure = "empty reply";
    try {
      if (failure) {
        await this.engine.alert(`NPC ${this.role.id}: ${failure}; used fallback line`);
        return await this.engine.say(this.role.id, this.role.fallback_line);
      }
      return await this.engine.say(this.role.id, text.trim());
    } catch (err) {
      if (err instanceof EngineError && STALE_CODES.has(err.code)) return null;
      throw err;
    }
  }
}

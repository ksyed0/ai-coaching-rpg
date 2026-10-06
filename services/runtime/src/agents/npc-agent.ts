import type { SessionEvent } from "@acr/events";
import type { NpcRole } from "@acr/script";
import type { ModelProvider } from "@acr/adapters";
import { EngineError, type SessionEngine } from "../engine/session-engine.js";
import { describeModelFailure, describeRetryProgress } from "./model-failure.js";
import { buildNpcRequest } from "./npc-prompt.js";
import { cleanNpcReply } from "./npc-reply.js";
import { DEFAULT_NPC_MAX_TOKENS } from "./token-budgets.js";
import { DEFAULT_FIRST_TOKEN_TIMEOUT_MS, DEFAULT_REPLY_TIMEOUT_MS } from "./timeouts.js";

/** Engine refusals that mean "this reply is no longer wanted": drop it rather than crash. */
const STALE_CODES = new Set(["paused", "not_in_scene", "ended", "stale_scene"]);

export class NpcAgent {
  private readonly role: NpcRole;
  private readonly engine: SessionEngine;
  private readonly provider: ModelProvider;
  private readonly firstTokenTimeoutMs: number;
  private readonly replyTimeoutMs: number;
  /** The model's max_tokens for one reply (NPC_MAX_TOKENS). */
  readonly maxTokens: number;

  constructor(opts: { role: NpcRole; engine: SessionEngine; provider: ModelProvider; firstTokenTimeoutMs?: number; replyTimeoutMs?: number; maxTokens?: number }) {
    this.role = opts.role; this.engine = opts.engine; this.provider = opts.provider;
    this.firstTokenTimeoutMs = opts.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS;
    this.replyTimeoutMs = opts.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
    this.maxTokens = opts.maxTokens ?? DEFAULT_NPC_MAX_TOKENS;
  }

  /** The effective timeouts (defaults applied), for diagnostics and tests. */
  get timeouts(): { firstTokenMs: number; replyMs: number } { return { firstTokenMs: this.firstTokenTimeoutMs, replyMs: this.replyTimeoutMs }; }

  /**
   * Returns the emitted utterance, or null when no NPC turn may happen (not in scene, paused, ended),
   * including when the engine refuses the reply because the state changed during the model call
   * (stale reply is dropped, nothing is said). The scene id is captured before the model call and
   * enforced inside the engine mutex, so a reply (or fallback) from scene A is never posted into scene B.
   * Timeout, stream error, or empty reply: a facilitator.alert is emitted and the fallback line is spoken. A transient model error
   * is retried by the provider wrapper (when configured) inside the first-token and reply deadlines before it gets here; the alert then
   * carries the attempt count and the error kind.
   */
  async respond(): Promise<SessionEvent | null> {
    const scene = this.engine.currentScene();
    if (!scene || !scene.participants.includes(this.role.id) || this.engine.state.paused || this.engine.state.status !== "running") return null;
    const req = buildNpcRequest({ role: this.role, scene, state: this.engine.state, maxTokens: this.maxTokens });
    const expectSceneId = scene.id;
    const ac = new AbortController();
    let text = "";
    let failure: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let replyTimer: ReturnType<typeof setTimeout> | undefined;
    // R21: one overall deadline covers the whole reply so a mid-stream stall cannot wedge the scene.
    const deadline = new Promise<"deadline">((r) => { replyTimer = setTimeout(() => r("deadline"), this.replyTimeoutMs); });
    try {
      const it = this.provider.stream(req, ac.signal)[Symbol.asyncIterator]();
      const firstP = it.next();
      firstP.catch(() => undefined); // if a timeout wins, a later rejection must not go unhandled
      const first = await Promise.race([
        firstP,
        deadline,
        new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), this.firstTokenTimeoutMs); }),
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
    }
    // The reply is assembled in full before it is cleaned or recorded: nothing is forwarded to players chunk by chunk, so cut text never leaks.
    let removedOtherSpeakers = false;
    if (!failure) {
      const cleaned = cleanNpcReply(text, this.role, this.engine.speakerNames().filter((n) => n.id !== this.role.id));
      text = cleaned.text; removedOtherSpeakers = cleaned.cut;
    }
    if (!failure && !/[\p{L}\p{N}]/u.test(text)) failure = "empty reply"; // nothing but punctuation (e.g. "...") is not a reply
    try {
      if (removedOtherSpeakers) await this.engine.alert(`NPC ${this.role.id}: the reply included lines for other speakers; they were removed`, "warning", { expectSceneId });
      if (failure) {
        await this.engine.alert(`NPC ${this.role.id}: ${failure}; used fallback line`, "warning", { expectSceneId });
        return await this.engine.say(this.role.id, this.role.fallback_line, "text", { expectSceneId, fallback: true });
      }
      return await this.engine.say(this.role.id, text.trim(), "text", { expectSceneId });
    } catch (err) {
      if (err instanceof EngineError && STALE_CODES.has(err.code)) return null;
      throw err;
    }
  }
}

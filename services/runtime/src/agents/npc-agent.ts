import type { SessionEvent } from "@acr/events";
import type { NpcRole } from "@acr/script";
import type { ModelProvider } from "@acr/adapters";
import { EngineError, type SessionEngine } from "../engine/session-engine.js";
import { collectModelReply } from "./model-reply.js";
import { buildNpcRequest, type PublicPeer } from "./npc-prompt.js";
import { cleanNpcReply, stripSilentMarker } from "./npc-reply.js";
import { DEFAULT_NPC_MAX_TOKENS } from "./token-budgets.js";
import { DEFAULT_FIRST_TOKEN_TIMEOUT_MS, DEFAULT_REPLY_TIMEOUT_MS } from "./timeouts.js";

/** Engine refusals that mean "this reply is no longer wanted": drop it rather than crash. */
const STALE_CODES = new Set(["paused", "not_in_scene", "ended", "stale_scene"]);

/** The extra system line of the single re-ask after a verbatim repeat. */
export const REPEAT_REASK = "Your last reply was identical to an earlier one; say something new that moves the conversation forward.";
/** The extra system line of the single re-ask when a character answered with the silence marker although silence was not allowed. */
export const SILENCE_NOT_ALLOWED_REASK = "You may not stay silent this turn: answer in words, in your own voice, with something only you would say.";
/** A character may stay silent at most this many turns in a row; the next turn does not offer silence. */
export const MAX_CONSECUTIVE_SILENT_TURNS = 2;
/** What the host is told about a silent turn (no utterance, no alert: only a count). */
export type SilentTurn = { roleId: string; sceneId: string; /** The last event seq at the moment the character chose to stay silent. */ afterSeq: number };
const REPEAT_WINDOW = 3;
const normalizeForRepeat = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export class NpcAgent {
  private readonly role: NpcRole;
  private readonly engine: SessionEngine;
  private readonly provider: ModelProvider;
  private readonly firstTokenTimeoutMs: number;
  private readonly replyTimeoutMs: number;
  /** The model's max_tokens for one reply (NPC_MAX_TOKENS). */
  readonly maxTokens: number;
  /** Sampling temperature (NPC_TEMPERATURE); undefined leaves the provider default. */
  readonly temperature: number | undefined;
  /** The AI characters of the scenario (only their public data is used), so a character knows who else is in the room. */
  private readonly peers: PublicPeer[];
  private readonly onSilent: ((t: SilentTurn) => void) | undefined;
  private silentRun: { sceneId: string; n: number } = { sceneId: "", n: 0 };
  /** 1 to 5 (default 3): decides the order in which AI characters reply. */
  get seniority(): number { return this.role.seniority ?? 3; }
  /** How many turns this character has chosen to stay silent so far. */
  silentTurns = 0;

  constructor(opts: { role: NpcRole; engine: SessionEngine; provider: ModelProvider; firstTokenTimeoutMs?: number; replyTimeoutMs?: number; maxTokens?: number; temperature?: number; peers?: PublicPeer[]; onSilent?: (t: SilentTurn) => void }) {
    this.role = opts.role; this.engine = opts.engine; this.provider = opts.provider;
    this.peers = opts.peers ?? []; this.onSilent = opts.onSilent;
    this.firstTokenTimeoutMs = opts.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS;
    this.replyTimeoutMs = opts.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
    this.maxTokens = opts.maxTokens ?? DEFAULT_NPC_MAX_TOKENS;
    this.temperature = opts.temperature;
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
  /** True when `text` equals (normalised) one of this character's own last 3 recorded lines. */
  private isRepeat(text: string): boolean {
    const norm = normalizeForRepeat(text);
    if (norm === "") return false;
    const own = this.engine.state.transcript.filter((u) => u.roleId === this.role.id).slice(-REPEAT_WINDOW);
    return own.some((u) => normalizeForRepeat(u.text) === norm);
  }

  async respond(): Promise<SessionEvent | null> {
    const scene = this.engine.currentScene();
    if (!scene || !scene.participants.includes(this.role.id) || this.engine.state.paused || this.engine.state.status !== "running") return null;
    const inRoom = this.peers.some((p) => p.id !== this.role.id && scene.participants.includes(p.id));
    const run = this.silentRun.sceneId === scene.id ? this.silentRun.n : 0;
    // Silence is offered only when another AI character is in the room, and never after MAX_CONSECUTIVE_SILENT_TURNS silent turns in a row.
    const offered = inRoom && run < MAX_CONSECUTIVE_SILENT_TURNS;
    const req = buildNpcRequest({ role: this.role, scene, state: this.engine.state, maxTokens: this.maxTokens, temperature: this.temperature, peers: this.peers, allowSilence: offered });
    const expectSceneId = scene.id;
    const started = performance.now();
    const collected = await collectModelReply(this.provider, req, { firstTokenTimeoutMs: this.firstTokenTimeoutMs, replyTimeoutMs: this.replyTimeoutMs });
    let text = collected.text;
    let failure: string | null = collected.failure;
    // The reply is assembled in full before it is cleaned or recorded: nothing is forwarded to players chunk by chunk, so cut text never leaks.
    let removedOtherSpeakers = false;
    const others = this.engine.speakerNames().filter((n) => n.id !== this.role.id);
    /** Cleans a raw reply; the silence marker is always removed (it is never text), `silent` says nothing but the marker was left. */
    const clean = (raw: string): { text: string; cut: boolean; silent: boolean } => {
      const c = cleanNpcReply(raw, this.role, others);
      const m = stripSilentMarker(c.text);
      return { text: m.text, cut: c.cut, silent: m.silent };
    };
    const reask = async (extra: string): Promise<ReturnType<typeof clean> | null> => {
      const left = this.replyTimeoutMs - (performance.now() - started);
      if (left < 1) return null;
      const again = await collectModelReply(this.provider, { ...req, system: `${req.system}\n\n${extra}` }, { firstTokenTimeoutMs: Math.min(this.firstTokenTimeoutMs, left), replyTimeoutMs: left });
      return again.failure ? null : clean(again.text);
    };
    let silent = false;
    if (!failure) {
      const cleaned = clean(text);
      text = cleaned.text; removedOtherSpeakers = cleaned.cut; silent = cleaned.silent;
    }
    if (!failure && silent && !offered) {
      // The model stayed silent although silence was not offered (a lone character, or a third silent turn in a row): ask once more, then fall back.
      silent = false;
      const second = await reask(SILENCE_NOT_ALLOWED_REASK);
      if (second && !second.silent && /[\p{L}\p{N}]/u.test(second.text)) { text = second.text; removedOtherSpeakers = second.cut; }
      else failure = "no reply (silence was not allowed this turn)";
    }
    if (!failure && !silent && !/[\p{L}\p{N}]/u.test(text)) failure = "empty reply"; // nothing but punctuation (e.g. "...") is not a reply
    // Cheap deterministic repetition guard: a reply identical (ignoring case, spacing and punctuation) to one of the character's own last 3 replies is asked for once more,
    // inside what is left of the same reply deadline; if the second reply is just as identical (or the re-ask fails) the first one is spoken, with one warning.
    let repeated = false;
    if (!failure && !silent && this.isRepeat(text)) {
      const second = await reask(REPEAT_REASK);
      if (second?.silent && offered) silent = true; // nothing new to add: staying silent beats repeating
      else if (second && /[\p{L}\p{N}]/u.test(second.text) && !this.isRepeat(second.text)) { text = second.text; removedOtherSpeakers = second.cut; }
      else repeated = true;
    }
    if (silent) return this.stayedSilent(scene.id);
    try {
      if (removedOtherSpeakers) await this.engine.alert(`NPC ${this.role.id}: the reply included lines for other speakers; they were removed`, "warning", { expectSceneId });
      if (repeated) await this.engine.alert(`character ${this.role.id} repeated an earlier reply verbatim`, "warning", { expectSceneId });
      if (failure) {
        await this.engine.alert(`NPC ${this.role.id}: ${failure}; used fallback line`, "warning", { expectSceneId });
        this.silentRun = { sceneId: scene.id, n: 0 };
        return await this.engine.say(this.role.id, this.role.fallback_line, "text", { expectSceneId, fallback: true });
      }
      this.silentRun = { sceneId: scene.id, n: 0 };
      return await this.engine.say(this.role.id, text.trim(), "text", { expectSceneId });
    } catch (err) {
      if (err instanceof EngineError && STALE_CODES.has(err.code)) return null;
      throw err;
    }
  }

  /** A silent turn is no utterance, no fallback and no alert: nothing is recorded, only counted (and reported to `onSilent`) while the reply is still wanted. */
  private stayedSilent(sceneId: string): null {
    if (this.engine.state.paused || this.engine.state.status !== "running" || this.engine.currentScene()?.id !== sceneId) return null;
    this.silentRun = { sceneId, n: (this.silentRun.sceneId === sceneId ? this.silentRun.n : 0) + 1 };
    this.silentTurns++;
    try { this.onSilent?.({ roleId: this.role.id, sceneId, afterSeq: this.engine.state.lastSeq }); } catch { /* a reporting hook must never break the turn */ }
    return null;
  }
}

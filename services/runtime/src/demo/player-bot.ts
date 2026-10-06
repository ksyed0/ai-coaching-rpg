import type { SessionEvent } from "@acr/events";
import type { ChatRequest, ModelProvider } from "@acr/adapters";
import type { NpcRole, Scenario, Scene } from "@acr/script";
import { collectModelReply } from "../agents/model-reply.js";
import { cleanNpcReply, type SpeakerName } from "../agents/npc-reply.js";
import { MAX_LINE_CHARS } from "./showcase-script.js";
import { buildPlayerRequest, roleLabel, viewFromEvents } from "./player-prompt.js";
import type { PlayerLineRecord } from "./player-lines.js";

export type PlayerSpeech = Omit<PlayerLineRecord, "role" | "text"> & { text: string };

/** C0/C1 controls (not tab or line breaks, which are folded into spaces later) and bidi controls: never sent to the server. */
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** A leading echo of the private intent note: "[note to you only, not spoken]:", "Note:", and the note's own lead-in. */
const NOTE_PREFIX = /^\s*(?:\[\s*note\b[^\]]*\]|note)\s*:\s*(?:what you want to get across in this turn\s*\(do not quote it\)\s*:\s*)?/i;
const dropNote = (t: string): string => { let out = t; for (let i = 0; i < 3 && NOTE_PREFIX.test(out); i++) out = out.replace(NOTE_PREFIX, ""); return out; };

const norm = (t: string): string => t.toLowerCase().replace(/\s+/g, " ").trim();
const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/**
 * Makes the player bots speak with a model (`--players generated`). For one scripted line slot it asks the provider for that role's
 * next line (the scripted text is only a private intent), cleans the reply like an AI character's, and returns either the generated
 * text or, when the model failed or produced nothing usable, the scripted line with the reason. It never throws for a model problem.
 * The text it returns goes to the server only through the bot's ordinary `say`.
 */
export class PlayerBotGenerator {
  /** Every request made, for the prompt audit (S-15). */
  readonly calls: ChatRequest[] = [];
  /** The role each captured request was made for (parallel to `calls`). */
  readonly callRoles: string[] = [];
  constructor(private readonly o: {
    provider: ModelProvider; scenario: Scenario; firstTokenTimeoutMs: number; replyTimeoutMs: number; maxTokens: number; temperature?: number; signal?: AbortSignal;
  }) {}

  async speak(a: { roleId: string; scene: Scene; scripted: string; joined: { brief?: string; privateFacts?: string[] }; events: SessionEvent[] }): Promise<PlayerSpeech> {
    const view = viewFromEvents({ roleId: a.roleId, joined: a.joined, scene: a.scene, events: a.events });
    const req = buildPlayerRequest({ view, intent: a.scripted, maxTokens: this.o.maxTokens, temperature: this.o.temperature });
    this.calls.push(req); this.callRoles.push(a.roleId);
    const fallback = (reason: string): PlayerSpeech => ({ text: a.scripted, source: "scripted", verbatim: false, cut: false, reason: clip(reason, 200) });
    const got = await collectModelReply(this.o.provider, req, { firstTokenTimeoutMs: this.o.firstTokenTimeoutMs, replyTimeoutMs: this.o.replyTimeoutMs, signal: this.o.signal });
    if (got.failure) return fallback(got.failure);
    const self: SpeakerName = { id: a.roleId, name: roleLabel(a.roleId) };
    const others: SpeakerName[] = Object.values(this.o.scenario.roles).filter((r) => r.id !== a.roleId)
      .map((r) => ({ id: r.id, name: r.type === "npc" ? (r as NpcRole).name : roleLabel(r.id) }));
    const cleaned = cleanNpcReply(dropNote(got.text.replace(CONTROLS, "")), self, others);
    // One spoken line: line breaks become spaces; an echoed intent note is dropped.
    const text = dropNote(cleaned.text.replace(CONTROLS, "")).replace(/\s+/g, " ").trim();
    if (!/[\p{L}\p{N}]/u.test(text)) return fallback(cleaned.cut ? "the reply held only lines for other speakers" : "empty reply");
    if (text.length > MAX_LINE_CHARS) return fallback(`reply longer than ${MAX_LINE_CHARS} characters`);
    return { text, source: "generated", verbatim: norm(text) === norm(a.scripted), cut: cleaned.cut };
  }
}

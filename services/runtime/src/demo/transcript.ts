import type { SessionEvent } from "@acr/events";
import type { NpcRole, Scenario } from "@acr/script";
import type { Bot, Inbound } from "./bots.js";
import { classifyGmDecision, classifyNpcReply, fallbackReason, isFallbackReply, type Provenance, type ProviderKind } from "./provenance.js";

/** One structured line of a run. Produced where the story knows who produced it; the Markdown file is rendered from these, never from narration text. */
export type TLine = {
  kind: "dialogue" | "log" | "heading";
  /** Dialogue: scripted | generated | fallback. Logging and headings: system. */
  source: Provenance;
  speaker?: string;
  role?: string;
  text: string;
  scene?: string | null;
  /** Milliseconds since the run started. */
  atMs: number;
  /** A Game Master decision: its verdict and the condition it judged (`text` is its reasoning). */
  gm?: { verdict: boolean; condition: string };
};
export type RecordInput = Omit<TLine, "atMs">;

const EXIT = (reason: string) => reason.replace(/_/g, " ");

/**
 * Collects the run's structured lines. Headings and logging arrive from the narrator; dialogue arrives from the facilitator's
 * event stream (`attach`), which is the one place that knows a line's producer.
 */
export class Transcript {
  readonly records: TLine[] = [];
  constructor(private readonly now: () => number, private readonly startedMs: number) {}

  add(r: RecordInput): void { this.records.push({ ...r, atMs: this.now() - this.startedMs }); }

  /**
   * Records what a facilitator connection observes. `provider` says whether AI replies come from the scripted mock providers or a
   * live model. `sceneHeadings` turns scene starts into `##` headings (a story that has its own act headings leaves it off).
   */
  attach(fac: Bot, o: { scenario: Scenario; provider: ProviderKind; sceneHeadings: boolean }): void {
    const previous = fac.onMessage;
    let last: SessionEvent | undefined;
    let scene: string | null = null;
    const title = (id: string) => o.scenario.script.scenes.find((s) => s.id === id)?.title ?? id;
    const consume = (m: Inbound): void => {
      if (m.type !== "event") return;
      const e = m.event;
      const prev = last; last = e;
      switch (e.type) {
        case "scene.entered":
          scene = e.sceneId;
          if (o.sceneHeadings) {
            const i = o.scenario.script.scenes.findIndex((s) => s.id === e.sceneId);
            const sc = o.scenario.script.scenes[i];
            this.add({ kind: "heading", source: "system", text: `Scene ${i + 1} of ${o.scenario.script.scenes.length}: ${title(e.sceneId)}`, scene });
            if (sc) {
              const ai = e.participants.filter((p) => o.scenario.roles[p]?.type === "npc").map((p) => (o.scenario.roles[p] as NpcRole).name);
              this.add({ kind: "log", source: "system", text: `goal: ${sc.goal}; AI characters in the room: ${ai.join(", ") || "none"}`, scene });
            }
          } else this.add({ kind: "log", source: "system", text: `scene entered: ${e.sceneId}`, scene });
          break;
        case "scene.exited": this.add({ kind: "log", source: "system", text: `scene ${e.sceneId} ended: ${EXIT(e.reason)} (${e.reason})`, scene }); scene = null; break;
        case "utterance": {
          const role = o.scenario.roles[e.roleId];
          if (role?.type === "npc") {
            const npc = role as NpcRole;
            this.add({ kind: "dialogue", source: classifyNpcReply(o.provider, isFallbackReply(npc, e, prev, { legacy: o.provider === "remote" })), speaker: npc.name, role: npc.id, text: e.text, scene });
          } else this.add({ kind: "dialogue", source: "scripted", speaker: e.roleId, role: e.roleId, text: e.text, scene });
          break;
        }
        case "gm.decision":
          this.add({ kind: "dialogue", source: classifyGmDecision(o.provider), speaker: "Game Master", text: e.reasoning, scene: e.sceneId, gm: { verdict: e.verdict, condition: e.condition } });
          break;
        case "facilitator.alert": {
          const why = fallbackReason(e.message);
          this.add({ kind: "log", source: "system", text: why !== null ? `alert (${e.level}): fallback line used: ${why}` : `alert (${e.level}): ${e.message}`, scene });
          break;
        }
        case "facilitator.command":
          if (e.command === "whisper") this.add({ kind: "dialogue", source: "scripted", speaker: `facilitator (whisper to ${e.roleId})`, text: e.text, scene });
          else this.add({ kind: "log", source: "system", text: `facilitator: ${e.command}`, scene });
          break;
        case "inject.fired": this.add({ kind: "log", source: "system", text: `inject ${e.injectId} to ${e.to.join(", ")}: ${e.content}`, scene }); break;
        case "session.started": this.add({ kind: "log", source: "system", text: "session started", scene }); break;
        case "session.ended": this.add({ kind: "log", source: "system", text: `session ended (${e.reason})`, scene }); break;
        default: break;
      }
    };
    fac.onMessage = (m) => { previous?.(m); consume(m); };
  }
}

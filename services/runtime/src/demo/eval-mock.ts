import type { ChatRequest } from "@acr/adapters";
import type { SessionEvent } from "@acr/events";
import type { Criterion, Rubric, Scenario } from "@acr/script";
import { buildTranscript, type UtteranceRec } from "../evaluator/transcript.js";

/** The offline evaluator's replies are produced from the recorded session itself, so every quote is real and verifiable. */
export const SCRIPTED_EVALUATOR_NAME = "demo-scripted-evaluator";

/** A sentence-sized piece of a line that is safe to quote: the first sentence, at most 120 characters, cut at a word boundary. */
export function fragmentOf(u: UtteranceRec, skip = 0): string {
  const sentences = u.norm.split(/(?<=[.!?])\s+/).filter((s) => s.length >= 12);
  const s = sentences[skip % Math.max(sentences.length, 1)] ?? u.norm;
  if (s.length <= 120) return s;
  const cut = s.slice(0, 120);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 40));
}

const BAD_QUOTE = "this sentence was never said by anyone in the session";
export const MALFORMED_REPLY = "Here is my assessment of the participant. Overall they did reasonably well, but I will describe it in prose instead of the JSON format.";

function criteriaFor(rubric: Criterion[], pool: UtteranceRec[], roleIndex: number, o: { badQuote: boolean }) {
  return rubric.map((c, ci) => {
    const k = (ci + roleIndex) % 7;
    const n = pool.length;
    if (k === 6 || n === 0) return { id: c.id, score: null, rationale: `No evidence either way for ${c.name} (scripted demo evaluation).`, evidence: [], confidence: "low" };
    const score = 2 + ((ci + roleIndex) % 3);
    const items = Array.from({ length: 1 + ((ci + roleIndex) % 3) }, (_, j) => {
      const u = pool[(ci + j * 2) % n]!;
      return { seq: u.seq, quote: fragmentOf(u, j) };
    });
    let evidence: { seq: number; quote: string }[] = items;
    let finalScore = score;
    if (o.badQuote && ci === 0) { evidence = [{ seq: pool[0]!.seq, quote: BAD_QUOTE }]; finalScore = 4; } // an invented quote on a 4: dropped, then capped at 2
    else if (o.badQuote && ci === 1) evidence = [...items, { seq: pool[0]!.seq, quote: BAD_QUOTE }]; // one real, one invented: the bad one is dropped
    return { id: c.id, score: finalScore, rationale: `Scripted demo score for ${c.name}: level ${finalScore}.`, evidence, confidence: items.length >= 3 ? "high" : "medium" };
  });
}

/**
 * A scripted model for the offline evaluator (the mock run of `pnpm demo --showcase --evaluate`, and `pnpm evaluate` when MODEL_PROVIDER is
 * mock). It reads the recorded session and answers each request from it, deterministically: the first player gets a clean answer, the
 * second one an invented quote (to exercise verification and the cap), the third a malformed reply first and a valid one on the re-ask.
 */
export function createScriptedEvaluator(events: SessionEvent[], scenario: Scenario, rubrics: Rubric[]) {
  const t = buildTranscript(events, scenario);
  const players = Object.values(scenario.roles).filter((r) => r.type === "player").map((r) => r.id);
  const individual = rubrics.filter((r) => r.scope === "individual").flatMap((r) => r.criteria);
  const group = rubrics.filter((r) => r.scope === "group").flatMap((r) => r.criteria);
  const los = scenario.meta.learning_objectives;
  const mine = (role: string) => [...t.utterances.values()].filter((u) => u.roleId === role);
  const playerLines = [...t.utterances.values()].filter((u) => u.speaker === "player");
  const calls: ChatRequest[] = [];
  const seen = new Map<string, number>();
  return {
    name: SCRIPTED_EVALUATOR_NAME,
    calls,
    async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<string> {
      calls.push(req);
      const who = /score ONLY the participant with role id "([a-z0-9_-]+)"/i.exec(req.system)?.[1] ?? "";
      const key = who || "group";
      const nth = (seen.get(key) ?? 0) + 1; seen.set(key, nth);
      let body: unknown;
      if (who) {
        const idx = Math.max(players.indexOf(who), 0);
        const pool = mine(who);
        if (idx % 3 === 2 && nth === 1) { yield MALFORMED_REPLY; return; }
        body = {
          criteria: criteriaFor(individual, pool, idx, { badQuote: idx % 3 === 1 }),
          strengths: [`You contributed ${pool.length} line(s) and kept to your part of the conversation (scripted demo text).`, "You stayed on the topic the scene asked for (scripted demo text)."],
          development_points: ["Try asking one more open question before proposing a solution (scripted demo text).", "State the trade-offs of your option out loud (scripted demo text)."],
          next_actions: los.slice(0, 3).map((lo) => ({ lo: lo.id, action: `In your next conversation, practise one concrete step towards: ${lo.statement}.` })),
        };
      } else {
        body = {
          criteria: criteriaFor(group, playerLines, 1, { badQuote: false }),
          talking_points: [
            "Compare the first position the team took with the final terms it offered, and ask what moved it (scripted demo text).",
            "Ask who owned the price and who owned the timeline, and how the team decided (scripted demo text).",
            "Ask what the team would do differently if the client had pushed back harder (scripted demo text).",
          ],
          notable_moments: [playerLines[0], playerLines.at(-1)].filter((u): u is UtteranceRec => u !== undefined).map((u, i) => ({ seq: u.seq, quote: fragmentOf(u), note: i === 0 ? "How the team opened (scripted demo text)." : "How the team closed (scripted demo text)." })),
        };
      }
      if (signal?.aborted) return;
      yield JSON.stringify(body);
    },
  };
}

import type { ChatRequest, ModelProvider } from "@acr/adapters";

export type Decide = (ctx: { role: string; transcript: string }) => Record<string, number | null>;

/** Answers participant calls with a score per criterion chosen by `decide`, quoting a real line of that participant. */
export function fakeJudge(criteriaIds: string[], decide: Decide, failFor?: (role: string) => boolean): ModelProvider & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return {
    name: "fake-judge", calls,
    async *stream(req: ChatRequest): AsyncIterable<string> {
      calls.push(req);
      const role = /score only the participant with role id "([a-z0-9_-]+)"/i.exec(req.system)?.[1];
      if (!role) { yield JSON.stringify({ criteria: [], talking_points: [], notable_moments: [] }); return; }
      if (failFor?.(role)) throw new Error("judge unreachable");
      const transcript = req.messages.map((m) => m.content).join("\n");
      const own = [...transcript.matchAll(new RegExp(`#(\\d+) [0-9:]{8} ${role} \\(player\\): (.*)`, "g"))];
      const first = own[0];
      const levels = decide({ role, transcript });
      const criteria = criteriaIds.map((id) => ({
        id, score: levels[id] ?? null, rationale: `Because ${id}.`, confidence: "high",
        evidence: first ? [{ seq: Number(first[1]), quote: first[2]!.slice(0, 60) }] : [],
      }));
      yield JSON.stringify({ criteria, strengths: [], development_points: [], next_actions: [] });
    },
  };
}

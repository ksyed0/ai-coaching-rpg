import type { ChatRequest, ModelProvider } from "@acr/adapters";

export type Decide = (ctx: { role: string; transcript: string }) => Record<string, number | null>;

export type FakeJudge = ModelProvider & {
  calls: ChatRequest[];
  /** Messages of the errors this judge threw because `failFor` said the role is unreachable. */
  unreachable: string[];
  /** System prompts of requests that were not participant requests (a group request or a changed prompt format). Tests assert this stays empty. */
  unexpected: string[];
};

export const UNREACHABLE = "fake judge: unreachable on purpose";

/**
 * Answers participant calls with a score per criterion chosen by `decide`, quoting a piece of the participant's first line (`quoteOf` can change the quote).
 * Throws on any request it cannot read as a participant request, and records it in `unexpected`, because `evaluateSession` swallows provider errors.
 */
export function fakeJudge(criteriaIds: string[], decide: Decide, failFor?: (role: string) => boolean, quoteOf: (line: string) => string = (l) => l.slice(0, 60)): FakeJudge {
  const calls: ChatRequest[] = [];
  const unreachable: string[] = [];
  const unexpected: string[] = [];
  return {
    name: "fake-judge", calls, unreachable, unexpected,
    async *stream(req: ChatRequest): AsyncIterable<string> {
      calls.push(req);
      const role = /score only the participant with role id "([a-z0-9_-]+)"/i.exec(req.system)?.[1];
      if (!role) { unexpected.push(req.system.slice(0, 200)); throw new Error("fake judge: not a participant request"); }
      if (failFor?.(role)) { unreachable.push(UNREACHABLE); throw new Error(UNREACHABLE); }
      const transcript = req.messages.map((m) => m.content).join("\n");
      const own = [...transcript.matchAll(new RegExp(`#(\\d+) [0-9:]{8} ${role} \\(player\\): (.*)`, "g"))];
      const first = own[0];
      const levels = decide({ role, transcript });
      const criteria = criteriaIds.map((id) => ({
        id, score: levels[id] ?? null, rationale: `Because ${id}.`, confidence: "high",
        evidence: first ? [{ seq: Number(first[1]), quote: quoteOf(first[2]!) }] : [],
      }));
      yield JSON.stringify({ criteria, strengths: [], development_points: [], next_actions: [] });
    },
  };
}

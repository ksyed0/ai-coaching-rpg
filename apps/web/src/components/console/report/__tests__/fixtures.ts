// Shapes the BFF answers with for the facilitator's report routes (src/server/launcher-client.ts), for the report panel's tests.

export const SID = "abcd1234efgh5678";
export const BASE = `/api/v1/console/sessions/${SID}/report`;

export const job = (over: Record<string, unknown> = {}) => ({ state: "idle", startedAt: null, progress: [] as string[], modelCalls: null, ...over });

export const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, state: "draft", version: null, criteriaTotal: 3, openCriteria: [] as string[], summaryStale: false, tableStale: false, evaluationOk: true, selfRated: 0, openDisputes: [] as unknown[], ...over,
});

export const summary = (over: Record<string, unknown> = {}) => ({
  npcReplies: 10, fallbackReplies: 2, scenesEndedByGm: 1,
  byCharacter: [{ roleId: "client", name: "Dana", replies: 6, fallbackReplies: 2 }],
  alerts: [{ seq: 12, level: "warning", role: "account_manager", fallback: true, reason: "The model did not answer in time", replySeq: 11 }],
  ...over,
});

export const overview = (over: Record<string, unknown> = {}) => ({
  stage: "not_evaluated", job: job(), confirm: { upTo: 8 }, orphan: false, summary: null, subjects: [] as unknown[], ...over,
});

export const inReview = (subjects: unknown[] = [row("account_manager", { openCriteria: ["clarity"] }), row("group")]) =>
  overview({ stage: "in_review", job: job({ state: "done", modelCalls: 6 }), confirm: null, summary: summary(), subjects });

export const criterion = (over: Record<string, unknown> = {}) => ({
  id: "clarity", name: "Clarity", current: 3, status: "needs_review", rationale: "Stated the plan.", evidence: [{ quote: "We start Monday." }], flags: [] as string[], ...over,
});

export const subjectView = (over: Record<string, unknown> = {}) => ({
  id: "account_manager", state: "draft", criteria: [criterion()], summary: { strengths: ["Clear"], developments: [], actions: [] },
  objectives: [], comments: [], responses: [], versions: [], ...over,
});

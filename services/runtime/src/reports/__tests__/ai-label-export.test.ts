import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatRequest } from "@acr/adapters";
import type { SessionEvent } from "@acr/events";
import { evaluateSession } from "../../evaluator/evaluate.js";
import { parseEvalConfig } from "../../evaluator/config.js";
import { writeReports } from "../../evaluator/report-write.js";
import {
  sampleAnswers,
  sampleEvents,
  sampleRubrics,
  sampleScenario,
} from "../../evaluator/__tests__/fixtures.js";
import { loadReview } from "../../review/store.js";
import { fixedClock, makeRunner } from "../../review/__tests__/fixtures.js";
import { exportReport } from "../../moderation/index.js";
import { collectSecrets, readReleasedView } from "../index.js";

// AC-0380: the "(AI player)" marker on an ai: true quote survives the participant read path and the facilitator export.
const cfg = parseEvalConfig({});
if (!cfg.ok) throw new Error("cfg");
const BOB_SEQ = 6;
const BOB_TEXT = "a phased module costs about three person-weeks";
const provider = {
  name: "router",
  async *stream(req: ChatRequest): AsyncIterable<string> {
    const key = /role id "(\w+)"/.exec(req.system)?.[1] ?? "group";
    const group = {
      criteria: [
        {
          id: "shared_understanding",
          score: 3,
          rationale: "r",
          confidence: "high",
          evidence: [{ seq: BOB_SEQ, quote: BOB_TEXT }],
        },
      ],
      talking_points: ["t"],
      notable_moments: [{ seq: BOB_SEQ, quote: BOB_TEXT, note: "effort named" }],
    };
    yield JSON.stringify(key === "group" ? group : sampleAnswers[key]);
  },
};
const aiEvents = (): SessionEvent[] => {
  const evs = sampleEvents().map((e) => ({ ...e })) as SessionEvent[];
  Object.assign(evs[0] as unknown as Record<string, unknown>, {
    logFormat: 3,
    aiRoles: ["bob"],
    includeInGroup: true,
  });
  return evs;
};

let root: string, dir: string, sessionId: string;
const now = fixedClock(1_900_000_000_000);
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "acr-ailabel-"));
  const result = await evaluateSession({
    events: aiEvents(),
    scenario: sampleScenario(),
    rubrics: sampleRubrics(),
    provider,
    config: cfg,
    nonce: "n",
  });
  ({ dir } = await writeReports(result, {
    outDir: root,
    evaluator: { provider: "scripted mock", scripted: true, rubricHash: "h1", variant: "v1" },
  }));
  sessionId = path.basename(dir);
  const run = makeRunner(root);
  const rel = path.relative(root, dir);
  await run(["open", rel, "--by", "kamal"]);
  const l = await loadReview(dir);
  for (const sv of l.view.subjects.values()) {
    for (const c of sv.criteria.filter((x) => x.status === "needs_review"))
      await run(["accept", rel, sv.id, c.id, "--by", "kamal"]);
    if ((await loadReview(dir)).view.subjects.get(sv.id)!.summaryStale)
      await run(["accept", rel, sv.id, "--summary", "--by", "kamal"]);
  }
  expect((await run(["release", rel, "--all", "--by", "kamal"])).code).toBe(0);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const quoteLines = (md: string) => md.split("\n").filter((l) => l.includes(`line #${BOB_SEQ},`));

describe("a released group report holding an ai: true quote", () => {
  it("released group report keeps the (AI player) marker in readReleasedView markdown", async () => {
    const r = await readReleasedView(root, sessionId, "alice", collectSecrets({}));
    if (r.kind !== "released") throw new Error(r.kind);
    expect(r.markdown.group).not.toBeNull();
    const lines = quoteLines(r.markdown.group!);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.includes("(AI player)"))).toBe(true);
    expect(r.group!.criteria[0]!.evidence[0]).toMatchObject({ ai: true });
  });

  it("released group report keeps the (AI player) marker in the exportReport output", async () => {
    for (const audience of ["facilitator", "participant:alice"] as const) {
      const p = await exportReport({ dir, by: "priya-console", now, secrets: [], subject: "group", audience });
      const lines = quoteLines(p.markdown);
      expect(lines.length, audience).toBeGreaterThan(0);
      expect(lines.every((l) => l.includes("(AI player)")), audience).toBe(true);
    }
  });
});

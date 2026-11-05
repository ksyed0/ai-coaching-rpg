import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { canView } from "../policy.js";
import { loadDrafts } from "../draft.js";
import { loadReview } from "../store.js";
import { makeRunner } from "./fixtures.js";

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

let root: string, dir: string, run: ReturnType<typeof makeRunner>, rel: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "acr-rvai-"));
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
  run = makeRunner(root);
  rel = path.relative(root, dir);
  await run(["open", rel, "--by", "kamal"]);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const groupPath = () => path.join(dir, "group.json");
const tamper = async (fn: (g: Record<string, any>) => void) => {
  const g = JSON.parse(await readFile(groupPath(), "utf8"));
  fn(g);
  await writeFile(groupPath(), JSON.stringify(g));
};
const resolveAll = async () => {
  const l = await loadReview(dir);
  for (const sv of l.view.subjects.values()) {
    for (const c of sv.criteria.filter((x) => x.status === "needs_review"))
      await run(["accept", rel, sv.id, c.id, "--by", "kamal"]);
    const cur = (await loadReview(dir)).view.subjects.get(sv.id)!;
    if (cur.summaryStale)
      await run(["accept", rel, sv.id, "--summary", "--by", "kamal"]);
  }
};

describe("the review of a session with an AI player", () => {
  it('the facilitator index of an AI session lists "| bob | AI player, not scored | - |"', async () => {
    const { renderReviewIndex } = await import("../index-view.js");
    const md = renderReviewIndex(await loadReview(dir), { audience: "facilitator" }, []);
    expect(md).toContain("| `bob` | AI player, not scored | - |"); // ids are rendered by id(), like the subject rows
    const header = md.split("\n").find((l) => l.startsWith("| Learning objective"))!;
    expect(header).not.toContain("bob");
    expect(md).not.toContain("`bob` | draft");
    const part = renderReviewIndex(await loadReview(dir), { audience: "participant", role: "alice" }, []);
    expect(part).not.toContain("AI player");
    expect(part).not.toContain("bob");
  });

  it('self-assess --role bob is refused "that role is not a player in this review"', async () => {
    const r = await run(["self-assess", rel, "--role", "bob", "--list"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("that role is not a player in this review");
  });

  it("export --for participant:bob of group is refused and canView for participant:bob of bob denies", async () => {
    await resolveAll();
    expect((await run(["release", rel, "--all", "--by", "kamal"])).code).toBe(0);
    const r = await run(["export", rel, "group", "--for", "participant:bob", "--to", "x2", "--by", "kamal"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("that participant is not in this review");
    const l = await loadReview(dir);
    expect(l.view.subjects.has("bob")).toBe(false);
    // an AI role has no subject, hence no released version for canView to find
    expect(
      canView({
        principal: "participant:bob",
        subject: "bob",
        state: "draft",
        versions: 0,
        view: "report",
        superseded: false,
        policyVersion: l.view.opened.policyVersion,
      }).allowed,
    ).toBe(false);
  });

  it('a released group exported for alice keeps "(AI player)" on every bob quote', async () => {
    await resolveAll();
    expect((await run(["release", rel, "--all", "--by", "kamal"])).code).toBe(0);
    const r = await run(["export", rel, "group", "--for", "participant:alice", "--to", "x3", "--by", "kamal"]);
    expect(r.code).toBe(0);
    const md = await readFile(path.join(root, "x3", "group.md"), "utf8");
    const lines = md.split("\n").filter((l) => l.includes(`line #${BOB_SEQ},`));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.includes("(AI player)"))).toBe(true);
    const json = JSON.parse(await readFile(path.join(root, "x3", "group.json"), "utf8"));
    expect(json.criteria[0].evidence[0].ai).toBe(true);
    expect(json.notable_moments[0].ai).toBe(true);
    expect(json.ai_players).toEqual({ roles: ["bob"], included_in_group: true });
  });

  it("the facilitator view of the group keeps ai: true on evidence", async () => {
    const l = await loadReview(dir);
    const { viewReport } = await import("../view.js");
    const r = viewReport(l.drafts.subjects.get("group")!.raw as never, l.view, "group", { audience: "facilitator" }) as unknown as {
      criteria: { evidence: { ai?: boolean }[] }[];
    };
    expect(r.criteria[0]!.evidence[0]!.ai).toBe(true);
  });
});

describe("validation of AI marks and ai_players", () => {
  it.each([
    ["names alice, a subject", { roles: ["alice"], included_in_group: true }],
    ['names "group"', { roles: ["group"], included_in_group: true }],
    ["has 13 roles", { roles: Array.from({ length: 13 }, (_, i) => `ai${i}`), included_in_group: true }],
    ["repeats a role", { roles: ["bob", "bob"], included_in_group: true }],
    ["has a non-boolean flag", { roles: ["bob"], included_in_group: "yes" }],
    ["has an unsafe role id", { roles: ["../x"], included_in_group: true }],
    ["is not an object", ["bob"]],
  ])("ai_players that %s is refused as corrupt", async (_n, value) => {
    await tamper((g) => {
      g.ai_players = value;
    });
    await expect(loadDrafts(dir)).rejects.toThrow("group.json: ai_players is invalid");
    expect((await run(["show", rel, "group"])).code).not.toBe(0);
  });

  it('an evidence "ai": "yes" is refused', async () => {
    await tamper((g) => {
      g.criteria[0].evidence[0].ai = "yes";
    });
    await expect(loadDrafts(dir)).rejects.toThrow(
      "group.json: an evidence item has an invalid AI mark",
    );
  });

  it('a notable moment with "ai": false is refused', async () => {
    await tamper((g) => {
      g.notable_moments[0].ai = false;
    });
    await expect(loadDrafts(dir)).rejects.toThrow(
      "group.json: an evidence item has an invalid AI mark",
    );
  });

  it("a pre-3c draft directory (no ai_players) still loads", async () => {
    await tamper((g) => {
      delete g.ai_players;
      for (const c of g.criteria) for (const e of c.evidence) delete e.ai;
      for (const m of g.notable_moments) delete m.ai;
    });
    const d = await loadDrafts(dir);
    expect(d.subjects.has("group")).toBe(true);
  });
});

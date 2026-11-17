import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { applyCommand, loadReview } from "../store.js";
import { makeDraftDir, makeRunner } from "./fixtures.js";
import { exportTarget, exportedMarkdown, exportedReport } from "../../moderation/write-b.js";
import { facilitatorReport } from "../../moderation/read.js";
import { renderSubjectMarkdown, viewReport } from "../view.js";
import { scrubDeep } from "../../demo/report.js";
import type { ParticipantReport } from "../../evaluator/report-model.js";

const CANARY = "CANARY-HIDDEN-7731";
let root: string, dir: string, rel: string, run: ReturnType<typeof makeRunner>;
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
  run = makeRunner(root);
  rel = path.relative(root, dir);
  expect((await run(["open", rel, "--by", "kamal"])).code).toBe(0);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const resolveAll = async (s: string) => {
  for (const c of (await loadReview(dir)).view.subjects
    .get(s)!
    .criteria.filter((x) => x.status === "needs_review"))
    await run(["accept", rel, s, c.id, "--by", "kamal"]);
  if ((await loadReview(dir)).view.subjects.get(s)!.summaryStale)
    await run(["accept", rel, s, "--summary", "--by", "kamal"]);
};
const respond = async (text: string, dispute = false) => {
  const r = await run([
    "respond", rel, "--role", "alice", "--text", text, "--by", "kamal",
    ...(dispute ? ["--dispute"] : []),
  ]);
  expect(r.code).toBe(0);
};
const hideSeq = (response: number) =>
  applyCommand(dir, () => 1_900_000_000_000, () => [
    {
      actor: { kind: "facilitator", by: "kamal" },
      body: { type: "response.hidden", response, reason: "off topic" },
    },
  ]);
const aliceResponses = async () =>
  (await loadReview(dir)).view.subjects.get("alice")!.responses;
const alice = async (): Promise<ParticipantReport> => {
  const l = await loadReview(dir);
  return viewReport(
    l.drafts.subjects.get("alice")!.raw as unknown as ParticipantReport,
    l.view,
    "alice",
    { audience: "released", line: "Visibility: you and the facilitator", legacy: false },
  ) as ParticipantReport;
};

describe("viewReport leaves a hidden response out", () => {
  it("the released audience carries no canary in the JSON or the Markdown, and still shows a visible response", async () => {
    await resolveAll("alice");
    await run(["release", rel, "alice", "--by", "kamal"]);
    await respond("a visible reply");
    await respond(CANARY);
    await hideSeq((await aliceResponses())[1]!.seq);
    const r = await alice();
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(renderSubjectMarkdown(r, [])).not.toContain(CANARY);
    expect(r.responses?.map((x) => x.text)).toEqual(["a visible reply"]);
  });

  it("the facilitator audience (CLI show, console read) carries no canary either", async () => {
    await resolveAll("alice");
    await run(["release", rel, "alice", "--by", "kamal"]);
    await respond("a visible reply");
    await respond(CANARY);
    await hideSeq((await aliceResponses())[1]!.seq);
    const shown = await run(["show", rel, "alice"]);
    expect(shown.out).toContain("a visible reply");
    expect(shown.out).not.toContain(CANARY);
    const f = await facilitatorReport(dir, "alice");
    expect(JSON.stringify(f.report)).not.toContain(CANARY);
  });

  it("hiding the only response leaves no responses key and still renders", async () => {
    await resolveAll("alice");
    await run(["release", rel, "alice", "--by", "kamal"]);
    await respond(CANARY);
    await hideSeq((await aliceResponses())[0]!.seq);
    const r = await alice();
    expect(r.responses).toBeUndefined();
    expect(() => renderSubjectMarkdown(r, [])).not.toThrow();
    expect(renderSubjectMarkdown(r, [])).not.toContain("Your responses");
  });

  it("the group report never carries responses", async () => {
    for (const s of ["alice", "bob", "group"]) await resolveAll(s);
    await run(["release", rel, "--all", "--by", "kamal"]);
    await respond(CANARY);
    await hideSeq((await aliceResponses())[0]!.seq);
    const l = await loadReview(dir);
    const g = viewReport(
      l.drafts.subjects.get("group")!.raw as never,
      l.view,
      "group",
      { audience: "released", line: "v", legacy: false },
    );
    expect(g.kind).toBe("group");
    expect("responses" in g).toBe(false);
  });
});

/** Release v1, a response with the canary (optionally hidden), amend, release v2. */
async function amendedFlow(hide: boolean): Promise<void> {
  await resolveAll("alice");
  await run(["release", rel, "alice", "--by", "kamal"]);
  await respond("a visible reply");
  await respond(CANARY);
  if (hide) await hideSeq((await aliceResponses())[1]!.seq);
  expect(
    (await run(["amend", rel, "alice", "--reason", "new evidence", "--by", "kamal"])).code,
  ).toBe(0);
  const cur = (await loadReview(dir)).view.subjects
    .get("alice")!
    .criteria.find((c) => c.id === "discovery")!.current;
  expect(
    (
      await run([
        "edit", rel, "alice", "discovery", "--level", cur === 2 ? "3" : "2",
        "--reason", "r", "--by", "kamal",
      ])
    ).code,
  ).toBe(0);
  await resolveAll("alice");
  expect((await run(["release", rel, "alice", "--by", "kamal"])).code).toBe(0);
  expect(
    (await loadReview(dir)).view.subjects.get("alice")!.versions,
  ).toHaveLength(2);
}

describe("a released snapshot after an amend (frozenView reads sv.responses)", () => {
  it("control: without the hide the facilitator export DOES contain the canary", async () => {
    await amendedFlow(false);
    const l = await loadReview(dir);
    const t = exportTarget("alice", "facilitator");
    expect(JSON.stringify(scrubDeep(exportedReport(t, l)))).toContain(CANARY);
    expect(exportedMarkdown(t, l, [])).toContain(CANARY);
  });

  it("the facilitator export (report, Markdown, written JSON and files) and CLI show carry no canary", async () => {
    await amendedFlow(true);
    const l = await loadReview(dir);
    const t = exportTarget("alice", "facilitator");
    const report = exportedReport(t, l);
    expect(JSON.stringify(scrubDeep(report))).not.toContain(CANARY);
    expect(exportedMarkdown(t, l, [])).not.toContain(CANARY);
    expect(exportedMarkdown(t, l, [])).toContain("a visible reply");
    const ex = await run(["export", rel, "alice", "--for", "facilitator", "--to", "o/f", "--by", "kamal"]);
    expect(ex.code).toBe(0);
    for (const f of ["alice.md", "alice.json"])
      expect(await readFile(path.join(root, "o/f", f), "utf8")).not.toContain(CANARY);
    expect((await run(["show", rel, "alice"])).out).not.toContain(CANARY);
  });

  it("the participant audience of v2 and its export carry no canary", async () => {
    await amendedFlow(true);
    const l = await loadReview(dir);
    const t = exportTarget("alice", "participant:alice");
    expect(JSON.stringify(exportedReport(t, l))).not.toContain(CANARY);
    expect(exportedMarkdown(t, l, [])).not.toContain(CANARY);
    expect(JSON.stringify(await alice())).not.toContain(CANARY);
  });
});

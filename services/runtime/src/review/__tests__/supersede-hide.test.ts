import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyCommand,
  loadReview,
  openReview,
  supersedeReview,
  type Loaded,
} from "../store.js";
import type { Body, Entry } from "../types.js";
import { fixedClock, makeDraftDir, resolveBodies } from "./fixtures.js";
import { writeReports } from "../../evaluator/report-write.js";
import { sampleEvaluation } from "../../evaluator/__tests__/fixtures.js";

const fac = { kind: "facilitator", by: "kamal" } as const;
const part = (role: string) =>
  ({ kind: "participant", role, attestedBy: "kamal" }) as const;
let root: string, dir1: string, dir2: string;
beforeEach(async () => {
  ({ root, dir: dir1 } = await makeDraftDir());
  const w = await writeReports(await sampleEvaluation(), {
    outDir: root,
    evaluator: {
      provider: "scripted mock",
      scripted: true,
      rubricHash: "h1",
      variant: "v1",
    },
  });
  dir2 = w.dir;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const apply = (dir: string, build: (l: Loaded) => Entry[]) =>
  applyCommand(dir, fixedClock(), build);
const fb = (body: Body): Entry => ({ actor: fac, body });
const release = (dir: string, subject: string) =>
  apply(dir, (l) => [
    ...resolveBodies(l.view, subject).map(fb),
    fb({ type: "report.released", subjects: [subject] }),
  ]);
const respond = (dir: string, role: string, text: string, dispute = false) =>
  apply(dir, () => [
    {
      actor: part(role),
      body: {
        type: "response.added",
        role,
        text,
        ...(dispute ? { dispute: true } : {}),
      },
    },
  ]);
const hide = (dir: string, response: number) =>
  apply(dir, () => [
    fb({ type: "response.hidden", response, reason: "off topic" }),
  ]);
const responsesOf = async (dir: string, role: string) =>
  (await loadReview(dir)).view.subjects.get(role)!.responses;

describe("supersede carries response.hidden", () => {
  it("a hidden response arrives hidden, pointed at the response's new seq, with the same reason and by", async () => {
    await openReview(dir1, { by: "kamal", now: fixedClock() });
    await release(dir1, "alice");
    await respond(dir1, "alice", "kept");
    await respond(dir1, "alice", "hidden one");
    const old = await responsesOf(dir1, "alice");
    await hide(dir1, old[1]!.seq);

    await supersedeReview(dir1, dir2, { by: "kamal", now: fixedClock() });
    const l2 = await loadReview(dir2);
    const rs = l2.view.subjects.get("alice")!.responses;
    expect(rs.map((r) => r.text)).toEqual(["kept", "hidden one"]);
    expect(rs[0]!.hidden).toBeNull();
    expect(rs[1]!.hidden).toMatchObject({ reason: "off topic", by: "kamal" });
    const ev = l2.events.find((e) => e.type === "response.hidden")!;
    expect(ev.carriedFrom).toBeDefined();
    expect((ev as { response: number }).response).toBe(rs[1]!.seq);
    expect(rs[1]!.seq).not.toBe(old[1]!.seq);
  });

  it("a hide whose response is not carried (criterion renamed in the re-run) is dropped with it, leaving no dangling response.hidden", async () => {
    await openReview(dir1, { by: "kamal", now: fixedClock() });
    await release(dir1, "alice");
    await respond(dir1, "alice", "GENERAL");
    await apply(dir1, () => [
      {
        actor: part("alice"),
        body: {
          type: "response.added",
          role: "alice",
          criterion: "listening",
          text: "ON-LISTENING",
        },
      },
    ]);
    const old = await responsesOf(dir1, "alice");
    await hide(dir1, old[0]!.seq);
    await hide(dir1, old[1]!.seq);
    const p = path.join(dir2, "alice.json");
    const j = JSON.parse(await readFile(p, "utf8"));
    for (const c of j.criteria)
      if (c.id === "listening") c.id = "active_listening";
    for (const o of j.learning_objectives)
      o.criteria = o.criteria.map((c: string) =>
        c === "listening" ? "active_listening" : c,
      );
    await writeFile(p, JSON.stringify(j, null, 2));

    const r = await supersedeReview(dir1, dir2, {
      by: "kamal",
      now: fixedClock(),
    });
    expect(r.notCarried.join("\n")).toMatch(
      /hidden response #\d+ by alice on listening/,
    );
    const l2 = await loadReview(dir2);
    const rs = l2.view.subjects.get("alice")!.responses;
    expect(rs.map((x) => x.text)).toEqual(["GENERAL"]);
    expect(rs[0]!.hidden).not.toBeNull();
    const hides = l2.events.filter((e) => e.type === "response.hidden");
    expect(hides).toHaveLength(1);
    expect((hides[0] as { response: number }).response).toBe(rs[0]!.seq);
  });

  it("a hidden open dispute of a player missing from the re-run is not announced as an open dispute", async () => {
    await openReview(dir1, { by: "kamal", now: fixedClock() });
    await release(dir1, "bob");
    await respond(dir1, "bob", "BOB-OPEN", true);
    const [d] = await responsesOf(dir1, "bob");
    await hide(dir1, d!.seq);
    await rm(path.join(dir2, "bob.json"));
    const r = await supersedeReview(dir1, dir2, {
      by: "kamal",
      now: fixedClock(),
    });
    expect(r.notCarried).toEqual([]);
  });
});

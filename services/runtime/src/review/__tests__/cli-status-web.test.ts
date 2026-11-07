import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { applyCommand, loadReview } from "../store.js";
import { statusLines } from "../cli.js";
import type { Actor, Body, Entry } from "../types.js";
import {
  fixedClock,
  makeDraftDir,
  makeRunner,
  resolveBodies,
} from "./fixtures.js";

let root: string, dir: string, run: ReturnType<typeof makeRunner>, rel: string;
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
  run = makeRunner(root);
  rel = path.relative(root, dir);
  await run(["open", rel, "--by", "kamal"]);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const fac: Actor = { kind: "facilitator", by: "kamal" };
const web = (role: string, credentialId: string): Actor => ({
  kind: "participant_session",
  v: 1,
  role,
  credentialId,
});
const LINK_A = "AAAAAAAAAAA"; // short id AAAAAAAA
const LINK_B = "BBBBBBBBBBA"; // short id BBBBBBBB
const apply = (build: (l: Awaited<ReturnType<typeof loadReview>>) => Entry[]) =>
  applyCommand(dir, fixedClock(), build);
const rate = (actor: Actor, criterion: string): Entry => ({
  actor,
  body: { type: "self.rated", role: "alice", criterion, level: 3 } as Body,
});
const aliceLine = async () =>
  (await run(["status", rel])).out
    .split("\n")
    .find((l) => l.startsWith("  alice: rated"))!;

describe("moderate status shows the web link behind a self-rating (AC-0383)", () => {
  it('status appends " via web link <ids>" (the distinct short ids) to "<id>: rated N of M criteria"', async () => {
    const crits = (await loadReview(dir)).view.subjects
      .get("alice")!
      .criteria.map((c) => c.id);
    await apply(() => [
      rate(web("alice", LINK_A), crits[0]!),
      rate(web("alice", LINK_B), crits[1]!),
      rate(web("alice", LINK_A), crits[2] ?? crits[0]!),
    ]);
    const line = await aliceLine();
    expect(line).toMatch(/^ {2}alice: rated \d+ of \d+ criteria via web link AAAAAAAA, BBBBBBBB$/);
    expect(line).not.toContain(LINK_A);
  });

  it('appends " via web link <id>" to an open dispute from a web link', async () => {
    await apply((l) => [
      ...resolveBodies(l.view, "alice").map((body) => ({ actor: fac, body })),
      { actor: fac, body: { type: "report.released", subjects: ["alice"] } },
      {
        actor: web("alice", LINK_A),
        body: { type: "response.added", role: "alice", text: "no", dispute: true },
      },
    ]);
    const out = (await run(["status", rel])).out;
    expect(out).toMatch(/^ {2}open dispute: #\d+ by alice via web link AAAAAAAA$/m);
  });

  it("leaves facilitator-attested lines unchanged", async () => {
    await apply(() => [
      {
        actor: { kind: "participant", role: "alice", attestedBy: "kamal" },
        body: { type: "self.rated", role: "alice", criterion: "listening", level: 2 },
      },
    ]);
    const line = await aliceLine();
    expect(line).toMatch(/^ {2}alice: rated 1 of \d+ criteria$/);
    expect(line).not.toContain("via web link");
  });

  it("does not throw for a web actor with a short id", async () => {
    await apply(() => [rate(web("alice", LINK_A), "listening")]);
    const l = await loadReview(dir);
    const c = l.view.subjects.get("alice")!.criteria.find((x) => x.id === "listening")!;
    c.self!.via = "abc"; // the fold only ever writes 8 characters; a shorter value must still print
    expect(() => statusLines(l)).not.toThrow();
    expect(statusLines(l).join("\n")).toContain("via web link abc");
  });
});

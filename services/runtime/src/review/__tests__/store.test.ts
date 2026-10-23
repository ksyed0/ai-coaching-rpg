import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyCommand,
  loadReview,
  openReview,
  readCodesRecord,
} from "../store.js";
import { JoinCodes } from "../../engine/join-codes.js";
import {
  writeJoinCodesFile,
  codesFileName,
} from "../../engine/join-code-file.js";
import { readReview, sealEntries, writeEvents } from "../review-log.js";
import { ReviewCorruptError, ReviewRefusedError } from "../errors.js";
import { makeDraftDir, fixedClock } from "./fixtures.js";

let root: string, dir: string;
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const fac = { kind: "facilitator", by: "kamal" } as const;

describe("openReview / loadReview", () => {
  it("opens once, records the file hashes and policy version, and refuses a second open", async () => {
    const l = await openReview(dir, { by: "kamal", now: fixedClock() });
    expect(l.events).toHaveLength(1);
    const o = l.view.opened;
    expect(o.policyVersion).toBe(1);
    expect(o.session.id).toBe("sess1");
    expect(Object.keys(o.files)).toContain("alice.json");
    await expect(
      openReview(dir, { by: "kamal", now: fixedClock() }),
    ).rejects.toBeInstanceOf(ReviewRefusedError);
  });
  it("refuses to load before open, with the next step in the message", async () => {
    await expect(loadReview(dir)).rejects.toThrow(/open/);
  });
  it("refuses everything when a draft file changed or disappeared after open, and ignores a new unrecorded file", async () => {
    await openReview(dir, { by: "kamal", now: fixedClock() });
    await writeFile(path.join(dir, "extra.json"), "{}");
    await expect(loadReview(dir)).resolves.toBeTruthy();
    const f = path.join(dir, "alice.md");
    await writeFile(f, (await readFile(f, "utf8")) + "tampered");
    await expect(loadReview(dir)).rejects.toThrow(/alice\.md/);
    await rm(f);
    await expect(loadReview(dir)).rejects.toBeInstanceOf(ReviewCorruptError);
  });
  it("turns a valid-chain but illegal sequence into a corrupt-review error", async () => {
    await openReview(dir, { by: "kamal", now: fixedClock() });
    const id = (await loadReview(dir)).view.subjects
      .get("alice")!
      .criteria.find((c) => c.status === "needs_review")!.id;
    const accept = {
      actor: fac,
      body: { type: "score.accepted", subject: "alice", criterion: id },
    } as const;
    await applyCommand(dir, fixedClock(), () => [accept]);
    const r = await readReview(dir);
    await writeEvents(
      dir,
      sealEntries(r.events, r.tailHash, [accept], fixedClock()),
    );
    await expect(loadReview(dir)).rejects.toBeInstanceOf(ReviewCorruptError);
  });
  it.each([
    ["files dropped", (o: any) => delete o.files],
    ["files null", (o: any) => (o.files = null)],
    ["files an array", (o: any) => (o.files = ["alice.md"])],
    ["a non-hex hash", (o: any) => (o.files["alice.md"] = "xyz")],
    ["an unsafe file name", (o: any) => (o.files["../x.md"] = "0".repeat(64))],
    ["a bad schema", (o: any) => (o.schema = "nope")],
    ["a bad session id", (o: any) => (o.session.id = "a/b")],
  ])("refuses a review.opened with %s as corrupt", async (_n, mutate) => {
    await openReview(dir, { by: "kamal", now: fixedClock() });
    const f = path.join(dir, "review.jsonl");
    const o = JSON.parse((await readFile(f, "utf8")).trim());
    mutate(o);
    await writeFile(f, JSON.stringify(o) + "\n");
    await expect(loadReview(dir)).rejects.toBeInstanceOf(ReviewCorruptError);
  });
});

describe("applyCommand", () => {
  beforeEach(async () => {
    await openReview(dir, { by: "kamal", now: fixedClock() });
  });
  it("appends valid entries in one step and returns the new view", async () => {
    const r = await applyCommand(dir, fixedClock(), () => [
      {
        actor: fac,
        body: {
          type: "comment.added",
          subject: "alice",
          text: "one",
          visibility: "internal",
        },
      },
      {
        actor: fac,
        body: {
          type: "comment.added",
          subject: "alice",
          text: "two",
          visibility: "internal",
        },
      },
    ]);
    expect(r.appended.map((e) => e.seq)).toEqual([2, 3]);
    expect((await readReview(dir)).events).toHaveLength(3);
    expect(
      (await loadReview(dir)).view.subjects.get("alice")!.comments,
    ).toHaveLength(2);
  });
  it("writes nothing when the new entries are illegal, and exits as a refusal", async () => {
    await expect(
      applyCommand(dir, fixedClock(), () => [
        {
          actor: fac,
          body: { type: "score.accepted", subject: "alice", criterion: "nope" },
        },
      ]),
    ).rejects.toBeInstanceOf(ReviewRefusedError);
    expect((await readReview(dir)).events).toHaveLength(1);
  });
  it("lets only one of two racing commands through; the loser is refused and the log stays valid", async () => {
    const id = (await loadReview(dir)).view.subjects
      .get("alice")!
      .criteria.find((c) => c.status === "needs_review")!.id;
    const accept = () =>
      applyCommand(dir, fixedClock(), () => [
        {
          actor: fac,
          body: { type: "score.accepted", subject: "alice", criterion: id },
        },
      ]);
    const results = await Promise.allSettled([accept(), accept()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
        .reason,
    ).toBeInstanceOf(ReviewRefusedError);
    expect((await loadReview(dir)).events).toHaveLength(2);
  });
  it("does nothing, and writes nothing, when build returns no entries", async () => {
    const r = await applyCommand(dir, fixedClock(), () => []);
    expect(r.appended).toEqual([]);
  });
});

describe("openReview with codes and a session log", () => {
  it("records the log hash and the scenario hash from the codes record", async () => {
    const { codes } = JoinCodes.issue(["r1"], {
      sessionId: "sess1",
      scenarioSha256: "a".repeat(64),
    });
    const l = await openReview(dir, {
      by: "kamal",
      now: fixedClock(),
      sessionLogText: "log",
      codes: codes.toRecord() as unknown as Record<string, unknown>,
    });
    expect(l.view.opened.session.logSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(l.view.opened.scenario.sha256).toBe("a".repeat(64));
  });
  it("allows exactly 10,000 events and refuses the 10,001st", async () => {
    await openReview(dir, { by: "kamal", now: fixedClock() });
    const c = () => ({
      actor: fac,
      body: {
        type: "comment.added" as const,
        subject: "alice",
        text: "x",
        visibility: "internal" as const,
      },
    });
    const r = await readReview(dir);
    await writeEvents(
      dir,
      sealEntries(
        r.events,
        r.tailHash,
        Array.from({ length: 9_998 }, c),
        fixedClock(),
      ),
    );
    await applyCommand(dir, fixedClock(), () => [c()]);
    expect((await readReview(dir)).events).toHaveLength(10_000);
    await expect(
      applyCommand(dir, fixedClock(), () => [c()]),
    ).rejects.toBeInstanceOf(ReviewRefusedError);
    expect((await readReview(dir)).events).toHaveLength(10_000);
  });
  it("refuses a bad --by, a foreign or hashless codes record", async () => {
    await expect(
      openReview(dir, { by: "a b", now: fixedClock() }),
    ).rejects.toBeInstanceOf(ReviewRefusedError);
    const mk = (sessionId: string, h: unknown) =>
      ({ sessionId, scenarioSha256: h }) as Record<string, unknown>;
    for (const codes of [
      mk("other", "a".repeat(64)),
      mk("sess1", "nothex"),
      mk("sess1", 5),
    ])
      await expect(
        openReview(dir, { by: "kamal", now: fixedClock(), codes }),
      ).rejects.toBeInstanceOf(ReviewRefusedError);
    expect((await readReview(dir)).events).toHaveLength(0);
  });
});

describe("applyCommand actors and sequences", () => {
  beforeEach(async () => {
    await openReview(dir, { by: "kamal", now: fixedClock() });
  });
  const cm = (actor: any) => [
    {
      actor,
      body: {
        type: "comment.added" as const,
        subject: "alice",
        text: "x",
        visibility: "internal" as const,
      },
    },
  ];
  it("refuses an unsafe facilitator or participant identity before writing", async () => {
    for (const actor of [
      { kind: "facilitator", by: "../x" },
      { kind: "facilitator", by: 5 },
      { kind: "participant", role: "A B", attestedBy: "kamal" },
      { kind: "participant", role: "alice", attestedBy: "" },
    ])
      await expect(
        applyCommand(dir, fixedClock(), () => cm(actor)),
      ).rejects.toBeInstanceOf(ReviewRefusedError);
    expect((await readReview(dir)).events).toHaveLength(1);
  });
  it("refuses a sequential second accept through the fold and leaves the file unchanged", async () => {
    const id = (await loadReview(dir)).view.subjects
      .get("alice")!
      .criteria.find((c) => c.status === "needs_review")!.id;
    const acc = () => [
      {
        actor: fac,
        body: { type: "score.accepted", subject: "alice", criterion: id },
      } as const,
    ];
    await applyCommand(dir, fixedClock(), acc);
    const before = await readFile(path.join(dir, "review.jsonl"), "utf8");
    await expect(applyCommand(dir, fixedClock(), acc)).rejects.toBeInstanceOf(
      ReviewRefusedError,
    );
    expect(await readFile(path.join(dir, "review.jsonl"), "utf8")).toBe(before);
  });
});

describe("readCodesRecord", () => {
  it("returns null when there is no file, the record when valid", async () => {
    expect(await readCodesRecord(root, "sess1")).toBeNull();
    const { codes } = JoinCodes.issue(["r1"], {
      sessionId: "sess1",
      scenarioSha256: "b".repeat(64),
    });
    writeJoinCodesFile(root, "sess1", codes);
    const rec = await readCodesRecord(root, "sess1");
    expect(rec?.sessionId).toBe("sess1");
  });
  it("refuses unreadable, non-JSON, invalid and foreign records", async () => {
    const f = path.join(root, codesFileName("sess1"));
    await writeFile(f, "not json");
    await expect(readCodesRecord(root, "sess1")).rejects.toBeInstanceOf(
      ReviewCorruptError,
    );
    await writeFile(f, "{}");
    await expect(readCodesRecord(root, "sess1")).rejects.toBeInstanceOf(
      ReviewCorruptError,
    );
    await rm(f);
    await symlink(path.join(root, "nowhere"), f);
    await expect(readCodesRecord(root, "sess1")).rejects.toBeInstanceOf(
      ReviewCorruptError,
    );
    await rm(f);
    const { codes } = JoinCodes.issue(["r1"], {
      sessionId: "other",
      scenarioSha256: "b".repeat(64),
    });
    writeJoinCodesFile(root, "other", codes);
    await writeFile(
      f,
      await readFile(path.join(root, codesFileName("other")), "utf8"),
    );
    await expect(readCodesRecord(root, "sess1")).rejects.toThrow(
      /another session/,
    );
  });
});

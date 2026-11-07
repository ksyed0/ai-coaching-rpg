import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withReviewLock } from "../../../runtime/src/review/review-log.js";
import { loadReview } from "../../../runtime/src/review/store.js";
import { makeFold } from "../../../runtime/src/review/__tests__/fixtures.js";
import { REVIEW_FILE } from "../../../runtime/src/review/types.js";
import {
  WRITE_BUSY, WRITE_CLOSED, WRITE_INVALID, WRITE_NOT_RELEASED, WRITE_OLD_SCHEMA, WRITE_THROTTLED, WRITE_TOO_MANY, WRITE_WITHDRAWN,
  createParticipantWriteService, warnIfReportsNotWritable, type WriteOutcome,
} from "../participant-writes.js";
import { makeReportWorld, type ReportWorld } from "./report-fixture.js";

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const MIN = 60_000;

let w: ReportWorld;
let sleeps: number[];
let logs: string[];
let rnd = 0.5;
const mk = (over: Partial<Parameters<typeof createParticipantWriteService>[0]> = {}) =>
  createParticipantWriteService({
    config: w.config, store: w.store, secrets: [], now: () => w.clock.t,
    sleep: async (ms) => { sleeps.push(ms); }, random: () => rnd, log: (m) => logs.push(m), ...over,
  });
const open = async (opts: Parameters<typeof makeReportWorld>[0] = {}) => {
  await w?.cleanup();
  w = await makeReportWorld(opts);
};
const crits = async (role = "alice") => (await loadReview(w.dir)).view.subjects.get(role)!.criteria.map((c) => c.id);
const events = async () => (await loadReview(w.dir)).events.filter((e) => e.type === "self.rated" || e.type === "response.added");
const cred = async (role = "alice") => (await w.store.issue(w.sessionId, role)).credential;
const NEUTRAL_404 = (o: WriteOutcome) => expect(o).toMatchObject({ status: 404, code: "not_found" });

beforeEach(() => { sleeps = []; logs = []; rnd = 0.5; });
afterEach(async () => { await w?.cleanup(); });

describe("credential and role", () => {
  it("the role is taken from the credential", async () => {
    await open({ release: false });
    const svc = mk();
    const a = await cred("alice");
    const b = await cred("bob");
    const [ca] = await crits("alice");
    const [cb] = await crits("bob");
    expect(await svc.rate(w.sessionId, a.id, [{ criterion: ca!, level: 3 }])).toEqual({ status: 200, wrote: 1 });
    expect(await svc.rate(w.sessionId, b.id, [{ criterion: cb!, level: 2 }])).toEqual({ status: 200, wrote: 1 });
    const ev = await events();
    expect(ev.map((e) => [e.type === "self.rated" ? e.role : "", e.actor.kind === "participant_session" ? e.actor.role : "", e.actor.kind === "participant_session" ? e.actor.credentialId : ""]))
      .toEqual([["alice", "alice", a.id], ["bob", "bob", b.id]]);
  });

  it("a refused, revoked, expired or other-session credential is the neutral 404 and writes nothing", async () => {
    await open({ release: false });
    const svc = mk();
    const [c] = await crits();
    const rating = [{ criterion: c!, level: 3 as const }];
    const before = (await events()).length;
    const msgs = new Set<string>();
    const note = (o: WriteOutcome) => { NEUTRAL_404(o); msgs.add((o as { message: string }).message); };
    note(await svc.rate(w.sessionId, "AAAAAAAAAAA", rating));         // unknown
    note(await svc.rate(w.sessionId, "../etc", rating));              // malformed
    const live = await cred("alice");
    note(await svc.rate("other-session", live.id, rating));           // other session
    await w.store.revoke(w.sessionId, "alice");
    note(await svc.rate(w.sessionId, live.id, rating));               // revoked
    const exp = await cred("bob");
    w.clock.t += 91 * 86_400_000;
    note(await svc.rate(w.sessionId, exp.id, rating));                // expired
    note(await svc.respond(w.sessionId, exp.id, { text: "hi" }));
    expect(msgs.size).toBe(1);
    const only = [...msgs][0]!;
    expect(only).not.toContain(live.id);
    expect(only).not.toContain(w.sessionId);
    expect((await events()).length).toBe(before);
    expect(logs).toEqual([]);
  });

  it("a store problem is 503 unavailable, never 404", async () => {
    await open({ release: false });
    const svc = mk();
    const c = await cred();
    const [k] = await crits();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(w.file, "not json");
    const r1 = await svc.rate(w.sessionId, c.id, [{ criterion: k!, level: 3 }]);
    const r2 = await svc.respond(w.sessionId, c.id, { text: "x" });
    expect(r1).toMatchObject({ status: 503, code: "unavailable" });
    expect(r2).toMatchObject({ status: 503, code: "unavailable" });
    expect(logs.length).toBe(1);
  });
});

describe("outcome mapping", () => {
  it("maps each runtime result to the status and fixed sentence in Spec 5.3", async () => {
    await open({ release: false });
    const svc = mk();
    const c = await cred("alice");
    const [k1, k2] = await crits();

    // ok
    expect(await svc.rate(w.sessionId, c.id, [{ criterion: k1!, level: 3 }])).toEqual({ status: 200, wrote: 1 });
    // invalid
    expect(await svc.rate(w.sessionId, c.id, [{ criterion: "nope", level: 3 }])).toEqual({ status: 400, code: "invalid", message: WRITE_INVALID });
    expect(await svc.rate(w.sessionId, c.id, [])).toEqual({ status: 400, code: "invalid", message: WRITE_INVALID });
    // response before release: not_released (runtime says not_released for a draft)
    expect(await svc.respond(w.sessionId, c.id, { text: "hi" })).toEqual({ status: 409, code: "not_released", message: WRITE_NOT_RELEASED });
    // too_many: the cap is 10 x criteria self.rated events
    const crit = (await crits()).length;
    let last: WriteOutcome = { status: 200, wrote: 0 };
    for (let i = 0; i < 10 * crit + 2 && last.status === 200; i++) {
      last = await svc.rate(w.sessionId, c.id, [{ criterion: k2!, level: ((i % 4) + 1) as 1 | 2 | 3 | 4 }]);
      w.clock.t += MIN; // stay under the 20-per-10-minutes throttle
    }
    expect(last).toEqual({ status: 409, code: "too_many", message: WRITE_TOO_MANY });

    // closed (released alice) and withdrawn
    await open();
    const svc2 = mk();
    const c2 = await cred("alice");
    const [r1] = await crits();
    expect(await svc2.rate(w.sessionId, c2.id, [{ criterion: r1!, level: 3 }])).toEqual({ status: 409, code: "closed", message: WRITE_CLOSED });
    expect(await svc2.respond(w.sessionId, c2.id, { text: "fair" })).toEqual({ status: 200, wrote: true });
    expect(await svc2.respond(w.sessionId, c2.id, { text: "" })).toEqual({ status: 400, code: "invalid", message: WRITE_INVALID });
    await w.run(["withdraw", w.rel, "alice", "--reason", "wrong", "--by", "kamal"]);
    expect(await svc2.respond(w.sessionId, c2.id, { text: "again" })).toEqual({ status: 409, code: "withdrawn", message: WRITE_WITHDRAWN });
  });

  it("an unknown review is 409 not_released, never 404, and the old_schema sentence is fixed", async () => {
    await open({ release: false });
    const svc = mk();
    const c = await cred("alice");
    const [k] = await crits();
    // The credential is live for this session id, but the reports folder has no review for it.
    await w.removeReports();
    expect(await svc.rate(w.sessionId, c.id, [{ criterion: k!, level: 3 }])).toEqual({ status: 409, code: "not_released", message: WRITE_NOT_RELEASED });
    expect(await svc.respond(w.sessionId, c.id, { text: "x" })).toEqual({ status: 409, code: "not_released", message: WRITE_NOT_RELEASED });
    expect(WRITE_OLD_SCHEMA).toBe("This review was opened before online ratings were available. Your facilitator can take your rating or response in the terminal.");
  });

  it("a review sealed as acr.review/1 answers 409 old_schema with the fixed sentence, for a rating and a response, and writes nothing", async () => {
    await open({ release: false });
    const svc = mk();
    const c = await cred("alice");
    const [k] = await crits();
    const l = await loadReview(w.dir);
    const sealed = makeFold(l.drafts, { schema: "acr.review/1" }).log();
    await writeFile(path.join(w.dir, REVIEW_FILE), sealed.map((e) => `${JSON.stringify(e)}\n`).join(""));
    const rated = await svc.rate(w.sessionId, c.id, [{ criterion: k!, level: 3 }]);
    expect(rated).toEqual({ status: 409, code: "old_schema", message: WRITE_OLD_SCHEMA });
    const responded = await svc.respond(w.sessionId, c.id, { text: "hello" });
    expect(responded).toEqual({ status: 409, code: "old_schema", message: WRITE_OLD_SCHEMA });
    expect((await events()).length).toBe(0);
  });

  it("no fixed sentence carries an id, a path or a role", () => {
    for (const s of [WRITE_CLOSED, WRITE_NOT_RELEASED, WRITE_WITHDRAWN, WRITE_TOO_MANY, WRITE_OLD_SCHEMA, WRITE_BUSY, WRITE_INVALID, WRITE_THROTTLED]) {
      expect(s.length).toBeGreaterThan(10);
      expect(s).not.toMatch(/alice|bob|\/|[A-Za-z0-9_-]{11}\./);
    }
  });
});

describe("lock retry", () => {
  it("busy retries 5 times with delays 100/200/400/800 ±25% and then answers busy", async () => {
    await open({ release: false });
    const [k] = await crits();
    const c = await cred();
    let attempts = 0;
    const real = w.store.checkResult.bind(w.store);
    w.store.checkResult = async (...a: Parameters<typeof real>) => { attempts++; return real(...a); };
    const out = await withReviewLock(w.dir, async () => {
      const lows = await mk({ random: () => 0 }).rate(w.sessionId, c.id, [{ criterion: k!, level: 3 }]);
      const lowSleeps = [...sleeps];
      sleeps = [];
      const highs = await mk({ random: () => 1 }).rate(w.sessionId, c.id, [{ criterion: k!, level: 3 }]);
      return { lows, lowSleeps, highs };
    });
    expect(out.lows).toEqual({ status: 503, code: "busy", message: WRITE_BUSY });
    expect(out.highs).toEqual({ status: 503, code: "busy", message: WRITE_BUSY });
    expect(out.lowSleeps).toEqual([75, 150, 300, 600]);
    expect(sleeps).toEqual([125, 250, 500, 1000]);
    expect(attempts).toBe(10);
    expect((await events()).length).toBe(0);
  });

  it("a lock released on attempt 3 then succeeds", async () => {
    await open({ release: false });
    const [k] = await crits();
    const c = await cred();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let lockDone!: Promise<unknown>;
    const started = new Promise<void>((r) => { lockDone = withReviewLock(w.dir, async () => { r(); await held; }); });
    await started;
    let n = 0;
    const svc = mk({ sleep: async (ms) => { sleeps.push(ms); n++; if (n === 2) { release(); await lockDone; } } });
    expect(await svc.rate(w.sessionId, c.id, [{ criterion: k!, level: 3 }])).toEqual({ status: 200, wrote: 1 });
    expect(sleeps).toEqual([100, 200]);
    expect((await events()).length).toBe(1);
  });

  it("a revoke between attempts writes nothing (no write attempt begins after revoke returns)", async () => {
    await open({ release: false });
    const [k] = await crits();
    const c = await cred();
    const svc = mk({ sleep: async (ms) => { sleeps.push(ms); await w.store.revoke(w.sessionId, "alice"); } });
    const out = await withReviewLock(w.dir, () => svc.rate(w.sessionId, c.id, [{ criterion: k!, level: 3 }]));
    NEUTRAL_404(out);
    expect(sleeps).toEqual([100]);
    expect((await events()).length).toBe(0);
  });

  it("a reissue between attempts writes nothing", async () => {
    await open({ release: false });
    const [k] = await crits();
    const c = await cred();
    const svc = mk({ sleep: async (ms) => { sleeps.push(ms); await w.store.reissue(w.sessionId, "alice"); } });
    const out = await withReviewLock(w.dir, () => svc.rate(w.sessionId, c.id, [{ criterion: k!, level: 3 }]));
    NEUTRAL_404(out);
    expect((await events()).length).toBe(0);
  });

  it("a concurrent moderate command leaves a valid chain", async () => {
    await open({ release: false });
    const [k] = await crits("alice");
    const [kb] = await crits("bob");
    const c = await cred();
    const svc = mk({ sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });
    const cli = (async () => {
      for (let i = 0; i < 4; i++) {
        for (let tries = 0; tries < 200; tries++) {
          const r = await w.run(["self-assess", w.rel, "--role", "bob", "--rate", `${kb}=${(i % 4) + 1}`, "--by", "kamal"]);
          if (r.code === 0) break;
          await new Promise((res) => setTimeout(res, 2));
        }
      }
    })();
    const web = (async () => {
      const outs: WriteOutcome[] = [];
      for (let i = 0; i < 4; i++) {
        // The CLI may hold the lock for all five attempts; the only other honest answer is busy, and then the player presses save again.
        let o: WriteOutcome;
        do { o = await svc.rate(w.sessionId, c.id, [{ criterion: k!, level: ((i % 4) + 1) as 1 | 2 | 3 | 4 }]); if (o.status !== 200) expect(o).toMatchObject({ status: 503, code: "busy" }); } while (o.status !== 200);
        outs.push(o);
      }
      return outs;
    })();
    const [, outs] = await Promise.all([cli, web]);
    for (const o of outs) expect(o.status).toBe(200);
    const l = await loadReview(w.dir); // verifies the hash chain; throws when broken
    expect(l.events.filter((e) => e.type === "self.rated" && e.role === "alice").length).toBe(4);
    expect(l.events.filter((e) => e.type === "self.rated" && e.role === "bob").length).toBe(4);
  });
});

describe("serialising and idempotence", () => {
  it("two identical responses submitted at the same moment give two 200 ok and exactly one event (Review Focus 2)", async () => {
    await open();
    const c = await cred();
    const svc = mk({ sleep: async () => { throw new Error("must not sleep: writes of one session are serialised before the lock"); } });
    const [a, b] = await Promise.all([svc.respond(w.sessionId, c.id, { text: "same" }), svc.respond(w.sessionId, c.id, { text: "same" })]);
    expect([a, b]).toEqual([{ status: 200, wrote: true }, { status: 200, wrote: false }]);
    expect((await events()).filter((e) => e.type === "response.added").length).toBe(1);
  });

  it("ten simultaneous writes from ten different roles all succeed (no cross-player lock collisions)", async () => {
    // The sample review has two players, so ten writes come from alice and bob (five each, each a different level).
    await open({ release: false });
    const svc = mk({ sleep: async () => { throw new Error("must not sleep"); } });
    const a = await cred("alice");
    const b = await cred("bob");
    const [ka] = await crits("alice");
    const [kb] = await crits("bob");
    const jobs: Promise<WriteOutcome>[] = [];
    for (let i = 0; i < 5; i++) {
      jobs.push(svc.rate(w.sessionId, a.id, [{ criterion: ka!, level: (i % 4) + 1 as 1 | 2 | 3 | 4 }]));
      jobs.push(svc.rate(w.sessionId, b.id, [{ criterion: kb!, level: (i % 4) + 1 as 1 | 2 | 3 | 4 }]));
    }
    const outs = await Promise.all(jobs);
    expect(outs.map((o) => o.status)).toEqual(Array(10).fill(200));
    expect((await events()).length).toBe(10);
  });
});

describe("throttle", () => {
  it("the 21st write in 10 minutes is 429 with retryAfterMs; the window slides", async () => {
    await open();
    const svc = mk();
    const c = await cred();
    const start = w.clock.t;
    for (let i = 0; i < 20; i++) {
      expect((await svc.respond(w.sessionId, c.id, { text: `r${i}` })).status).toBe(200);
      w.clock.t += 1000;
    }
    const over = await svc.respond(w.sessionId, c.id, { text: "r21" });
    expect(over).toEqual({ status: 429, code: "throttled", message: WRITE_THROTTLED, retryAfterMs: 10 * MIN - 20_000 });
    expect(start + 10 * MIN - w.clock.t).toBe(10 * MIN - 20_000);
    expect((await events()).length).toBe(20);
    w.clock.t = start + 10 * MIN; // the oldest write just left the window
    expect((await svc.respond(w.sessionId, c.id, { text: "r22" })).status).toBe(200);
    const again = await svc.respond(w.sessionId, c.id, { text: "r23" });
    expect(again.status).toBe(429);
    expect((again as { retryAfterMs: number }).retryAfterMs).toBe(1000);
  });

  it("refused and 4xx requests do not count; only requests past a live credential check count", async () => {
    await open({ release: false });
    const svc = mk();
    const c = await cred();
    const [k] = await crits();
    for (let i = 0; i < 30; i++) NEUTRAL_404(await svc.rate(w.sessionId, "AAAAAAAAAAA", [{ criterion: k!, level: 3 }]));
    for (let i = 0; i < 30; i++) expect((await svc.rate(w.sessionId, c.id, [{ criterion: "nope", level: 3 }])).status).toBe(400);
    for (let i = 0; i < 30; i++) expect((await svc.respond(w.sessionId, c.id, { text: "x" })).status).toBe(409);
    for (let i = 0; i < 20; i++) expect((await svc.rate(w.sessionId, c.id, [{ criterion: k!, level: ((i % 4) + 1) as 1 | 2 | 3 | 4 }])).status).toBe(200);
    expect((await svc.rate(w.sessionId, c.id, [{ criterion: k!, level: 3 }])).status).toBe(429);
    // a throttled credential that is then revoked is a 404, not a 429 (the credential check comes first)
    await w.store.revoke(w.sessionId, "alice");
    NEUTRAL_404(await svc.rate(w.sessionId, c.id, [{ criterion: k!, level: 3 }]));
  });

  it("the map is pruned", async () => {
    await open();
    const svc = mk();
    const a = await cred("alice");
    const b = await cred("bob");
    await svc.respond(w.sessionId, a.id, { text: "one" });
    await svc.respond(w.sessionId, b.id, { text: "one" });
    expect(svc.trackedCredentials()).toBe(2);
    w.clock.t += 11 * MIN;
    await svc.respond(w.sessionId, a.id, { text: "two" });
    expect(svc.trackedCredentials()).toBe(1);
  });
});

describe("an unwritable reports folder", () => {
  it.skipIf(isRoot)("answers 503 unavailable and logs one fixed line a minute", async () => {
    await open({ release: false });
    const svc = mk();
    const c = await cred();
    const [k] = await crits();
    chmodSync(w.dir, 0o500);
    try {
      const r1 = await svc.rate(w.sessionId, c.id, [{ criterion: k!, level: 3 }]);
      const r2 = await svc.rate(w.sessionId, c.id, [{ criterion: k!, level: 2 }]);
      expect(r1).toMatchObject({ status: 503, code: "unavailable" });
      expect(r2).toMatchObject({ status: 503, code: "unavailable" });
      expect(logs.length).toBe(1);
      expect(logs[0]).not.toContain(w.dir);
      w.clock.t += 61_000;
      await svc.rate(w.sessionId, c.id, [{ criterion: k!, level: 4 }]);
      expect(logs.length).toBe(2);
      expect(logs[1]).toBe(logs[0]);
    } finally { chmodSync(w.dir, 0o700); }
  });
});

describe("warnIfReportsNotWritable", () => {
  it("logs nothing for a directory that does not exist yet (a fresh deploy)", async () => {
    const lines: string[] = [];
    await warnIfReportsNotWritable(path.join(tmpdir(), "acr-ctl-never-created", "reports"), (m) => lines.push(m));
    expect(lines).toEqual([]);
  });
  it.skipIf(isRoot)("logs one fixed line for a read-only dir and nothing for a writable one", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "acr-ctl-ro-"));
    const lines: string[] = [];
    try {
      await warnIfReportsNotWritable(dir, (m) => lines.push(m));
      expect(lines).toEqual([]);
      chmodSync(dir, 0o500);
      await warnIfReportsNotWritable(dir, (m) => lines.push(m));
      expect(lines.length).toBe(1);
      expect(lines[0]).not.toContain(dir);
      await warnIfReportsNotWritable(path.join(dir, "missing"), (m) => lines.push(m)); // missing: quiet, even under a read-only parent
      expect(lines.length).toBe(1);
    } finally { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); }
  });
  it("never throws, even when the logger does", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "acr-ctl-ro-"));
    try {
      if (!isRoot) chmodSync(dir, 0o500);
      await expect(warnIfReportsNotWritable(dir, () => { throw new Error("boom"); })).resolves.toBeUndefined();
    } finally { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); }
  });
});

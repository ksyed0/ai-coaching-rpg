import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadScenario, type Scenario } from "@acr/script";
import { FakeClock } from "../clock.js";
import { SessionStoreError, openSession, type OpenedSession } from "../session-store.js";

// Seam: records which seat files still exist at the moment the old log is moved aside (crash-safety ordering).
const hooks = vi.hoisted(() => ({ onRotate: null as null | (() => void) }));
vi.mock("../log-files.js", async (orig) => {
  const actual = await orig<typeof import("../log-files.js")>();
  return { ...actual, rotateStaleLog: (...a: Parameters<typeof actual.rotateStaleLog>) => { hooks.onRotate?.(); return actual.rotateStaleLog(...a); } };
});

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
const T0 = 2_000_000;
const V1 = { version: "v1", text: "Notice one." };
const V2 = { version: "v2", text: "Notice two." };
let scenario: Scenario;
let dir: string;
const open: OpenedSession[] = [];
beforeEach(async () => { scenario = await loadScenario(fixture); dir = await mkdtemp(path.join(os.tmpdir(), "acr-seats-")); });
afterEach(async () => { hooks.onRotate = null; for (const o of open.splice(0)) await o.close(); await rm(dir, { recursive: true, force: true }); });
const now = () => new Date("2031-02-03T04:05:06Z");
const openIt = async (mode: "resume" | "fresh", notice = V1) => {
  const o = await openSession({ scenario, sessionId: "s", dataDir: dir, clock: new FakeClock(T0), mode, now, joinCodes: true, consentNotice: notice });
  open.push(o);
  return o;
};
const crash = async (o: OpenedSession) => { o.lock.abandon(); await o.log.close(); open.splice(open.indexOf(o), 1); };
const credFile = () => path.join(dir, "s.credentials.json");
const consentFile = () => path.join(dir, "s.consent.json");
const readJson = async (f: string) => JSON.parse(await readFile(f, "utf8")) as Record<string, unknown>;
/** A running session with one seated, consenting player; returns the plain credential. */
const seatHost = async (o: OpenedSession) => {
  await o.engine.start({ host: "p" });
  const plain = o.seats!.credentials.issue("host", "Pat");
  o.seats!.consent.give("host", "p", o.seats!.consent.notice.version, T0);
  o.seats!.persist();
  return plain;
};
const snapshot = async () => {
  const out: Record<string, string> = {};
  for (const n of (await readdir(dir)).sort()) if (n !== "s.lock") out[n] = await readFile(path.join(dir, n), "utf8");
  return out;
};

describe("openSession with seats (US-0053)", () => {
  it("a new session creates credentials and consent files with a log identity", async () => {
    const o = await openIt("resume");
    expect(o.outcome).toBe("new");
    expect(o.seats!.credentials.logIdentity).toMatch(/^[0-9a-f]{32}$/);
    expect(o.seats!.consent.notice).toEqual(V1);
    const cred = await readJson(credFile());
    expect(cred).toMatchObject({ v: 1, sessionId: "s", logIdentity: o.seats!.credentials.logIdentity, roles: {} });
    expect(await readJson(consentFile())).toMatchObject({ v: 1, sessionId: "s", entries: {} });
    for (const f of [credFile(), consentFile()]) expect((await stat(f)).mode & 0o777).toBe(0o600);
  });

  it("resume keeps credentials and consent that match the scenario and notice version", async () => {
    const a = await openIt("resume");
    const plain = await seatHost(a);
    const id = a.seats!.credentials.logIdentity;
    await crash(a);
    const b = await openIt("resume");
    expect(b.outcome).toBe("resumed");
    expect(b.joinCodes!.issued).toBeNull();
    expect(b.seats!.credentials.logIdentity).toBe(id);
    expect(b.seats!.credentials.verify("host", plain)).toBe(true);
    expect(b.seats!.credentials.nameOf("host")).toBe("Pat");
    expect(b.seats!.consent.has("host", "p")).toBe(true);
  });

  it("a start that finds an empty log and issues new codes discards credentials and consent", async () => {
    const a = await openIt("resume");
    const plain = a.seats!.credentials.issue("host", "Pat");
    a.seats!.consent.give("host", "p", "v1", T0);
    a.seats!.persist();
    const id = a.seats!.credentials.logIdentity;
    await crash(a); // nothing was ever appended: the log is empty
    const b = await openIt("resume");
    expect(b.outcome).toBe("new");
    expect(b.joinCodes!.issued).not.toBeNull();
    expect(b.seats!.credentials.logIdentity).not.toBe(id);
    expect(b.seats!.credentials.verify("host", plain)).toBe(false);
    expect(b.seats!.consent.has("host", "p")).toBe(false);
    expect((await readJson(credFile())).roles).toEqual({});
    expect((await readJson(consentFile())).entries).toEqual({});
  });

  it("a fresh start and an ended-session rotation remove both files before the new session opens", async () => {
    const seen: boolean[][] = [];
    hooks.onRotate = () => { seen.push([existsSync(credFile()), existsSync(consentFile())]); };
    // fresh
    const a = await openIt("resume");
    const plainA = await seatHost(a);
    await a.close(); open.pop();
    const b = await openIt("fresh");
    expect(b.outcome).toBe("rotated");
    expect(b.seats!.credentials.verify("host", plainA)).toBe(false);
    expect(b.seats!.consent.has("host", "p")).toBe(false);
    // ended
    const plainB = await seatHost(b);
    await b.engine.command({ command: "advance" }); await b.engine.tick();
    await b.engine.command({ command: "advance" }); await b.engine.tick();
    expect(b.engine.state.status).toBe("ended");
    await b.close(); open.pop();
    const c = await openIt("resume");
    expect(c).toMatchObject({ outcome: "rotated", rotatedBecause: "ended" });
    expect(c.seats!.credentials.verify("host", plainB)).toBe(false);
    expect(c.seats!.consent.has("host", "p")).toBe(false);
    expect(seen).toEqual([[false, false], [false, false]]); // gone before each log moved
    expect(existsSync(credFile()) && existsSync(consentFile())).toBe(true); // and new ones written after
  });

  it("consent under another notice version is dropped on resume", async () => {
    const a = await openIt("resume");
    const plain = await seatHost(a);
    await crash(a);
    const b = await openIt("resume", V2);
    expect(b.outcome).toBe("resumed");
    expect(b.seats!.consent.notice).toEqual(V2);
    expect(b.seats!.consent.has("host", "p")).toBe(false);
    expect(b.seats!.credentials.verify("host", plain)).toBe(true); // the credentials stay
  });

  it("a missing credentials file on a resume takes the log identity from session.started and creates a new file", async () => {
    const a = await openIt("resume");
    await seatHost(a);
    await crash(a);
    await rm(credFile());
    const identity = "0123456789abcdef0123456789abcdef";
    const lines = (await readFile(path.join(dir, "s.jsonl"), "utf8")).split("\n");
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), logIdentity: identity });
    await writeFile(path.join(dir, "s.jsonl"), lines.join("\n"));
    const b = await openIt("resume");
    expect(b.outcome).toBe("resumed");
    expect(b.seats!.credentials.logIdentity).toBe(identity);
    expect(b.seats!.credentials.has("host")).toBe(false);
    expect((await readJson(credFile())).logIdentity).toBe(identity);
    expect(b.notes.some((n) => /credentials/.test(n))).toBe(true);
  });

  it("a missing credentials file on a resume of a log without a log identity gets a new identity", async () => {
    const a = await openIt("resume");
    await seatHost(a);
    const id = a.seats!.credentials.logIdentity;
    await crash(a);
    await rm(credFile());
    const b = await openIt("resume");
    expect(b.outcome).toBe("resumed");
    expect(b.seats!.credentials.logIdentity).toMatch(/^[0-9a-f]{32}$/);
    expect(b.seats!.credentials.logIdentity).not.toBe(id);
    expect(existsSync(credFile())).toBe(true);
  });

  it("a credentials file with an extra key makes openSession fail with SessionStoreError and changes nothing", async () => {
    const secret = "SECRET-CONTENT-7f3a";
    const breakers: [string, () => Promise<void>][] = [
      ["extra key", async () => { const r = await readJson(credFile()); await writeFile(credFile(), JSON.stringify({ ...r, extra: secret }), { mode: 0o600 }); }],
      ["bad JSON", async () => { await writeFile(credFile(), `{"${secret}"`, { mode: 0o600 }); }],
      ["consent bound to another session", async () => { const r = await readJson(consentFile()); await writeFile(consentFile(), JSON.stringify({ ...r, sessionId: secret }), { mode: 0o600 }); }],
    ];
    for (const [what, breakIt] of breakers) {
      const a = await openIt("fresh");
      await seatHost(a);
      await crash(a);
      await breakIt();
      const before = await snapshot();
      const err = await openIt("resume").then(() => null, (e: unknown) => e);
      expect(err, what).toBeInstanceOf(SessionStoreError);
      expect((err as SessionStoreError).code, what).toBe("seats");
      expect((err as Error).message, what).not.toContain(secret);
      expect(await snapshot(), what).toEqual(before);
      expect(existsSync(path.join(dir, "s.lock")), what).toBe(false); // released
    }
  });

  it("persist refuses when the lock was lost", async () => {
    const o = await openIt("resume");
    await o.engine.start({ host: "p" });
    const before = await snapshot();
    await rm(path.join(dir, "s.lock"));
    o.seats!.credentials.issue("host", "Pat");
    expect(() => o.seats!.persist()).toThrow();
    const after = await snapshot();
    expect(after["s.credentials.json"]).toBe(before["s.credentials.json"]);
    expect(Object.keys(after).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("leftover temp files of both files are swept at open", async () => {
    await writeFile(path.join(dir, "s.credentials.json.0123456789ab.tmp"), "x", { mode: 0o600 });
    await writeFile(path.join(dir, "s.consent.json.ba9876543210.tmp"), "x", { mode: 0o600 });
    await openIt("resume");
    expect((await readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("discardIssuedCodes also removes the seat files this start created, never kept ones", async () => {
    const a = await openIt("resume");
    expect(a.discardIssuedCodes()).toBe(true);
    expect(existsSync(credFile()) || existsSync(consentFile())).toBe(false);
    await a.close(); open.pop();
    const b = await openIt("resume");
    await seatHost(b);
    await crash(b);
    const c = await openIt("resume");
    expect(c.outcome).toBe("resumed");
    expect(c.discardIssuedCodes()).toBe(true);
    expect(existsSync(credFile()) && existsSync(consentFile())).toBe(true);
  });

  it("without a consent notice no seats are managed and no seat files are written (regression guard)", async () => {
    const o = await openSession({ scenario, sessionId: "s", dataDir: dir, clock: new FakeClock(T0), mode: "resume", now, joinCodes: true });
    open.push(o);
    expect(o.seats).toBeUndefined();
    expect(existsSync(credFile()) || existsSync(consentFile())).toBe(false);
  });
});

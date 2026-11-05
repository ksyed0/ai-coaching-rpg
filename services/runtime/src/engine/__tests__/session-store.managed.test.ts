import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadScenario, type Scenario } from "@acr/script";
import { FakeClock } from "../clock.js";
import { SessionStoreError, openSession, type OpenedSession } from "../session-store.js";
import { readJoinCodesFile } from "../join-code-file.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
const T0 = 2_000_000;
const V1 = { version: "v1", text: "Notice one." };
let scenario: Scenario;
let dir: string;
const open: OpenedSession[] = [];
beforeEach(async () => { scenario = await loadScenario(fixture); dir = await mkdtemp(path.join(os.tmpdir(), "acr-managed-")); });
afterEach(async () => { for (const o of open.splice(0)) await o.close(); await rm(dir, { recursive: true, force: true }); });
const now = () => new Date("2031-02-03T04:05:06Z");
const openIt = async (managed: boolean, sc: Scenario = scenario) => {
  const o = await openSession({ scenario: sc, sessionId: "s", dataDir: dir, clock: new FakeClock(T0), mode: "resume", now, joinCodes: true, consentNotice: V1, managed });
  open.push(o);
  return o;
};
const crash = async (o: OpenedSession) => { o.lock.abandon(); await o.log.close(); open.splice(open.indexOf(o), 1); };
const logFile = () => path.join(dir, "s.jsonl");
/** A lobby: codes issued, one player seated and consenting, and nothing yet in the log. */
const lobby = async (managed: boolean) => {
  const a = await openIt(managed);
  const plain = a.seats!.credentials.issue("host", "Pat");
  a.seats!.consent.give("host", "p", "v1", T0);
  a.seats!.persist();
  return { a, plain, codes: a.joinCodes!.issued!, identity: a.seats!.credentials.logIdentity };
};
const endSession = async (o: OpenedSession) => {
  await o.engine.start({ host: "p" });
  await o.engine.command({ command: "advance" }); await o.engine.tick();
  await o.engine.command({ command: "advance" }); await o.engine.tick();
  expect(o.engine.state.status).toBe("ended");
};

describe("openSession managed mode (US-0058)", () => {
  it("managed: a restart on an empty log keeps the issued codes, the credentials and the consent", async () => {
    const { a, plain, codes, identity } = await lobby(true);
    await crash(a);
    const b = await openIt(true);
    expect(b.outcome).toBe("new");
    expect(b.joinCodes!.issued).toBeNull(); // kept: nothing to show again
    for (const [role, code] of Object.entries(codes)) expect(b.joinCodes!.codes.verify(role, code)).toBe(true);
    expect(b.seats!.credentials.logIdentity).toBe(identity);
    expect(b.seats!.credentials.verify("host", plain)).toBe(true);
    expect(b.seats!.credentials.nameOf("host")).toBe("Pat");
    expect(b.seats!.consent.has("host", "p")).toBe(true);
  });

  it("managed: codes bound to another scenario give new codes and empty seats, and a new code can join", async () => {
    const other: Scenario = { ...scenario, meta: { ...scenario.meta, title: `${scenario.meta.title} (changed)` } };
    const { a, plain, codes } = await lobby(true);
    await a.close(); open.pop();
    // Only the CODES file is swapped for one issued under another scenario; the credentials still fit this scenario. This is the case
    // where settleCodes removes the seats from disk and issues new codes: keeping the `found` seats then would strand every player.
    const otherDir = await mkdtemp(path.join(os.tmpdir(), "acr-managed-other-"));
    try {
      const o = await openSession({ scenario: other, sessionId: "s", dataDir: otherDir, clock: new FakeClock(T0), mode: "resume", now, joinCodes: true, consentNotice: V1, managed: true });
      await o.close();
      await copyFile(path.join(otherDir, "s.codes.json"), path.join(dir, "s.codes.json"));
    } finally { await rm(otherDir, { recursive: true, force: true }); }
    const b = await openIt(true);
    expect(b.joinCodes!.issued).not.toBeNull();
    expect(b.joinCodes!.issued).not.toEqual(codes);
    expect(b.seats!.credentials.verify("host", plain)).toBe(false);
    expect(b.seats!.credentials.nameOf("host")).toBeUndefined();
    expect(b.seats!.consent.has("host", "p")).toBe(false);
    // What a server restarted from disk would check: the new code opens the role, the old one does not.
    const onDisk = readJoinCodesFile(dir, "s")!;
    for (const [role, code] of Object.entries(b.joinCodes!.issued!)) expect(onDisk.verify(role, code)).toBe(true);
    expect(onDisk.verify("host", codes.host)).toBe(false);
    // The seats are empty on disk too (no stale credential survives beside the new codes), and a new player can take the seat.
    const credOnDisk = JSON.parse(await readFile(path.join(dir, "s.credentials.json"), "utf8")) as { roles: Record<string, unknown> };
    expect(credOnDisk.roles).toEqual({});
    expect(b.seats!.credentials.issue("host", "Quinn")).toMatch(/\S/);
    expect(b.seats!.credentials.nameOf("host")).toBe("Quinn");
  });

  it("managed: an ended log is refused and the log file is not renamed", async () => {
    const a = await openIt(true);
    await endSession(a);
    const before = await readFile(logFile());
    const names = (await readdir(dir)).filter((n) => n !== "s.lock").sort();
    await a.close(); open.pop();
    const err = await openIt(true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionStoreError);
    expect(err).toMatchObject({ code: "resume_refused", message: "the session has ended" });
    expect((await readdir(dir)).filter((n) => n !== "s.lock").sort()).toEqual(names); // nothing renamed, nothing removed
    expect((await readFile(logFile())).equals(before)).toBe(true);
  });

  it("unmanaged behaviour is unchanged (empty log still discards, ended still rotates)", async () => {
    const { a, plain, identity } = await lobby(false);
    await crash(a);
    const b = await openIt(false);
    expect(b.joinCodes!.issued).not.toBeNull();
    expect(b.seats!.credentials.logIdentity).not.toBe(identity);
    expect(b.seats!.credentials.verify("host", plain)).toBe(false);
    expect(b.seats!.consent.has("host", "p")).toBe(false);
    await endSession(b);
    const before = await readFile(logFile());
    await b.close(); open.pop();
    const c = await openIt(false);
    expect(c).toMatchObject({ outcome: "rotated", rotatedBecause: "ended" });
    expect(path.basename(c.rotatedTo!)).toBe("s.20310203T040506Z.jsonl");
    expect((await readFile(c.rotatedTo!)).equals(before)).toBe(true);
  });
});

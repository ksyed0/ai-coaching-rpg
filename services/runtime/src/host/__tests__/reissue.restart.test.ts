import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockModelProvider } from "@acr/adapters";
import { loadScenario, type Scenario } from "@acr/script";
import { FakeClock } from "../../engine/clock.js";
import type { JoinCodes } from "../../engine/join-codes.js";
import { SessionStoreError, openSession, type OpenedSession } from "../../engine/session-store.js";
import { HostError, SessionHost } from "../session-host.js";
import { reissueRole } from "../reissue.js";

// The WATCH item of task 9: a restart after a post-start reissue and before the replacement joins must keep the seat claimable.
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
const SESSION = "s";
let scenario: Scenario;
let dir: string;
const open: OpenedSession[] = [];
beforeEach(async () => { scenario = await loadScenario(fixture); dir = await mkdtemp(path.join(os.tmpdir(), "acr-reissue-")); });
afterEach(async () => { for (const o of open.splice(0)) await o.close(); await rm(dir, { recursive: true, force: true }); });

const openIt = async (noticeVersion: string) => {
  const o = await openSession({ scenario, sessionId: SESSION, dataDir: dir, clock: new FakeClock(1_000), mode: "resume", joinCodes: true, consentNotice: { version: noticeVersion, text: `notice ${noticeVersion}` }, managed: true });
  open.push(o);
  return o;
};
const hostFor = (o: OpenedSession) => new SessionHost({ scenario, engine: o.engine, npcProvider: new MockModelProvider(["hi"]), gmProvider: new MockModelProvider(), clock: new FakeClock(1_000), seats: o.seats });
const code = (f: () => unknown): string | undefined => { try { f(); } catch (err) { return err instanceof HostError ? err.code : String(err); } return undefined; };
const close = async (o: OpenedSession) => { await o.close(); open.splice(open.indexOf(o), 1); };

/** First life: alice seated and consenting, the session started, then a reissue of the only role; the process then ends. */
async function reissueAndStop(version: string) {
  const a = await openIt(version);
  const h = hostFor(a);
  h.join("host", "alice");
  a.seats!.credentials.issue("host", "Pat");
  a.seats!.persist();
  h.giveConsent("host", "alice", version);
  await h.start();
  let current: JoinCodes = a.joinCodes!.codes;
  const plain = await reissueRole({
    host: h, seats: a.seats!, sessionId: SESSION, server: { kickRole: () => {} },
    codes: () => current, setCodes: (c) => { current = c; }, writeCodes: (c) => a.writeJoinCodes(c),
  }, "host", "Kim");
  await close(a);
  return plain;
}

describe("a restart after a post-start reissue (US-0058, WATCH item)", () => {
  it("a restart after a post-start reissue and before the replacement joins still lets the next joiner claim the seat", async () => {
    const plain = await reissueAndStop("v1");
    const b = await openIt("v1");
    expect(b.outcome).toBe("resumed");
    expect(b.seats!.consent.isRebindPending("host")).toBe(true); // the log's participant did not overwrite the marker
    expect(b.seats!.credentials.has("host")).toBe(false);
    expect(b.joinCodes!.codes.verify("host", plain)).toBe(true); // the new code survived too
    const h = hostFor(b);
    h.resumeFrom(b.resume!);
    expect(b.seats!.consent.isRebindPending("host")).toBe(true);
    expect(code(() => h.join("host", "bob"))).toBeUndefined();
    expect(b.seats!.consent.has("host", "bob")).toBe(true);
    expect(code(() => h.join("host", "alice"))).toBe("consent_required"); // alice (the logged participant) is no longer the consenting one
  });

  it("the same holds when the restart runs under a newer notice version", async () => {
    const plain = await reissueAndStop("v1");
    const b = await openIt("v2");
    const h = hostFor(b);
    h.resumeFrom(b.resume!);
    expect(b.joinCodes!.codes.verify("host", plain)).toBe(true);
    expect(b.seats!.consent.isRebindPending("host")).toBe(true);
    expect(code(() => h.join("host", "bob"))).toBeUndefined();
    expect(b.seats!.consent.snapshot().host?.noticeVersion).toBe("v1"); // what the person was shown is what is recorded
  });

  it("OpenedSession.writeJoinCodes throws SessionStoreError with a fixed message that names no path when the lock is lost", async () => {
    const a = await openIt("v1");
    const codes = a.joinCodes!.codes;
    a.lock.abandon();
    let err: unknown;
    try { a.writeJoinCodes(codes); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SessionStoreError);
    expect((err as SessionStoreError).code).toBe("lock");
    expect((err as Error).message).not.toContain(dir);
    vi.restoreAllMocks();
  });
});

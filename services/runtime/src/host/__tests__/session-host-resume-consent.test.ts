import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MockModelProvider } from "@acr/adapters";
import { loadScenario } from "@acr/script";
import { FakeClock } from "../../engine/clock.js";
import { ConsentStore } from "../../engine/consent.js";
import { PlayerCredentials } from "../../engine/credentials.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import type { Seats } from "../../engine/seats.js";
import { SessionEngine } from "../../engine/session-engine.js";
import { HostError, SessionHost } from "../session-host.js";

// R14: a resumed session counts as started, so a rejoin is checked against the consent the log recorded at the start.
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
const BIND = { sessionId: "s", scenarioSha256: "d".repeat(64) };
const NOTICE = { version: "v1", text: "notice" };
const newSeats = (): Seats => ({ credentials: PlayerCredentials.create(BIND), consent: new ConsentStore(NOTICE), persist: vi.fn() });
const code = (f: () => unknown): string | undefined => { try { f(); } catch (err) { return err instanceof HostError ? err.code : String(err); } return undefined; };

/** First life (with or without seats), then a restart on the same log with `second` seats (a lost or kept consent file). */
async function restart(o: { firstSeats: boolean; secondSeats?: Seats }) {
  const scenario = await loadScenario(fixture);
  const log = new MemoryEventLog("s");
  const clock = new FakeClock(1_000);
  const first = o.firstSeats ? newSeats() : undefined;
  const e1 = new SessionEngine({ scenario, log, clock });
  const h1 = new SessionHost({ scenario, engine: e1, npcProvider: new MockModelProvider(["hi"]), gmProvider: new MockModelProvider(), clock, seats: first });
  h1.join("host", "alice");
  if (first) h1.giveConsent("host", "alice", "v1");
  await h1.start();
  await h1.idle();
  const seats = o.secondSeats ?? newSeats();
  const engine = new SessionEngine({ scenario, log, clock });
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["hi"]), gmProvider: new MockModelProvider(), clock, seats });
  const out = await engine.restore();
  if (out.kind !== "running") throw new Error(`expected a running session, got ${out.kind}`);
  await engine.markResumed(out.info);
  host.resumeFrom(out.info);
  return { host, seats, info: out.info };
}

describe("resume and consent (US-0054, R14)", () => {
  it("consent file lost, log has consents: the same participant rejoins", async () => {
    const { host, seats } = await restart({ firstSeats: true });
    expect(code(() => host.join("host", "alice"))).toBeUndefined();
    expect(seats.consent.has("host", "alice")).toBe(true);
  });
  it("a different participant is refused consent_required when the log has consents", async () => {
    const { host } = await restart({ firstSeats: true });
    expect(code(() => host.join("host", "mallory"))).toBe("consent_required");
  });
  it("the file's own entry wins over the log's: the log only fills what is missing", async () => {
    const kept = newSeats();
    kept.consent.give("host", "bob", "v1", 5);
    const { host } = await restart({ firstSeats: true, secondSeats: kept });
    expect(code(() => host.join("host", "bob"))).toBeUndefined();
    expect(code(() => host.join("host", "alice"))).toBe("consent_required"); // the file says bob; the log's alice does not replace him
  });
  it("log without a consents field (older format): anyone with the code can rejoin", async () => {
    const { host, info } = await restart({ firstSeats: false });
    expect(info.startedConsents).toBeUndefined();
    expect(code(() => host.join("host", "whoever"))).toBeUndefined();
  });
  it("v1 -> v2 resume: the log's record is history, so the same participant rejoins and a different one is refused", async () => {
    const other: Seats = { credentials: PlayerCredentials.create(BIND), consent: new ConsentStore({ version: "v2", text: "new" }), persist: vi.fn() };
    const { host } = await restart({ firstSeats: true, secondSeats: other });
    expect(host.consentGiven("host", "alice")).toBe(true);
    expect(code(() => host.join("host", "mallory"))).toBe("consent_required");
    expect(code(() => host.join("host", "alice"))).toBeUndefined();
  });
  it("a consent file entry under an old version is still dropped before the start (not adopted)", () => {
    const store = ConsentStore.fromRecord({ v: 1, ...BIND, entries: { host: { participantId: "alice", noticeVersion: "v1", at: 1 } } }, { version: "v2", text: "n" }, BIND);
    expect(store.has("host", "alice")).toBe(false);
  });
  it("the seeded time is the logged one, and the seed is written to the file (persist)", async () => {
    const { seats, host } = await restart({ firstSeats: true });
    expect(seats.consent.snapshot().host).toEqual({ noticeVersion: "v1", at: 1_000 });
    expect(seats.persist).toHaveBeenCalled();
    void host;
  });
  it("a failing persist while seeding is tolerated", async () => {
    const seats = newSeats(); (seats.persist as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error("disk"); });
    const { host } = await restart({ firstSeats: true, secondSeats: seats });
    expect(code(() => host.join("host", "alice"))).toBeUndefined();
  });
  it("two roles seed independently, and a role without a participantId in session.started.roles is skipped", async () => {
    const info = { events: 1, lastTs: 0, format: 2, partialTailBytes: 0, sceneId: null, repairs: [], lastGmSeq: null, pendingLine: false, wasPaused: true,
      startedConsents: { host: { participantId: "alice", noticeVersion: "v1", at: 7 }, other: { participantId: "bob", noticeVersion: "v1", at: 8 } } };
    const scenario = await loadScenario(fixture);
    scenario.roles.other = { id: "other", type: "player", brief: "b", private_facts: [] } as (typeof scenario.roles)[string];
    const seats = newSeats();
    const host = new SessionHost({ scenario, engine: new SessionEngine({ scenario, log: new MemoryEventLog("s"), clock: new FakeClock(1) }), npcProvider: new MockModelProvider(), gmProvider: new MockModelProvider(), clock: new FakeClock(1), seats });
    host.resumeFrom(info as never);
    expect(seats.consent.snapshot()).toEqual({ host: { noticeVersion: "v1", at: 7 }, other: { noticeVersion: "v1", at: 8 } });
  });
  it("the participantId in session.started.roles is the one passed to host.join, so seeding matches the gate", async () => {
    const { info } = await restart({ firstSeats: true });
    expect(info.startedConsents?.host?.participantId).toBe("alice");
  });
  it("a role the log has a consent for but no participantId is skipped by the engine", async () => {
    const scenario = await loadScenario(fixture);
    const log = new MemoryEventLog("s");
    const e = new SessionEngine({ scenario, log, clock: new FakeClock(1) });
    await e.start({}, { consents: { host: { noticeVersion: "v1", at: 3 } } });
    const e2 = new SessionEngine({ scenario, log, clock: new FakeClock(2) });
    const out = await e2.restore();
    expect(out.kind === "running" && out.info.startedConsents).toEqual({});
  });
  it("grandfathered session: joined.consent.given is true, so the CLI is not told to /consent", async () => {
    const { host } = await restart({ firstSeats: false });
    expect(host.consentGiven("host", "anyone")).toBe(true);
  });
});

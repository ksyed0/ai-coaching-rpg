import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { RuntimeConnection, realTimer } from "../runtime-connection";
import { StreamHub, type SessionCookie } from "../stream-hub";
import type { ClientMessage, FacilitatorRosterEntry, JoinedFrame, PeerRosterEntry, ReplaySummary, ServerMessage } from "../wire";
import { holdingProxy, sseRecorder, until } from "./fakes";

// The real runtime, in-process, mock models, port 0, private temp dirs. A generous explicit limit; nothing measures elapsed time.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// Loaded by a computed path: tsc would otherwise type-check the runtime's sources under this app's settings (Next's ProcessEnv).
const MAIN = fileURLToPath(new URL("../../../../../services/runtime/src/main.ts", import.meta.url));
if (!existsSync(MAIN)) throw new Error(`hub.runtime.test.ts needs the runtime's entry point at ${MAIN}; it moved: update MAIN`);
const SCENARIO = fileURLToPath(new URL("../../../../../scenarios/friday-escalation", import.meta.url));
const PROTOCOL = fileURLToPath(new URL("../../../../../services/runtime/src/host/protocol.ts", import.meta.url));
type Host = { assignments: Record<string, string>; idle(): Promise<void>; consentGiven(roleId: string, participantId: string): boolean; replayFor(who: string, afterSeq: number): { complete: boolean; events: { seq: number }[] } };
type Bootstrap = (o: { env: Record<string, string>; root: string; logDir: string; tickMs: number; log: (m: string) => void; warn: (m: string) => void; showJoinCodes: (c: { roleId: string; code: string }[]) => void }) =>
  Promise<{ ok: true; runtime: { port: number; host: Host; stop(): Promise<void> } } | { ok: false; errors: string[] }>;

const SESSION = "web-hub";
const PLAYERS = ["delivery_lead", "tech_lead", "account_manager"] as const;
type Player = (typeof PLAYERS)[number];
const ADDRESS: Record<Player, string> = { delivery_lead: "198.51.100.11", tech_lead: "198.51.100.12", account_manager: "198.51.100.13" };
/** What a person types: lower case, with spaces and hyphens. The runtime normalises it. */
const typed = (code: string) => code.replace(/-/g, "").toLowerCase().replace(/(.{4})(?=.)/g, "$1 - ");

let tmp = "";
let runtime: { port: number; host: Host; stop(): Promise<void> } | null = null;
let codes: Record<string, string> = {};
let hub: StreamHub;
let closers: (() => void)[] = [];
const url = () => `ws://127.0.0.1:${runtime!.port}`;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "acr-web-hub-"));
  const { bootstrap } = (await import(MAIN)) as { bootstrap: Bootstrap };
  codes = {};
  const r = await bootstrap({
    env: { SCENARIO_DIR: SCENARIO, RUNTIME_PORT: "0", RUNTIME_HOST: "127.0.0.1", SESSION_ID: SESSION, MODEL_PROVIDER: "mock", TRUST_PROXY: "1" },
    root: tmp, logDir: tmp, tickMs: 60_000, log: () => {}, warn: () => {},
    showJoinCodes: (c) => { for (const x of c) codes[x.roleId] = x.code; },
  });
  if (!r.ok) throw new Error(r.errors.join("; "));
  runtime = r.runtime;
  hub = new StreamHub({ maxStreams: 10, maxStreamsPerSession: 10, maxStreamsPerAddress: 10, setTimer: realTimer, now: Date.now });
});
afterEach(async () => {
  for (const c of closers) c();
  closers = [];
  await runtime?.stop(); runtime = null;
  await rm(tmp, { recursive: true, force: true });
});

/** The join route: a join by code that asks for a credential; the connection is then closed and only the cookie is kept. */
async function joinByCode(role: Player, participantId = `${role}-person`): Promise<{ cookie: SessionCookie; joined: JoinedFrame }> {
  const conn = await RuntimeConnection.connect(url(), ADDRESS[role]);
  const joined = await conn.joinWithCode({ sessionId: SESSION, roleId: role, participantId, joinCode: typed(codes[role]!), displayName: `Name ${role}` });
  conn.close();
  return { joined, cookie: { sessionId: SESSION, roleId: role, participantId, credential: joined.credential!, logIdentity: joined.logIdentity!, expiresAt: Date.now() + 3_600_000 } };
}
/** The stream route: a rejoin by credential with the browser's Last-Event-ID, handed to the hub. */
async function openStream(cookie: SessionCookie, lastSeq = 0) {
  const conn = await RuntimeConnection.connect(url(), ADDRESS[cookie.roleId as Player]);
  const joined = await conn.joinWithCredential({ sessionId: cookie.sessionId, roleId: cookie.roleId, participantId: cookie.participantId, credential: cookie.credential, lastSeq });
  const rec = sseRecorder();
  const handle = hub.open(cookie, ADDRESS[cookie.roleId as Player], conn, joined, rec.out);
  if (handle === "capacity") throw new Error("unexpected capacity");
  closers.push(() => handle.close());
  return { conn, joined, rec, handle };
}
/** The facilitator on a raw socket (the BFF never serves it). */
async function facilitator() {
  const ws = new WebSocket(url());
  const inbox: any[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));
  await new Promise<void>((r, j) => { ws.on("open", () => r()); ws.on("error", j); });
  closers.push(() => ws.terminate());
  ws.send(JSON.stringify({ type: "join_facilitator", sessionId: SESSION }));
  await until(() => inbox.some((m) => m.type === "joined"));
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  return { ws, inbox, send };
}
const seqs = (rec: ReturnType<typeof sseRecorder>) => rec.events().map((e) => e.seq as number);
const lastId = (rec: ReturnType<typeof sseRecorder>) => Number(rec.frames().filter((f) => f.id !== undefined).at(-1)?.id ?? 0);

/** Every player joins, opens a stream and consents through the hub; the facilitator starts the session. */
async function startedSession() {
  const fac = await facilitator();
  const seats = {} as Record<Player, { cookie: SessionCookie; joined: JoinedFrame; stream: Awaited<ReturnType<typeof openStream>> }>;
  for (const role of PLAYERS) {
    const { cookie, joined } = await joinByCode(role);
    seats[role] = { cookie, joined, stream: await openStream(cookie) };
    expect(await hub.send(cookie, { type: "consent", noticeVersion: joined.consent!.noticeVersion })).toBeNull();
  }
  fac.send({ type: "start" });
  await until(() => seats.delivery_lead.stream.rec.events().some((e) => e.type === "inject.fired"));
  await runtime!.host.idle();
  return { fac, seats };
}
async function say(cookie: SessionCookie, text: string, rec: ReturnType<typeof sseRecorder>) {
  expect(await hub.send(cookie, { type: "say", text })).toBeNull();
  await until(() => rec.events().some((e) => e.type === "utterance" && e.text === text));
  await runtime!.host.idle();
}

describe("RuntimeConnection and StreamHub against the real runtime", () => {
  it("joinWithCode returns the credential and passes a lower-case code with spaces and hyphens through unchanged", async () => {
    expect(typed(codes.delivery_lead!)).toMatch(/^[0-9a-z]{4}( - [0-9a-z]{1,4})+$/);
    const { joined } = await joinByCode("delivery_lead");
    expect(joined.credential).toMatch(/^[0-9a-f]{32}$/);
    expect(joined.logIdentity).toMatch(/^[0-9a-f]{32}$/);
    expect(joined.replay).toEqual({ afterSeq: 0, toSeq: 0, events: 0, complete: true });
  });

  it("send reaches the runtime over the stream's own connection and does not supersede it", async () => {
    const { cookie, joined } = await joinByCode("delivery_lead");
    const s = await openStream(cookie);
    expect(await hub.send(cookie, { type: "consent", noticeVersion: "v0" })).toMatchObject({ type: "error", code: "consent_version" });
    expect(await hub.send(cookie, { type: "consent", noticeVersion: joined.consent!.noticeVersion })).toBeNull();
    expect(runtime!.host.consentGiven("delivery_lead", cookie.participantId)).toBe(true);
    // The runtime told the room over the same connection, which is still open.
    await until(() => s.rec.frames().some((f) => f.event === "roster" && f.data.entries.some((e: PeerRosterEntry) => e.roleId === "delivery_lead" && e.ready)));
    expect(s.rec.ends()).toBe(0);
    expect(s.rec.chunks.join("")).not.toContain("superseded");
    expect(s.conn.isOpen).toBe(true);
  });

  it("stream resumes from lastSeq without a gap or duplicate after a socket drop", async () => {
    const { seats } = await startedSession();
    const dl = seats.delivery_lead;
    await say(dl.cookie, "First line from delivery.", dl.stream.rec);
    // The socket drops (the BFF's own side): the browser is told to reconnect; the hub does not.
    (dl.stream.conn as unknown as { ws: WebSocket }).ws.terminate();
    await until(() => dl.stream.rec.ends() === 1);
    expect(dl.stream.rec.frames().at(-1)!.event).toBe("reconnecting");
    // While delivery_lead is away, the room moves on.
    await say(seats.tech_lead.cookie, "Said while delivery was away.", seats.tech_lead.stream.rec);
    await say(seats.account_manager.cookie, "Also said while away.", seats.account_manager.stream.rec);
    // EventSource reconnects with Last-Event-ID.
    const again = await openStream(dl.cookie, lastId(dl.stream.rec));
    expect(again.joined.replay).toMatchObject({ complete: true });
    expect(again.rec.frames().some((f) => f.event === "reset")).toBe(false);
    await say(dl.cookie, "Back again.", again.rec);
    const seen = [...seqs(dl.stream.rec), ...seqs(again.rec)];
    const expected = runtime!.host.replayFor("delivery_lead", 0);
    expect(expected.complete).toBe(true);
    expect(seen).toEqual(expected.events.map((e) => e.seq));
    expect(seqs(again.rec).length).toBeGreaterThanOrEqual(3); // the two missed lines and the new one: the replay was not empty
  });

  it("a lastSeq beyond the head or from another log identity yields a reset frame", async () => {
    const { cookie } = await joinByCode("delivery_lead");
    const beyond = await openStream(cookie, 10_000);
    const reset = beyond.rec.frames().find((f) => f.event === "reset");
    expect(reset).toMatchObject({ id: String(beyond.joined.state.lastSeq), data: { lastSeq: beyond.joined.state.lastSeq } });
    const otherLog = await openStream({ ...cookie, logIdentity: "0".repeat(32) }, 0);
    expect(otherLog.rec.frames().some((f) => f.event === "reset")).toBe(true);
  });

  it("a second open for the same participant ends the first with a superseded event and the first does not reconnect", async () => {
    const { cookie } = await joinByCode("delivery_lead");
    const first = await openStream(cookie);
    const second = await openStream(cookie);
    await until(() => first.rec.ends() === 1);
    expect(first.rec.frames().at(-1)!.event).toBe("superseded");
    expect(first.rec.chunks.join("")).not.toContain("reconnecting");
    expect(first.conn.isOpen).toBe(false);
    expect(second.rec.ends()).toBe(0);
    expect(second.conn.isOpen).toBe(true);
    expect(runtime!.host.assignments.delivery_lead).toBe(cookie.participantId);
  });

  it("two tabs whose joins resolve A then B but reach open B then A: B (the runtime's holder) keeps the stream", async () => {
    const { cookie } = await joinByCode("delivery_lead");
    const join = async () => {
      const conn = await RuntimeConnection.connect(url(), ADDRESS.delivery_lead);
      closers.push(() => conn.close());
      return { conn, joined: await conn.joinWithCredential({ sessionId: SESSION, roleId: "delivery_lead", participantId: cookie.participantId, credential: cookie.credential, lastSeq: 0 }) };
    };
    const a = await join();
    const b = await join(); // the runtime kicks A (4001)
    const recA = sseRecorder(); const recB = sseRecorder();
    const hb = hub.open(cookie, ADDRESS.delivery_lead, b.conn, b.joined, recB.out);
    const ha = hub.open(cookie, ADDRESS.delivery_lead, a.conn, a.joined, recA.out);
    expect(hb).not.toBe("capacity");
    if (ha !== "capacity") closers.push(() => ha.close());
    await until(() => recA.ends() === 1);
    expect(recA.frames().at(-1)!.event).toBe("superseded");
    expect(recB.ends()).toBe(0);
    expect(b.conn.isOpen).toBe(true);
    expect(runtime!.host.assignments.delivery_lead).toBe(cookie.participantId);
    // B still works end to end.
    expect(await hub.send(cookie, { type: "consent", noticeVersion: b.joined.consent!.noticeVersion })).toBeNull();
    expect(runtime!.host.consentGiven("delivery_lead", cookie.participantId)).toBe(true);
    if (hb !== "capacity") hb.close();
  });

  it("a delayed tab whose joined and 4001 close arrive together, after the newer tab joined, does not supersede the newer tab", async () => {
    const { cookie } = await joinByCode("delivery_lead");
    await until(() => runtime!.host.assignments.delivery_lead === undefined); // the join route's socket closed: the seat is free
    const proxy = await holdingProxy(runtime!.port);
    closers.push(() => { void proxy.stop(); });
    const creds = { sessionId: SESSION, roleId: "delivery_lead", participantId: cookie.participantId, credential: cookie.credential, lastSeq: 0 };
    // Tab A, through the proxy: the runtime takes its join, but A hears nothing yet.
    const a = await RuntimeConnection.connect(proxy.url, ADDRESS.delivery_lead);
    closers.push(() => a.close());
    proxy.hold();
    const aJoined = a.joinWithCredential(creds);
    await until(() => runtime!.host.assignments.delivery_lead === cookie.participantId);
    // Tab B joins directly: the runtime kicks A (its 4001 is held with A's joined) and B becomes the holder.
    const b = await RuntimeConnection.connect(url(), ADDRESS.delivery_lead);
    closers.push(() => b.close());
    const bJoined = await b.joinWithCredential(creds);
    const recB = sseRecorder();
    const hb = hub.open(cookie, ADDRESS.delivery_lead, b, bJoined, recB.out);
    if (hb === "capacity") throw new Error("unexpected capacity");
    closers.push(() => hb.close());
    // A's joined and its close arrive in one read: A resolves CLOSING, with its close code not known yet, and looks newer than B.
    proxy.release();
    const aj = await aJoined;
    expect(a.isOpen).toBe(false);
    const recA = sseRecorder();
    const ha = hub.open(cookie, ADDRESS.delivery_lead, a, aj, recA.out);
    if (ha !== "capacity") closers.push(() => ha.close());
    await until(() => recA.ends() === 1);
    expect(recA.frames().at(-1)!.event).toBe("superseded");
    expect(recA.chunks.join("")).not.toContain("reconnecting");
    expect(recB.ends()).toBe(0);
    expect(b.isOpen).toBe(true);
    expect(runtime!.host.assignments.delivery_lead).toBe(cookie.participantId);
    expect(await hub.send(cookie, { type: "consent", noticeVersion: bJoined.consent!.noticeVersion })).toBeNull();
    expect(runtime!.host.consentGiven("delivery_lead", cookie.participantId)).toBe(true);
  });

  it("closing the output (request abort) closes the runtime socket", async () => {
    const { cookie } = await joinByCode("delivery_lead");
    const s = await openStream(cookie);
    await until(() => runtime!.host.assignments.delivery_lead === cookie.participantId);
    s.handle.close();
    expect(s.rec.ends()).toBe(1);
    // The runtime saw the close: it released the seat (the credential still holds it for a rejoin).
    await until(() => runtime!.host.assignments.delivery_lead === undefined);
  });

  it("the stream forwards nothing a player may not see (scan every frame for facilitator-only event types, hidden facts, codes and credentials)", async () => {
    const { fac, seats } = await startedSession();
    const dl = seats.delivery_lead;
    // Scene 1: enough lines for a Game Master check (facilitator-only verdicts).
    await say(dl.cookie, "Did everyone see the email?", dl.stream.rec);
    await say(seats.tech_lead.cookie, "Yes, before go-live is a risk.", seats.tech_lead.stream.rec);
    await say(seats.account_manager.cookie, "We cannot simply say no.", seats.account_manager.stream.rec);
    fac.send({ type: "command", command: { command: "whisper", roleId: "tech_lead", text: "WHISPER-ONLY-FOR-TECH-LEAD" } });
    await until(() => seats.tech_lead.stream.rec.chunks.join("").includes("WHISPER-ONLY-FOR-TECH-LEAD"));
    fac.send({ type: "command", command: { command: "release_hidden", roleId: "client_sponsor", fact: 1 } });
    await until(() => fac.inbox.some((m) => m.type === "event" && m.event.type === "npc.updated" && m.event.released));
    fac.send({ type: "command", command: { command: "advance" } });
    await until(() => dl.stream.rec.events().some((e) => e.type === "scene.entered" && e.sceneId === "s2_client_call"));
    await runtime!.host.idle();
    // Scene 2: Priya (an AI character holding the hidden fact) answers.
    await say(dl.cookie, "Hello Priya.", dl.stream.rec);
    await until(() => dl.stream.rec.events().some((e) => e.type === "utterance" && e.roleId === "client_sponsor"));
    fac.send({ type: "command", command: { command: "advance" } });
    await until(() => dl.stream.rec.events().some((e) => e.type === "scene.entered" && e.sceneId === "s3_internal_wrap"));
    await runtime!.host.idle();
    fac.send({ type: "command", command: { command: "advance" } });
    for (const r of PLAYERS) {
      await until(() => seats[r].stream.rec.ends() === 1);
      expect(seats[r].stream.rec.frames().at(-1)!.event).toBe("ended");
    }

    // Every player's whole SSE output, and what the facilitator legitimately saw (raw runtime frames).
    const streamOf = (r: Player) => seats[r].stream.rec.chunks.join("");
    const facText = JSON.stringify(fac.inbox);
    // Each marker is checked where it may appear (so the scan can fail: the string really exists in this session) and where it may not.
    const OWN: Record<Player, string[]> = {
      delivery_lead: ["You run the programme day to day", "6 person-weeks", "2,400 per person-day"],
      tech_lead: ["You own the architecture", "ingestion layer", "half the effort", "puts the go-live date at", "WHISPER-ONLY-FOR-TECH-LEAD"],
      account_manager: ["You own price, commercial terms", "three times this programme", "renewal decision maker"],
    };
    for (const owner of PLAYERS) {
      for (const marker of OWN[owner]) {
        expect(streamOf(owner), `${owner} lacks its own ${marker.slice(0, 30)}`).toContain(marker);
        for (const other of PLAYERS.filter((r) => r !== owner)) expect(streamOf(other), `${other} saw ${owner}'s ${marker.slice(0, 30)}`).not.toContain(marker);
      }
    }
    // Facilitator-only: present in the facilitator's frames, absent from every player stream.
    const FACILITATOR_ONLY = [
      "Would accept a phased delivery after go-live" /* client_sponsor's hidden fact */, "hiddenFacts", "\"npc.updated\"", "\"gm.no_verdict\"",
      // The facilitator roster and its per-seat fields (players get the peer roster: role, name, ready).
      "\"audience\":\"facilitator\"", "\"consented\"", "\"connected\"",
      // Facilitator commands players never see (only pause, resume and their own whisper reach them).
      "\"command\":\"advance\"", "\"command\":\"release_hidden\"",
      // An AI character's goal and knowledge, and the facilitator-only notice of a server without FACILITATOR_TOKEN.
      "Avoid a change request going to her CFO", "The CFO has already asked why the programme costs what it does", "anyone who can reach it can join as facilitator",
    ];
    for (const marker of FACILITATOR_ONLY) expect(facText, `the facilitator never saw ${marker}`).toContain(marker);
    // Secrets and fields no page may see. Each value below exists in this session (codes captured, credentials and tokens issued).
    const secrets = [
      ...Object.values(codes).flatMap((c) => [c, typed(c)]),
      ...PLAYERS.flatMap((r) => [seats[r].cookie.credential, seats[r].stream.joined.reconnectToken!, seats[r].joined.reconnectToken!]),
      ...Object.values(ADDRESS),
      "reasoning", "\"gm.decision\"", "\"gm.fact_earned\"", "\"facilitator.alert\"", "\"credential\"", "\"reconnectToken\"", "-person",
    ];
    for (const v of PLAYERS.flatMap((r) => [seats[r].cookie.credential, seats[r].joined.reconnectToken!])) expect(v.length).toBeGreaterThanOrEqual(32);
    for (const r of PLAYERS) {
      for (const marker of [...FACILITATOR_ONLY, ...secrets]) expect(streamOf(r), `${r}'s stream leaked ${marker.slice(0, 40)}`).not.toContain(marker);
      expect(streamOf(r)).toContain("session.ended");
    }
    expect(streamOf("delivery_lead")).toContain("Yes, before go-live is a risk."); // another player's line in a shared scene does arrive
  });
});

// Contract: every key of each pinned wire type is listed here (compile-time exhaustive), and every frame the real runtime sends a player
// must use only these keys, with the required ones present. A drift on either side fails this test or the typecheck.
type Exhaustive<T, K extends readonly (keyof T)[]> = Exclude<keyof T, K[number]> extends never ? K : never;
const keys = <T,>() => <const K extends readonly (keyof T)[]>(k: Exhaustive<T, K>) => k;
const JOINED_KEYS = keys<JoinedFrame>()(["type", "roleId", "brief", "privateFacts", "reconnectToken", "state", "replay", "credential", "scenes", "logIdentity", "consent"]);
const REPLAY_KEYS = keys<ReplaySummary>()(["afterSeq", "toSeq", "events", "complete"]);
const CONSENT_KEYS = keys<NonNullable<JoinedFrame["consent"]>>()(["noticeVersion", "notice", "given"]);
const PEER_KEYS = keys<PeerRosterEntry>()(["roleId", "name", "ready"]);
const EVENT_FRAME_KEYS = keys<Extract<ServerMessage, { type: "event" }>>()(["type", "event"]);
const ERROR_KEYS = keys<Extract<ServerMessage, { type: "error" }>>()(["type", "code", "message"]);
const ROSTER_KEYS = keys<Extract<ServerMessage, { type: "roster"; audience: "peers" }>>()(["type", "audience", "entries"]);

function within(o: object, allowed: readonly string[], required: readonly string[], what: string) {
  for (const k of Object.keys(o)) expect(allowed, `${what} has an unpinned key ${k}`).toContain(k);
  for (const k of required) expect(Object.keys(o), `${what} lacks ${k}`).toContain(k);
}

describe("wire contract", () => {
  it("the pinned wire types match the real runtime's frames", async () => {
    const fac = await facilitator();
    const conn = await RuntimeConnection.connect(url(), ADDRESS.delivery_lead);
    closers.push(() => conn.close());
    const frames: ServerMessage[] = [];
    const joined = await conn.joinWithCode({ sessionId: SESSION, roleId: "delivery_lead", participantId: "p-contract", joinCode: codes.delivery_lead!, displayName: "Ann" });
    frames.push(joined);
    conn.onFrame((m) => frames.push(m));
    conn.send({ type: "say", text: "too early" }); // refused before the start: an error frame
    await until(() => frames.some((m) => m.type === "error"));
    conn.send({ type: "consent", noticeVersion: joined.consent!.noticeVersion });
    await until(() => frames.some((m) => m.type === "roster" && m.entries.some((e) => (e as PeerRosterEntry).ready)));
    // Everyone else joins and consents, the facilitator starts: real events arrive.
    for (const role of ["tech_lead", "account_manager"] as const) {
      const { cookie, joined: j } = await joinByCode(role);
      await openStream(cookie);
      await hub.send(cookie, { type: "consent", noticeVersion: j.consent!.noticeVersion });
    }
    fac.send({ type: "start" });
    await until(() => frames.some((m) => m.type === "event" && m.event.type === "inject.fired"));
    conn.send({ type: "say", text: "Contract line." });
    await until(() => frames.some((m) => m.type === "event" && m.event.type === "utterance"));

    const types = new Set(frames.map((m) => m.type));
    expect([...types].sort()).toEqual(["error", "event", "joined", "roster"]);
    for (const m of frames) {
      if (m.type === "joined") {
        within(m, JOINED_KEYS, ["type", "roleId", "state", "replay", "credential", "logIdentity", "consent", "brief", "privateFacts", "reconnectToken", "scenes"], "joined");
        within(m.replay!, REPLAY_KEYS, REPLAY_KEYS, "replay");
        within(m.consent!, CONSENT_KEYS, CONSENT_KEYS, "consent");
        for (const sc of m.scenes!) within(sc, ["id", "title", "goal", "timeBoxMinutes"], ["id", "title", "goal", "timeBoxMinutes"], "scene");
        expect(typeof m.state.lastSeq).toBe("number");
      } else if (m.type === "event") {
        within(m, EVENT_FRAME_KEYS, EVENT_FRAME_KEYS, "event frame");
        expect(Number.isSafeInteger(m.event.seq)).toBe(true);
        expect(typeof m.event.type).toBe("string");
      } else if (m.type === "roster") {
        within(m, ROSTER_KEYS, ROSTER_KEYS, "roster");
        expect(m.audience).toBe("peers");
        for (const e of m.entries) { within(e, PEER_KEYS, ["roleId", "ready"], "peer entry"); expect(typeof (e as PeerRosterEntry).ready).toBe("boolean"); }
      } else {
        within(m, ERROR_KEYS, ERROR_KEYS, "error");
      }
    }
  });
});

// The facilitator side of the contract: every client message wire.ts can send is accepted by the runtime's own schema, and the frames a
// facilitator receives carry only the keys wire.ts knows.
const FAC_ENTRY_KEYS = keys<FacilitatorRosterEntry>()(["roleId", "name", "joined", "consented", "connected"]);
const FAC_ROSTER_KEYS = keys<Extract<ServerMessage, { type: "roster"; audience: "facilitator" }>>()(["type", "audience", "entries"]);
/** One sample of every ClientMessage variant; the Record makes a new variant a compile error until it is added here. */
const SENT: Record<ClientMessage["type"], ClientMessage> = {
  join: { type: "join", sessionId: SESSION, roleId: "delivery_lead", participantId: "p", joinCode: "abcd - efgh", displayName: "Ann", issueCredential: true, lastSeq: 0 },
  join_facilitator: { type: "join_facilitator", sessionId: SESSION, token: "t".repeat(64) },
  start: { type: "start" },
  consent: { type: "consent", noticeVersion: "v1" },
  withdraw_consent: { type: "withdraw_consent" },
  leave: { type: "leave" },
  say: { type: "say", text: "hi", expectSceneId: "sc" },
};

describe("wire contract: facilitator", () => {
  it("the runtime's own schema accepts every message wire.ts can send", async () => {
    const { ClientMessageSchema } = (await import(PROTOCOL)) as { ClientMessageSchema: { safeParse(v: unknown): { success: boolean } } };
    for (const [type, m] of Object.entries(SENT)) expect(ClientMessageSchema.safeParse(m).success, `${type} is accepted`).toBe(true);
  });

  it("the facilitator's joined and roster frames use only pinned keys, and joinFacilitator returns the roster and status", async () => {
    const raw = await facilitator();
    const joined = raw.inbox.find((m) => m.type === "joined");
    within(joined, [...JOINED_KEYS, "hiddenFacts", "notice"], ["type", "roleId", "state"], "facilitator joined");
    expect(joined.roleId).toBe("facilitator");
    await until(() => raw.inbox.some((m) => m.type === "roster"));
    const roster = raw.inbox.find((m) => m.type === "roster");
    within(roster, FAC_ROSTER_KEYS, FAC_ROSTER_KEYS, "facilitator roster");
    expect(roster.audience).toBe("facilitator");
    for (const e of roster.entries) within(e, FAC_ENTRY_KEYS, ["roleId", "joined", "consented", "connected"], "facilitator entry");

    const conn = await RuntimeConnection.connect(url(), null);
    closers.push(() => conn.close());
    const r = await conn.joinFacilitator(SESSION, "any");
    expect(r.status).toBe(joined.state.status);
    expect(r.roster.map((e) => e.roleId).sort()).toEqual([...PLAYERS].sort());
    expect(r.roster.every((e) => e.joined === false && e.consented === false && e.connected === false)).toBe(true);
  });
});


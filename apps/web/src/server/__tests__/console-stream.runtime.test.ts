import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { initialState, reduce, type SessionEvent, type SessionState } from "@acr/events";
import type { Config } from "../config";
import { CONSOLE_COOKIE, secretEpoch } from "../console-session";
import { handleConsoleStream } from "../console-stream";
import { FacilitatorBudget } from "../facilitator-budget";
import { consoleEvent, consoleState } from "../facilitator-copies";
import { FacilitatorHub } from "../facilitator-hub";
import type { Deps } from "../handlers";
import { RuntimeConnection, realTimer } from "../runtime-connection";
import { seal } from "../seal";
import { StreamHub, type SessionCookie } from "../stream-hub";
import type { JoinedFrame } from "../wire";
import { sseReader, sseRecorder, until, type SseFrame } from "./fakes";

// The real runtime, in-process, mock models, port 0, private temp dirs, with the facilitator console's stream route in front of it.
// A generous explicit limit; nothing measures elapsed time.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

// Loaded by a computed path (see hub.runtime.test.ts): a static import would type-check the runtime's sources under this app's settings.
const MAIN = fileURLToPath(new URL("../../../../../services/runtime/src/main.ts", import.meta.url));
if (!existsSync(MAIN)) throw new Error(`console-stream.runtime.test.ts needs the runtime's entry point at ${MAIN}; it moved: update MAIN`);
const SCENARIO = fileURLToPath(new URL("../../../../../scenarios/friday-escalation", import.meta.url));
type Host = { idle(): Promise<void> };
type Bootstrap = (o: { env: Record<string, string>; root: string; logDir: string; tickMs: number; log: (m: string) => void; warn: (m: string) => void; showJoinCodes: (c: { roleId: string; code: string }[]) => void }) =>
  Promise<{ ok: true; runtime: { port: number; host: Host; stop(): Promise<void> } } | { ok: false; errors: string[] }>;

const SESSION = "web-console";
const TOKEN = "c".repeat(64);
const ORIGIN = "https://play.example.org";
const SECRET = "correct horse battery staple";
const KEYS: Config["cookieKeys"] = [{ id: "k1", key: Buffer.alloc(32, 7) }];
const PLAYERS = ["delivery_lead", "tech_lead", "account_manager"] as const;
type Player = (typeof PLAYERS)[number];
const ADDRESS: Record<Player, string> = { delivery_lead: "198.51.100.11", tech_lead: "198.51.100.12", account_manager: "198.51.100.13" };
const typed = (code: string) => code.replace(/-/g, "").toLowerCase().replace(/(.{4})(?=.)/g, "$1 - ");
/** client_sponsor's hidden fact 1 (see hub.runtime.test.ts). */
const HIDDEN_FACT = "Would accept a phased delivery after go-live";
/** client_sponsor's knowledge: never on the console stream, in any frame. */
const KNOWLEDGE = "The module was in an early scope draft";

let tmp = "";
let runtime: { port: number; host: Host; stop(): Promise<void> } | null = null;
let codes: Record<string, string> = {};
let players: StreamHub;
let closers: (() => void)[] = [];
let readers: ReturnType<typeof sseReader>[] = [];
/** Every runtime connection the console route made, in order (a test drops one to simulate the runtime socket going away). */
let consoleConns: RuntimeConnection[] = [];
let deps: Deps;
const url = () => `ws://127.0.0.1:${runtime!.port}`;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "acr-web-console-"));
  const { bootstrap } = (await import(MAIN)) as { bootstrap: Bootstrap };
  codes = {};
  const r = await bootstrap({
    env: { SCENARIO_DIR: SCENARIO, RUNTIME_PORT: "0", RUNTIME_HOST: "127.0.0.1", SESSION_ID: SESSION, MODEL_PROVIDER: "mock", TRUST_PROXY: "1", FACILITATOR_TOKEN: TOKEN },
    root: tmp, logDir: tmp, tickMs: 60_000, log: () => {}, warn: () => {},
    showJoinCodes: (c) => { for (const x of c) codes[x.roleId] = x.code; },
  });
  if (!r.ok) throw new Error(r.errors.join("; "));
  runtime = r.runtime;
  players = new StreamHub({ maxStreams: 10, maxStreamsPerSession: 10, maxStreamsPerAddress: 10, setTimer: realTimer, now: Date.now });
  consoleConns = [];
  const config: Config = {
    runtimeUrl: url(), publicOrigin: ORIGIN, cookieKeys: KEYS, cookieMaxAgeHours: 12, maxStreams: 10, maxStreamsPerSession: 10,
    maxStreamsPerAddress: 10, facilitatorSecret: SECRET, launcherUrl: "http://127.0.0.1:47123", launcherToken: "launcher-token-" + "t".repeat(20),
  };
  // The control service, stubbed: the session's running runtime and its port and token as a pair.
  const launcher = {
    session: async () => ({ sessionId: SESSION, scenarioId: "friday-escalation", status: "running", port: runtime!.port }),
    facilitator: async () => ({ port: runtime!.port, token: TOKEN }),
  };
  deps = {
    config, now: Date.now, launcher: launcher as never,
    connect: (async (u: string, xff: string | null, o?: never) => { const c = await RuntimeConnection.connect(u, xff, o); consoleConns.push(c); return c; }) as Deps["connect"],
    facilitatorBudget: new FacilitatorBudget(),
    facilitatorHub: new FacilitatorHub({ setTimer: realTimer, now: Date.now }),
  } as unknown as Deps;
});
afterEach(async () => {
  for (const r of readers) await r.cancel().catch(() => {});
  readers = [];
  // Cancelling the browsers must release every hub stream (and so its runtime socket).
  await until(() => deps.facilitatorHub.size() === 0, { what: "the console hub to empty" });
  for (const c of closers) c();
  closers = [];
  await runtime?.stop(); runtime = null;
  await rm(tmp, { recursive: true, force: true });
});

// ---- the console side: the real route, with a console cookie ----
const consoleCookie = () => `${CONSOLE_COOKIE}=${seal({ name: "Ann Lee", epoch: secretEpoch(SECRET), expiresAt: Date.now() + 3_600_000 }, KEYS, Date.now(), "fac")}`;
async function consoleStream(lastEventId?: number) {
  const headers: Record<string, string> = { Accept: "text/event-stream", "Sec-Fetch-Site": "same-origin", Cookie: consoleCookie() };
  if (lastEventId !== undefined) headers["Last-Event-ID"] = String(lastEventId);
  const res = await handleConsoleStream(new Request(`${ORIGIN}/api/v1/console/sessions/${SESSION}/stream`, { headers }), deps);
  expect(res.status).toBe(200);
  const r = sseReader(res);
  readers.push(r);
  await until(() => r.frames().some((f) => f.event === "roster") || r.done(), { what: "the console stream's roster frame" });
  return { res, r, conn: consoleConns.at(-1)! };
}
const eventsOf = (r: { frames(): SseFrame[] }) => r.frames().filter((f) => f.event === "event").map((f) => f.data as SessionEvent);
const lastId = (r: { frames(): SseFrame[] }) => Number(r.frames().filter((f) => f.id !== undefined).at(-1)?.id ?? 0);

// ---- the players' side (as in hub.runtime.test.ts) ----
async function joinByCode(role: Player): Promise<{ cookie: SessionCookie; joined: JoinedFrame }> {
  const participantId = `${role}-person`;
  const conn = await RuntimeConnection.connect(url(), ADDRESS[role]);
  const joined = await conn.joinWithCode({ sessionId: SESSION, roleId: role, participantId, joinCode: typed(codes[role]!), displayName: `Name ${role}` });
  conn.close();
  return { joined, cookie: { sessionId: SESSION, roleId: role, participantId, credential: joined.credential!, logIdentity: joined.logIdentity!, expiresAt: Date.now() + 3_600_000 } };
}
async function openPlayerStream(cookie: SessionCookie) {
  const conn = await RuntimeConnection.connect(url(), ADDRESS[cookie.roleId as Player]);
  const joined = await conn.joinWithCredential({ sessionId: cookie.sessionId, roleId: cookie.roleId, participantId: cookie.participantId, credential: cookie.credential, lastSeq: 0 });
  const rec = sseRecorder();
  const handle = players.open(cookie, ADDRESS[cookie.roleId as Player], conn, joined, rec.out);
  if (handle === "capacity") throw new Error("unexpected capacity");
  closers.push(() => handle.close());
  return { rec };
}
/** The facilitator on a raw socket with the real token (a raw WebSocket, so the test sends the runtime's own messages). */
async function facilitator() {
  const ws = new WebSocket(url());
  const inbox: any[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));
  await new Promise<void>((r, j) => { ws.on("open", () => r()); ws.on("error", j); });
  closers.push(() => ws.terminate());
  ws.send(JSON.stringify({ type: "join_facilitator", sessionId: SESSION, token: TOKEN }));
  await until(() => inbox.some((m) => m.type === "joined"));
  return { ws, inbox, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}
type Fac = Awaited<ReturnType<typeof facilitator>>;
type Seat = { cookie: SessionCookie; rec: ReturnType<typeof sseRecorder> };

/** Every player joins, opens a stream and consents; the facilitator starts the session. */
async function startedSession(): Promise<{ fac: Fac; seats: Record<Player, Seat> }> {
  const fac = await facilitator();
  const seats = {} as Record<Player, Seat>;
  for (const role of PLAYERS) {
    const { cookie, joined } = await joinByCode(role);
    seats[role] = { cookie, rec: (await openPlayerStream(cookie)).rec };
    expect(await players.send(cookie, { type: "consent", noticeVersion: joined.consent!.noticeVersion })).toBeNull();
  }
  fac.send({ type: "start" });
  await until(() => seats.delivery_lead.rec.events().some((e) => e.type === "inject.fired"));
  await runtime!.host.idle();
  return { fac, seats };
}
async function say(seat: Seat, text: string) {
  expect(await players.send(seat.cookie, { type: "say", text })).toBeNull();
  await until(() => seat.rec.events().some((e) => e.type === "utterance" && e.text === text));
  await runtime!.host.idle();
}
/** The runtime's own current view for a facilitator: a fresh raw join (state and lastSeq as the runtime holds them). */
async function runtimeSnapshot(): Promise<SessionState> {
  const raw = await facilitator();
  const state = raw.inbox.find((m) => m.type === "joined").state as SessionState;
  raw.ws.terminate();
  return state;
}
/** What a page does: a reset replaces the state, an event is folded with reduce (which throws on a gap or a duplicate). */
function fold(state: SessionState, frames: SseFrame[]): SessionState {
  let s = state;
  for (const f of frames) {
    if (f.event === "reset") s = f.data.state as SessionState;
    else if (f.event === "event") s = reduce(s, f.data as SessionEvent);
  }
  return s;
}
const withoutNpcs = (s: SessionState) => { const { npcs: _npcs, ...rest } = s; return rest; };

describe("the console stream against the real runtime", () => {
  it("no hidden-fact text reaches the console stream", async () => {
    const { fac, seats } = await startedSession();
    const live = await consoleStream();
    await say(seats.delivery_lead, "Did everyone see the email?");
    fac.send({ type: "command", command: { command: "release_hidden", roleId: "client_sponsor", fact: 1 } });
    await until(() => fac.inbox.some((m) => m.type === "event" && m.event.type === "npc.updated" && m.event.released.length > 0));
    await runtime!.host.idle();
    const releasedSeq = (fac.inbox.find((m) => m.type === "event" && m.event.type === "npc.updated" && m.event.released.length > 0)).event.seq as number;
    await until(() => eventsOf(live.r).some((e) => e.seq === releasedSeq));
    // A second tab that joins late gets a reset (a snapshot) instead of a replay.
    const late = await consoleStream(10_000);
    expect(late.r.frames().some((f) => f.event === "reset")).toBe(true);

    // Positive controls: the runtime's raw facilitator frames do carry the text, in the joined frame's hiddenFacts and in the release.
    const raw = JSON.stringify(fac.inbox);
    expect(raw).toContain(HIDDEN_FACT);
    expect(raw).toContain("hiddenFacts");
    const rawRelease = fac.inbox.find((m) => m.type === "event" && m.event.type === "npc.updated" && m.event.seq === releasedSeq);
    expect(JSON.stringify(rawRelease), "the facilitator's own release event lacks the fact").toContain(HIDDEN_FACT);
    const releaseEvent = eventsOf(live.r).find((e) => e.seq === releasedSeq) as Extract<SessionEvent, { type: "npc.updated" }>;
    expect(releaseEvent).toMatchObject({ type: "npc.updated", roleId: "client_sponsor", goals: [], knowledge: [], released: [] });
    for (const r of [live.r, late.r]) {
      // The frames that carry session data about an AI character: never the text. (An AI character's own line may say it once released.)
      for (const f of r.frames().filter((x) => ["joined", "reset", "roster", "characters"].includes(x.event ?? "") || (x.event === "event" && x.data.type === "npc.updated"))) {
        expect(JSON.stringify(f), `${f.event} frame carried the hidden fact`).not.toContain(HIDDEN_FACT);
      }
      expect(r.text()).not.toContain("hiddenFacts");
      expect(r.text(), "the console stream carried the character's knowledge").not.toContain(KNOWLEDGE);
      expect(r.text()).not.toContain("knowledge\":[\"");
    }
    // The characters frame names the character's facts by number only, and fact 1 is released once the release is on the stream.
    const lastCharacters = (r: typeof live.r) => r.frames().filter((f) => f.event === "characters").at(-1)!.data.roles.find((c: { roleId: string }) => c.roleId === "client_sponsor");
    expect(lastCharacters(live.r)).toMatchObject({ roleId: "client_sponsor", goals: expect.any(Array), facts: [{ n: 1, released: true }] });
    expect(lastCharacters(late.r)).toMatchObject({ roleId: "client_sponsor", facts: [{ n: 1, released: true }] });
    const reset = late.r.frames().find((f) => f.event === "reset")!.data.state as SessionState;
    expect(reset.npcs).toEqual({});
    expect(reset.lastSeq).toBeGreaterThanOrEqual(releasedSeq);
    expect(live.r.frames().find((f) => f.event === "joined")!.data).toEqual({ channel: expect.any(String), scenes: expect.any(Array) });
  });

  it("a console stream resumes from Last-Event-ID after the runtime socket drops: folding the reset or replayed events with reduce gives the runtime's facilitator snapshot, with no duplicate or missing seq", async () => {
    const { seats } = await startedSession();
    const first = await consoleStream();
    await say(seats.delivery_lead, "First line from delivery.");
    await until(() => eventsOf(first.r).some((e) => e.type === "utterance" && e.text === "First line from delivery."));
    const held = lastId(first.r);
    expect(held).toBeGreaterThan(0);
    // The runtime socket drops: the browser is told to reconnect (the hub does not).
    (first.conn as unknown as { ws: WebSocket }).ws.terminate();
    await until(() => first.r.frames().some((f) => f.event === "reconnecting"));
    // While the console is away, the room moves on.
    await say(seats.tech_lead, "Said while the console was away.");
    await say(seats.account_manager, "Also said while away.");
    // EventSource reconnects with Last-Event-ID.
    const again = await consoleStream(held);
    await runtime!.host.idle();
    const snapshot = await runtimeSnapshot();
    await until(() => lastId(again.r) >= snapshot.lastSeq, { what: "the resumed stream to catch up" });

    const firstFrames = first.r.frames();
    const againFrames = again.r.frames();
    // Fold what the page folds: its first stream's frames, then the resumed stream's (reduce throws on a gap or a duplicate).
    const folded = fold(fold(initialState(), firstFrames), againFrames);
    const mine = withoutNpcs(folded);
    expect(mine).toEqual(withoutNpcs(consoleState(snapshot)));
    expect(folded.lastSeq).toBe(snapshot.lastSeq);
    expect(Object.values(folded.npcs).every((n) => n.goals.length === 0 && n.knowledge.length === 0 && n.released.length === 0)).toBe(true);
    // The resume was a real one: the lines missed while away arrived on the new stream.
    const missed = eventsOf(again.r).filter((e) => e.type === "utterance").map((e) => (e as Extract<SessionEvent, { type: "utterance" }>).text);
    expect(missed).toEqual(expect.arrayContaining(["Said while the console was away.", "Also said while away."]));
    // No duplicate or missing seq: the first stream is 1..held, the resumed one continues from the held id (or from its reset).
    const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
    const resetAt = againFrames.find((f) => f.event === "reset")?.data.state.lastSeq as number | undefined;
    expect(eventsOf(first.r).map((e) => e.seq)).toEqual(range(1, held));
    expect(eventsOf(again.r).map((e) => e.seq)).toEqual(range((resetAt ?? held) + 1, snapshot.lastSeq));
  });

  it("a Last-Event-ID past the head gives a reset at the head, not an error", async () => {
    await startedSession();
    const snapshot = await runtimeSnapshot();
    const { r } = await consoleStream(10_000);
    const frames = r.frames();
    const reset = frames.find((f) => f.event === "reset");
    expect(reset).toBeDefined();
    expect(reset!.id).toBe(String(snapshot.lastSeq));
    expect(reset!.data.state.lastSeq).toBe(snapshot.lastSeq);
    expect(frames.some((f) => f.event === "error" || f.event === "reconnecting" || f.event === "ended")).toBe(false);
    // The reset is the snapshot, and what follows continues from it.
    expect(withoutNpcs(reset!.data.state)).toEqual(withoutNpcs(consoleState(snapshot)));
  });

  it("with a console stream and three player streams open, the facilitator's command with by \"LEAK-BY-2b2b1\", talk and the end_now alert reach the console stream and no player stream", async () => {
    const { fac, seats } = await startedSession();
    const live = await consoleStream();
    fac.send({ type: "command", command: { command: "pause" }, by: "LEAK-BY-2b2b1" });
    await until(() => fac.inbox.some((m) => m.type === "event" && m.event.type === "facilitator.command" && m.event.command === "pause"));
    fac.send({ type: "command", command: { command: "resume" }, by: "LEAK-BY-2b2b1" });
    await until(() => fac.inbox.some((m) => m.type === "event" && m.event.type === "facilitator.command" && m.event.command === "resume"));
    await say(seats.delivery_lead, "Did everyone see the email?");
    await say(seats.tech_lead, "Yes, before go-live is a risk.");
    const GOAL = "STANCE-GOAL-ONLY-2b2b1";
    fac.send({ type: "command", command: { command: "set_npc_stance", roleId: "client_sponsor", goals: [GOAL] }, by: "LEAK-BY-2b2b1" });
    await until(() => fac.inbox.some((m) => m.type === "event" && m.event.type === "facilitator.command" && m.event.command === "set_npc_stance"));
    await runtime!.host.idle();
    // A second console tab that joins late gets the snapshot, which carries the talk counters.
    const late = await consoleStream(10_000);
    fac.send({ type: "end_now", by: "LEAK-BY-2b2b1" });
    for (const r of PLAYERS) await until(() => seats[r].rec.ends() === 1);
    await until(() => live.r.done() && late.r.done());
    await runtime!.host.idle();

    // The three markers, as the runtime sent them to the facilitator.
    const ALERT_TEXT = "the session was ended now by"; // the runtime's end_now alert (session-engine.ts), raw text with the actor in it
    const MARKERS = ["LEAK-BY-2b2b1", "\"talk\":", ALERT_TEXT];
    const facText = JSON.stringify(fac.inbox);
    for (const m of MARKERS) expect(facText, `the facilitator never saw ${m}`).toContain(m);
    const alert = fac.inbox.find((m) => m.type === "event" && m.event.type === "facilitator.alert");
    expect(alert.event.message).toContain(ALERT_TEXT);

    // The console stream: the command (with its by) and the talk counters arrive; the alert arrives as an event with the fixed line.
    const consoleText = live.r.text() + late.r.text();
    expect(consoleText).toContain("LEAK-BY-2b2b1");
    expect(late.r.text()).toContain("\"talk\":{\"");
    const fixed = (level: "info" | "warning") => (consoleEvent({ type: "facilitator.alert", seq: 1, ts: 1, sessionId: SESSION, level, message: "raw" } as SessionEvent) as Extract<SessionEvent, { type: "facilitator.alert" }>).message;
    const alerts = eventsOf(live.r).filter((e) => e.type === "facilitator.alert") as Extract<SessionEvent, { type: "facilitator.alert" }>[];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ seq: alert.event.seq, level: "info", message: fixed("info") });
    expect(fixed("info")).not.toContain("ended now");
    // The alert's runtime text, raw, is nowhere on the console stream (the actor in it is only ever on the command events).
    expect(consoleText).not.toContain(ALERT_TEXT);
    expect(consoleText).not.toContain("was ended now");
    expect(consoleText).not.toContain("participants were shown");
    // Fields the page may not see.
    // set_npc_stance: the goal text is in the runtime's frames (command and npc.updated) and nowhere on the console.
    expect(facText).toContain(GOAL);
    // The goal text reaches the page only inside characters frames (the stance is the character's current goal).
    const goalFrames = [...live.r.frames(), ...late.r.frames()].filter((f) => JSON.stringify(f).includes(GOAL));
    expect(goalFrames.length).toBeGreaterThan(0);
    expect(goalFrames.every((f) => f.event === "characters")).toBe(true);
    expect(eventsOf(live.r).find((e) => e.type === "facilitator.command" && (e as { command: string }).command === "set_npc_stance")).toMatchObject({ roleId: "client_sponsor", goals: [] });
    // participantId: the runtime's facilitator frames carry the id values this test built; the console never does.
    expect(facText).toContain("delivery_lead-person");
    expect(consoleText).not.toContain("delivery_lead-person");
    // logIdentity: a player's joined frame carries one (the facilitator path may not), so it is controlled from there.
    expect(seats.delivery_lead.cookie.logIdentity).toMatch(/^[0-9a-f]{32}$/);
    expect(consoleText).not.toContain(seats.delivery_lead.cookie.logIdentity);
    // scenarioHash: no source in this session is known to carry it, so this is a negative-only check (no coverage claimed).
    for (const never of ["hiddenFacts", "participantId", "logIdentity", "scenarioHash"]) expect(consoleText, `the console stream carried ${never}`).not.toContain(never);

    // No player stream carries any of the three markers, nor the facilitator's other frames.
    // Intentionally not the full FACILITATOR_ONLY list of hub.runtime.test.ts (that test owns the player-stream contract); these are the console-channel additions.
    const PLAYER_NEVER = [...MARKERS, "\"audience\":\"facilitator\"", "hiddenFacts", "\"facilitator.alert\"", "ended now"];
    for (const r of PLAYERS) {
      const text = seats[r].rec.chunks.join("");
      for (const m of PLAYER_NEVER) expect(text, `${r}'s stream leaked ${m}`).not.toContain(m);
      expect(text).toContain("session.ended");
    }
  });

  it("after the session ends the console stream forwards session.ended and then ended", async () => {
    const { fac } = await startedSession();
    const live = await consoleStream();
    fac.send({ type: "end_now", by: "Ann Lee" });
    await until(() => live.r.done(), { what: "the console stream to finish" });
    const frames = live.r.frames().filter((f) => f.event !== undefined);
    const last = frames.slice(-2);
    expect(last.map((f) => f.event)).toEqual(["event", "ended"]);
    expect(last[0]!.data).toMatchObject({ type: "session.ended", reason: "facilitator_end" });
    expect(last[0]!.id).toBe(String(last[0]!.data.seq));
    expect(last[1]!.data).toEqual({});
    // The hub let go of its slot and the runtime socket.
    expect(deps.facilitatorHub.size()).toBe(0);
    await until(() => !live.conn.isOpen, { what: "the console's runtime socket to close" });
  });
});

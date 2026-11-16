import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type { SessionEvent, SessionState } from "@acr/events";
import type { Config } from "../config";
import { handleConsoleCommand, handleConsoleFacts } from "../console-command";
import { CONSOLE_COOKIE, secretEpoch } from "../console-session";
import { handleConsoleStream } from "../console-stream";
import { FacilitatorBudget } from "../facilitator-budget";
import { FacilitatorHub } from "../facilitator-hub";
import type { Deps } from "../handlers";
import { RuntimeConnection, realTimer } from "../runtime-connection";
import { seal } from "../seal";
import { StreamHub, type SessionCookie } from "../stream-hub";
import type { JoinedFrame } from "../wire";
import { sseReader, sseRecorder, until, type SseFrame } from "./fakes";
import { accountCookieValue, adminNamed, withConsoleAuth } from "../test-support/console-fixtures";

// US-0059: the console's command and hidden-fact routes against the real runtime, in-process, mock models, port 0, private temp dirs.
// The harness is that of console-stream.runtime.test.ts. A generous explicit limit; nothing measures elapsed time.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

// Loaded by a computed path (see hub.runtime.test.ts): a static import would type-check the runtime's sources under this app's settings.
const MAIN = fileURLToPath(new URL("../../../../../services/runtime/src/main.ts", import.meta.url));
if (!existsSync(MAIN)) throw new Error(`console-command.runtime.test.ts needs the runtime's entry point at ${MAIN}; it moved: update MAIN`);
const SCENARIO = fileURLToPath(new URL("../../../../../scenarios/friday-escalation", import.meta.url));
type Host = { idle(): Promise<void> };
type Bootstrap = (o: { env: Record<string, string>; root: string; logDir: string; tickMs: number; log: (m: string) => void; warn: (m: string) => void; showJoinCodes: (c: { roleId: string; code: string }[]) => void }) =>
  Promise<{ ok: true; runtime: { port: number; host: Host; stop(): Promise<void> } } | { ok: false; errors: string[] }>;

const SESSION = "web-console";
const OTHER_SESSION = "s-0123456789abcdef";
const TOKEN = "c".repeat(64);
const ORIGIN = "https://play.example.org";
const SECRET = "correct horse battery staple";
const KEYS: Config["cookieKeys"] = [{ id: "k1", key: Buffer.alloc(32, 7) }];
const PLAYERS = ["delivery_lead", "tech_lead", "account_manager"] as const;
type Player = (typeof PLAYERS)[number];
const ADDRESS: Record<Player, string> = { delivery_lead: "198.51.100.11", tech_lead: "198.51.100.12", account_manager: "198.51.100.13" };
const typed = (code: string) => code.replace(/-/g, "").toLowerCase().replace(/(.{4})(?=.)/g, "$1 - ");
/** The facilitator's name: it comes only from the sealed cookie, and appears nowhere a player can read. */
const BY = "Mx Zorbulon";
/** client_sponsor's hidden fact 1 and knowledge (see hub.runtime.test.ts). */
const HIDDEN_FACT = "Would accept a phased delivery after go-live";
/** The whole text of that fact, as the runtime holds it. */
const FULL_FACT = `${HIDDEN_FACT} if the risk is explained well`;
const KNOWLEDGE = "The module was in an early scope draft";
/** s2_client_call's cfo_pressure inject: not fired in scene 1, so no player may see it. */
const UNFIRED_INJECT = "CFO messages her during the call";
const FIRST_SCENE = "s1_huddle";
const SECOND_SCENE = "s2_client_call";

let tmp = "";
let runtime: { port: number; host: Host; stop(): Promise<void> } | null = null;
let codes: Record<string, string> = {};
let players: StreamHub;
let closers: (() => void)[] = [];
let readers: ReturnType<typeof sseReader>[] = [];
/** Every runtime connection the console route made, in order. */
let consoleConns: RuntimeConnection[] = [];
/** What the console routes' runtime sockets sent and received (the hub's own frames, ref and ack included), to prove the markers exist. */
let sentToRuntime: any[] = [];
let receivedFromRuntime: any[] = [];
let refCounter = 0;
let deps: Deps;
const url = () => `ws://127.0.0.1:${runtime!.port}`;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "acr-web-console-cmd-"));
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
  sentToRuntime = [];
  receivedFromRuntime = [];
  refCounter = 0;
  const config: Config = {
    runtimeUrl: url(), publicOrigin: ORIGIN, cookieKeys: KEYS, cookieMaxAgeHours: 12, maxStreams: 10, maxStreamsPerSession: 10,
    maxStreamsPerAddress: 10, facilitatorSecret: SECRET, launcherUrl: "http://127.0.0.1:47123", launcherToken: "launcher-token-" + "t".repeat(20),
  };
  // The control service, stubbed: the session's running runtime and its port and token as a pair. (Remove goes through it: covered by Task 7.)
  const launcher = {
    session: async () => ({ sessionId: SESSION, scenarioId: "friday-escalation", status: "running", port: runtime!.port }),
    facilitator: async () => ({ port: runtime!.port, token: TOKEN }),
  };
  deps = {
    config, now: Date.now, launcher: withConsoleAuth(launcher) as never,
    connect: (async (u: string, xff: string | null, o?: never) => {
      const c = await RuntimeConnection.connect(u, xff, o);
      consoleConns.push(c);
      // Record without taking the queued frames from the hub: wrap the sender, and the listener the hub registers.
      const send = c.send.bind(c);
      c.send = (m) => { sentToRuntime.push(m); send(m); };
      const onFrame = c.onFrame.bind(c);
      c.onFrame = (fn) => onFrame((m) => { receivedFromRuntime.push(m); fn(m); });
      return c;
    }) as Deps["connect"],
    facilitatorBudget: new FacilitatorBudget(),
    // A readable ref, so the scan can look for it.
    facilitatorHub: new FacilitatorHub({ setTimer: realTimer, now: Date.now, newRef: () => `leakref-${++refCounter}` }),
  } as unknown as Deps;
});
afterEach(async () => {
  for (const r of readers) await r.cancel().catch(() => {});
  readers = [];
  // Cancelling the browsers must release every hub stream (and so its runtime socket).
  await until(() => deps.facilitatorHub.size() === 0, { what: "the console hub to empty" });
  for (const c of closers) c();
  closers = [];
  // Every accepted command schedules a Game Master tick: let it finish, or it meets a closed log.
  await runtime?.host.idle();
  await runtime?.stop(); runtime = null;
  await rm(tmp, { recursive: true, force: true });
});

// ---- the console side: the real routes, with a console cookie ----
const consoleCookie = () => `${CONSOLE_COOKIE}=${accountCookieValue(adminNamed(BY), { keys: KEYS, now: Date.now(), expiresAt: Date.now() + 3_600_000 })}`;
async function consoleStream() {
  const headers: Record<string, string> = { Accept: "text/event-stream", "Sec-Fetch-Site": "same-origin", Cookie: consoleCookie() };
  const res = await handleConsoleStream(new Request(`${ORIGIN}/api/v1/console/sessions/${SESSION}/stream`, { headers }), deps);
  expect(res.status).toBe(200);
  const r = sseReader(res);
  readers.push(r);
  await until(() => r.frames().some((f) => f.event === "roster") || r.done(), { what: "the console stream's roster frame" });
  const channel = r.frames().find((f) => f.event === "joined")!.data.channel as string;
  return { r, channel, conn: consoleConns.at(-1)! };
}
type Tab = Awaited<ReturnType<typeof consoleStream>>;
const eventsOf = (r: { frames(): SseFrame[] }) => r.frames().filter((f) => f.event === "event").map((f) => f.data as SessionEvent);
const commandsOf = (r: { frames(): SseFrame[] }, name: string) => eventsOf(r).filter((e) => e.type === "facilitator.command" && (e as { command: string }).command === name);

const GUARDED = { Origin: ORIGIN, "X-Requested-With": "scenecoach", "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" };
const post = (sessionId: string, route: "command" | "facts", body: unknown) =>
  new Request(`${ORIGIN}/api/v1/console/sessions/${sessionId}/${route}`, { method: "POST", headers: { ...GUARDED, Cookie: consoleCookie() }, body: JSON.stringify(body) });
type Answered = { status: number; code: string | null; data: any; text: string };
async function answered(res: Response): Promise<Answered> {
  const text = await res.text();
  const j = JSON.parse(text) as { data: any; error: { code: string } | null };
  return { status: res.status, code: j.error?.code ?? null, data: j.data, text };
}
/** One command, as the browser posts it. */
const command = async (tab: Tab, body: Record<string, unknown>, sessionId = SESSION): Promise<Answered> =>
  answered(await handleConsoleCommand(post(sessionId, "command", { channel: tab.channel, ...body }), deps));
const factsOf = async (tab: Tab, sessionId = SESSION): Promise<Answered> =>
  answered(await handleConsoleFacts(post(sessionId, "facts", { channel: tab.channel }), deps));

// ---- the players' side (as in console-stream.runtime.test.ts) ----
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

/** Every player joins, opens a stream and consents. Nothing is started. */
async function readySession(): Promise<{ fac: Fac; seats: Record<Player, Seat> }> {
  const fac = await facilitator();
  const seats = {} as Record<Player, Seat>;
  for (const role of PLAYERS) {
    const { cookie, joined } = await joinByCode(role);
    seats[role] = { cookie, rec: (await openPlayerStream(cookie)).rec };
    expect(await players.send(cookie, { type: "consent", noticeVersion: joined.consent!.noticeVersion })).toBeNull();
  }
  return { fac, seats };
}
/** As readySession, then the facilitator starts the session. */
async function startedSession(): Promise<{ fac: Fac; seats: Record<Player, Seat> }> {
  const s = await readySession();
  s.fac.send({ type: "start" });
  await until(() => s.seats.delivery_lead.rec.events().some((e) => e.type === "inject.fired"));
  await runtime!.host.idle();
  return s;
}
/** The runtime's own current view for a facilitator: a fresh raw join. */
async function runtimeSnapshot(): Promise<SessionState> {
  const raw = await facilitator();
  const state = raw.inbox.find((m) => m.type === "joined").state as SessionState;
  raw.ws.terminate();
  return state;
}
const playerText = (seat: Seat) => seat.rec.chunks.join("");

describe("the console's command and fact routes against the real runtime", () => {
  it("every kind posted to the route with the stream's channel is applied once and logged with by from the cookie", async () => {
    await startedSession();
    const tab = await consoleStream();
    const sent = [
      { kind: "pause" },
      { kind: "resume" },
      { kind: "whisper", roleId: "tech_lead", text: "Mind the ingestion risk.", expectSceneId: FIRST_SCENE },
      { kind: "fire_inject", injectId: "email_from_priya", expectSceneId: FIRST_SCENE },
      { kind: "release_hidden", roleId: "client_sponsor", fact: 1, expectSceneId: FIRST_SCENE },
      { kind: "set_npc_stance", roleId: "client_sponsor", goals: ["Get a firm date"], expectSceneId: FIRST_SCENE },
    ];
    for (const body of sent) {
      const a = await command(tab, body);
      expect(a, `${body.kind}: ${a.text}`).toMatchObject({ status: 200, data: { done: true } });
    }
    // advance records the request; the Game Master's next tick (scheduled by the command) changes the scene.
    expect(await command(tab, { kind: "advance", expectSceneId: FIRST_SCENE })).toMatchObject({ status: 200, data: { done: true } });
    await until(() => eventsOf(tab.r).some((e) => e.type === "scene.entered" && (e as { sceneId: string }).sceneId === SECOND_SCENE), { what: "the next scene" });
    expect(await command(tab, { kind: "end_now", message: "Thank you all, that is the end." })).toMatchObject({ status: 200, data: { done: true } });
    await until(() => tab.r.done(), { what: "the console stream to finish" });

    // Each command is on the console stream exactly once, with the name from the cookie.
    for (const name of ["pause", "resume", "whisper", "fire_inject", "release_hidden", "set_npc_stance", "advance"]) {
      const found = commandsOf(tab.r, name);
      expect(found, `${name} events`).toHaveLength(1);
      expect(found[0], name).toMatchObject({ by: BY });
    }
    const ended = eventsOf(tab.r).filter((e) => e.type === "session.ended");
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ reason: "facilitator_end" });
    // end_now's `by` is not visible on the console stream (its alert is a fixed line); the unit mapping test pins that it is sent.
    expect(eventsOf(tab.r).filter((e) => e.type === "facilitator.alert" && (e as { message: string }).message.length > 0)).toHaveLength(1);
    // The release and the stance each produced an npc.updated on the console stream.
    const released = eventsOf(tab.r).filter((e) => e.type === "npc.updated");
    expect(released.length).toBeGreaterThanOrEqual(2); // the release and the stance
  });

  it("a stale expectSceneId is 409 stale_scene and appends nothing", async () => {
    await startedSession();
    const tab = await consoleStream();
    expect(await command(tab, { kind: "advance", expectSceneId: FIRST_SCENE })).toMatchObject({ status: 200 });
    await until(() => eventsOf(tab.r).some((e) => e.type === "scene.entered" && (e as { sceneId: string }).sceneId === SECOND_SCENE), { what: "the next scene" });
    await runtime!.host.idle();
    const before = { seq: (await runtimeSnapshot()).lastSeq, events: eventsOf(tab.r).length, advances: commandsOf(tab.r, "advance").length };
    expect(before.advances).toBe(1);

    const stale = await command(tab, { kind: "advance", expectSceneId: FIRST_SCENE });
    expect(stale).toMatchObject({ status: 409, code: "stale_scene" });
    await runtime!.host.idle();
    expect((await runtimeSnapshot()).lastSeq, "the refused command appended an event").toBe(before.seq);
    expect(eventsOf(tab.r)).toHaveLength(before.events);
    expect(commandsOf(tab.r, "advance")).toHaveLength(1);
  });

  it("two tabs releasing the same fact: one 200, one 409 already_released", async () => {
    await startedSession();
    const a = await consoleStream();
    const b = await consoleStream();
    expect(a.channel).not.toBe(b.channel);
    const body = { kind: "release_hidden", roleId: "client_sponsor", fact: 1 };
    const answers = await Promise.all([command(a, body), command(b, body)]);
    expect(answers.map((x) => x.status).sort(), answers.map((x) => x.text).join(" | ")).toEqual([200, 409]);
    expect(answers.find((x) => x.status === 409)).toMatchObject({ code: "already_released" });
    await runtime!.host.idle();
    for (const tab of [a, b]) {
      await until(() => commandsOf(tab.r, "release_hidden").length === 1, { what: "the release on both tabs" });
      expect(commandsOf(tab.r, "release_hidden")).toHaveLength(1);
    }
    // Both tabs' characters frames say fact 1 is released.
    for (const tab of [a, b]) {
      await until(() => tab.r.frames().filter((f) => f.event === "characters").at(-1)?.data.roles.find((c: { roleId: string }) => c.roleId === "client_sponsor")?.facts[0]?.released === true, { what: "fact 1 released on the characters frame" });
    }
  });

  it("a command before the start with every seat ready is 409 not_started and the session stays idle", async () => {
    await readySession();
    const tab = await consoleStream();
    const before = await runtimeSnapshot();
    expect(before.status).toBe("idle");
    const a = await command(tab, { kind: "pause" });
    expect(a).toMatchObject({ status: 409, code: "not_started" });
    await runtime!.host.idle();
    const after = await runtimeSnapshot();
    expect(after.status).toBe("idle");
    expect(after.lastSeq).toBe(before.lastSeq);
    expect(eventsOf(tab.r).some((e) => e.type === "session.started")).toBe(false);
    // The same for the other kinds that need a running session: none of them starts it.
    expect(await command(tab, { kind: "end_now" })).toMatchObject({ status: 409, code: "not_started" });
    expect(await command(tab, { kind: "advance" })).toMatchObject({ status: 409, code: "not_started" });
    expect((await runtimeSnapshot()).status).toBe("idle");
  });

  it("end_now ends the session: the console stream forwards session.ended then ended; a later command is no_channel; a connected player's stream carries the closing message and no by", async () => {
    const { seats } = await startedSession();
    const tab = await consoleStream();
    const CLOSING = "Closing words for the room";
    const a = await command(tab, { kind: "end_now", message: CLOSING });
    expect(a, a.text).toMatchObject({ status: 200, data: { done: true } });
    await until(() => tab.r.done(), { what: "the console stream to finish" });
    const frames = tab.r.frames().filter((f) => f.event !== undefined);
    const last = frames.slice(-2);
    expect(last.map((f) => f.event)).toEqual(["event", "ended"]);
    expect(last[0]!.data).toMatchObject({ type: "session.ended", reason: "facilitator_end", message: CLOSING });
    // The channel is gone with the stream.
    expect(await command(tab, { kind: "pause" })).toMatchObject({ status: 409, code: "no_channel" });
    // The room: the closing message reaches a connected player; the facilitator's name does not.
    for (const role of PLAYERS) {
      await until(() => seats[role].rec.ends() === 1, { what: `${role}'s stream to end` });
      const text = playerText(seats[role]);
      expect(text, role).toContain(CLOSING);
      expect(text, role).toContain("session.ended");
      expect(text, `${role} saw the facilitator's name`).not.toContain(BY);
      expect(text, `${role} saw a by`).not.toContain("\"by\"");
      // end_now's ref and its ack (sent after session.ended) never reach a player either.
      const endRef = sentToRuntime.find((m) => m.type === "end_now")?.ref as string | undefined;
      expect(endRef, "the hub sent no ref with end_now").toMatch(/^leakref-\d+$/);
      expect(text, `${role} saw end_now's ref`).not.toContain(endRef!);
      expect(text, `${role} saw an ack`).not.toContain("\"ack\"");
    }
  });

  it("with a console stream and three player streams open, no player frame carries the facilitator's name, a ref, an ack, a characters frame, a whisper to another role, a goal, knowledge or fact text, or an unfired inject's content", async () => {
    const { fac, seats } = await startedSession();
    const tab = await consoleStream();
    const GOAL = "LEAK-GOAL-STANCE-2b2b2";
    const whispers: Record<Player, string> = {
      delivery_lead: "LEAK-WHISPER-FOR-DELIVERY",
      tech_lead: "LEAK-WHISPER-FOR-TECH",
      account_manager: "LEAK-WHISPER-FOR-ACCOUNT",
    };
    const posted: Answered[] = [];
    for (const role of PLAYERS) posted.push(await command(tab, { kind: "whisper", roleId: role, text: whispers[role] }));
    posted.push(await command(tab, { kind: "set_npc_stance", roleId: "client_sponsor", goals: [GOAL] }));
    posted.push(await command(tab, { kind: "release_hidden", roleId: "client_sponsor", fact: 1 }));
    posted.push(await command(tab, { kind: "pause" }));
    posted.push(await command(tab, { kind: "resume" }));
    for (const a of posted) expect(a, a.text).toMatchObject({ status: 200, data: { done: true } });
    const factsAnswer = await factsOf(tab);
    expect(factsAnswer.status).toBe(200);
    await runtime!.host.idle();
    // Wait for the run's last frames on every player stream (separate sockets from the console's ack): the whisper, the pause and the resume.
    for (const role of PLAYERS) {
      await until(() => playerText(seats[role]).includes(whispers[role]), { what: `${role}'s own whisper` });
      await until(() => playerText(seats[role]).includes("\"command\":\"pause\""), { what: `${role}'s pause` });
      await until(() => playerText(seats[role]).includes("\"command\":\"resume\""), { what: `${role}'s resume` });
    }
    await until(() => tab.r.frames().some((f) => f.event === "characters" && JSON.stringify(f.data).includes(GOAL)), { what: "the goal on the characters frame" });
    const consoleText = tab.r.text();

    // Positive controls: every marker is where it belongs, so the scan below can fail.
    const refs = sentToRuntime.filter((m) => m.ref !== undefined).map((m) => m.ref as string);
    expect(refs.length, "the hub sent no ref").toBeGreaterThanOrEqual(posted.length);
    expect(refs.every((r) => /^leakref-\d+$/.test(r))).toBe(true);
    const acks = receivedFromRuntime.filter((m) => m.type === "ack");
    expect(acks.map((m) => m.ref).sort(), "the runtime acked each ref").toEqual([...refs].sort());
    expect(consoleText, "the console stream lacks the facilitator's name").toContain(BY);
    expect(eventsOf(tab.r).filter((e) => e.type === "facilitator.command" && (e as { by?: string }).by === BY).length).toBeGreaterThan(0);
    expect(consoleText, "the console stream has no characters frame").toContain("event: characters");
    expect(consoleText).toContain(GOAL);
    expect(consoleText, "the console stream lacks the characters facts list").toContain("\"facts\":[{\"n\"");
    for (const role of PLAYERS) expect(consoleText, `the console stream lacks the whisper to ${role}`).toContain(whispers[role]);
    const scenes = tab.r.frames().find((f) => f.event === "joined")!.data.scenes as { injects?: { content: string }[] }[];
    expect(JSON.stringify(scenes), "the console's scenes lack the unfired inject").toContain(UNFIRED_INJECT);
    const rawFac = JSON.stringify(fac.inbox);
    expect(rawFac, "the facilitator socket lacks the knowledge").toContain(KNOWLEDGE);
    expect(rawFac, "the facilitator socket lacks the fact").toContain(HIDDEN_FACT);
    expect(rawFac, "the facilitator socket lacks the unfired inject").toContain(UNFIRED_INJECT);
    expect(rawFac).toContain(GOAL);
    expect(rawFac, "the facilitator socket lacks hiddenFacts").toContain("hiddenFacts");
    expect(JSON.stringify(factsAnswer.data), "the facts response lacks the text").toContain(HIDDEN_FACT);
    // Each player does get their own whisper, and a pause and a resume.
    for (const role of PLAYERS) {
      expect(playerText(seats[role]), role).toContain(whispers[role]);
      expect(playerText(seats[role]), role).toContain("\"command\":\"pause\"");
      expect(playerText(seats[role]), role).toContain("\"command\":\"resume\"");
    }

    // The scan: nothing a player stream carries is any of it.
    const never: [string, string][] = [
      ["the facilitator's name", BY],
      ["an ack", "\"type\":\"ack\""],
      ["an ack frame", "event: ack"],
      ["a characters frame", "event: characters"],
      ["a characters roles list", "\"facts\":[{\"n\""],
      ["a goal", GOAL],
      ["knowledge", KNOWLEDGE],
      ["fact text", HIDDEN_FACT],
      ["hidden facts", "hiddenFacts"],
      ["an unfired inject", UNFIRED_INJECT],
      ...refs.map((r): [string, string] => [`ref ${r}`, r]),
    ];
    for (const role of PLAYERS) {
      const text = playerText(seats[role]);
      for (const [what, marker] of never) expect(text, `${role}'s stream carried ${what}`).not.toContain(marker);
      for (const other of PLAYERS.filter((x) => x !== role)) expect(text, `${role}'s stream carried the whisper to ${other}`).not.toContain(whispers[other]);
    }
  });

  it("fact text reaches the browser only through the facts route: no console stream frame carries it, and the route answers the channel's text and 409 no_channel after the stream closes", async () => {
    await startedSession();
    const tab = await consoleStream();
    const other = await consoleStream();
    // Before and after a release, on two tabs: the stream never carries the text.
    expect(await command(tab, { kind: "release_hidden", roleId: "client_sponsor", fact: 1 })).toMatchObject({ status: 200 });
    await runtime!.host.idle();
    await until(() => tab.r.frames().filter((f) => f.event === "characters").at(-1)?.data.roles.find((c: { roleId: string }) => c.roleId === "client_sponsor")?.facts[0]?.released === true);
    for (const t of [tab, other]) {
      expect(t.r.text(), "a console stream frame carried the fact text").not.toContain(HIDDEN_FACT);
      expect(t.r.text()).not.toContain(KNOWLEDGE);
    }
    // The route answers the text, field by field, for the channel asked about (and it is not cached).
    const res = await handleConsoleFacts(post(SESSION, "facts", { channel: tab.channel }), deps);
    expect(res.headers.get("Cache-Control")).toMatch(/no-store/);
    const a = await answered(res);
    expect(a.status, a.text).toBe(200);
    expect(a.data.roles).toEqual([{ roleId: "client_sponsor", facts: [{ n: 1, text: FULL_FACT }] }]);
    expect(Object.keys(a.data)).toEqual(["roles"]);
    expect(a.text).not.toContain(KNOWLEDGE);
    expect(await factsOf(other)).toMatchObject({ status: 200 });
    // Another session's id never sees this channel, for the facts and for the command alike.
    expect(await factsOf(tab, OTHER_SESSION)).toMatchObject({ status: 409, code: "no_channel" });
    expect(await command(tab, { kind: "pause" }, OTHER_SESSION)).toMatchObject({ status: 409, code: "no_channel" });
    expect(commandsOf(tab.r, "pause")).toHaveLength(0);
    // A channel nobody opened.
    expect(await handleConsoleFacts(post(SESSION, "facts", { channel: "0b9f6c1e-2d3a-4c5b-8e7f-1a2b3c4d5e6f" }), deps).then(answered)).toMatchObject({ status: 409, code: "no_channel" });
    // The tab closes: its text is gone from the hub; the other tab still has its own.
    await tab.r.cancel();
    await until(() => deps.facilitatorHub.size() === 1, { what: "the closed tab's slot to be freed" });
    const gone = await factsOf(tab);
    expect(gone).toMatchObject({ status: 409, code: "no_channel" });
    expect(gone.text).not.toContain(HIDDEN_FACT);
    expect(await factsOf(other)).toMatchObject({ status: 200 });
  });

  it("the route opens no runtime socket (budget live in use 1, short 0, while commands run)", async () => {
    await startedSession();
    const tab = await consoleStream();
    const budget = deps.facilitatorBudget;
    expect(consoleConns).toHaveLength(1);
    expect(budget.inUse(SESSION, "live")).toBe(1);
    expect(budget.inUse(SESSION, "short")).toBe(0);
    const pending = command(tab, { kind: "pause" });
    // Taken as the call starts (the handler has not reached the hub yet); the proof that a command opens no socket is the connection count below.
    expect(budget.inUse(SESSION, "live")).toBe(1);
    expect(budget.inUse(SESSION, "short")).toBe(0);
    expect(await pending).toMatchObject({ status: 200 });
    for (const body of [{ kind: "resume" }, { kind: "whisper", roleId: "tech_lead", text: "Hello" }, { kind: "advance", expectSceneId: FIRST_SCENE }]) {
      expect(await command(tab, body)).toMatchObject({ status: 200 });
    }
    expect(await factsOf(tab)).toMatchObject({ status: 200 });
    expect(await command(tab, { kind: "pause" }, OTHER_SESSION)).toMatchObject({ status: 409, code: "no_channel" });
    expect(consoleConns, "a command or facts request opened a runtime socket").toHaveLength(1);
    expect(budget.inUse(SESSION, "live")).toBe(1);
    expect(budget.inUse(SESSION, "short")).toBe(0);
    expect(budget.inUse(OTHER_SESSION, "short")).toBe(0);
  });
});

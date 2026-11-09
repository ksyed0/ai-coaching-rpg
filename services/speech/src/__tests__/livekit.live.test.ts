import { execFile, fork, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RoomConn, RoomPort } from "../ingest/room-port.js";

// US-0071 (EPIC-0003 voice A1b, Task 18): OPT-IN live checks against a REAL LiveKit server. Skipped unless VOICE_LIVE=1 (never in CI or
// `pnpm test`). The harness sets, for a throwaway local server (never `--dev` keys, never a pilot server):
//   LIVEKIT_LIVE_URL (ws://127.0.0.1:<port>), LIVEKIT_LIVE_HOST (http://127.0.0.1:<port>), LIVEKIT_LIVE_KEY, LIVEKIT_LIVE_SECRET;
//   optionally LIVEKIT_LIVE_RESTART, LIVEKIT_LIVE_STOP, LIVEKIT_LIVE_START (shell commands restarting, stopping and starting that
//   server) and LIVEKIT_LIVE_BLIP (a command freezing it for about 20 s); the cases that need them are skipped without them;
//   VOICE_LIVE_LONG=1 for the more-than-10-minutes case.
// Every native and SDK module is loaded dynamically inside the suite, so the skipped run loads neither @livekit/rtc-node nor
// livekit-server-sdk. Nothing here prints a key, a token, a room name or an identity: assertions only; the few timings printed are numbers.
// `livekit-room-native.ts` is excluded from coverage by name: these checks are its proof against a real server.
const LIVE = process.env.VOICE_LIVE === "1";
const LONG = process.env.VOICE_LIVE_LONG === "1";
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

type Live = { url: string; host: URL; apiKey: string; apiSecret: string };
function liveEnv(): Live {
  const { LIVEKIT_LIVE_URL: url, LIVEKIT_LIVE_HOST: host, LIVEKIT_LIVE_KEY: apiKey, LIVEKIT_LIVE_SECRET: apiSecret } = process.env;
  if (!url || !host || !apiKey || !apiSecret) throw new Error("VOICE_LIVE=1 needs LIVEKIT_LIVE_URL, LIVEKIT_LIVE_HOST, LIVEKIT_LIVE_KEY and LIVEKIT_LIVE_SECRET");
  return { url, host: new URL(host), apiKey, apiSecret };
}
const sh = promisify(execFile);
const runCmd = async (cmd: string | undefined): Promise<void> => { if (!cmd) throw new Error("no command"); await sh("/bin/sh", ["-c", cmd], { timeout: 120_000 }); };

const hex = (n: number): string => randomBytes(n).toString("hex");
const newRoom = (): string => `v${hex(16)}`;
const newGen = (): string => hex(4);
const ROLE = "tech_lead";
/** A window in which NOTHING may happen (AGENTS.md section 8: such a real wait may be long; it only gets safer the longer it is). */
const QUIET_MS = 4_000;
const quiet = (ms = QUIET_MS): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** A loopback port nothing listens on (bound, read, closed). */
async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as net.AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
/** Rejects after `ms` with a fixed message: a hang catcher, never an elapsed-time assertion. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: no outcome within ${ms} ms`)), ms); })]).finally(() => clearTimeout(t));
}

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = path.join(PKG, "src", "main.ts");

describe.skipIf(!LIVE)("LiveKit live checks (US-0071, A1b Task 18; VOICE_LIVE=1)", () => {
  let env: Live;
  let lk: typeof import("@acr/adapters/livekit");
  let rtc: typeof import("../ingest/livekit-room-native.js");
  let ingestMod: typeof import("../ingest/livekit-ingest.js");
  let pubMod: typeof import("./live-publisher.js");
  let rtcNode: typeof import("@livekit/rtc-node");
  let admin: import("@acr/adapters/livekit").RoomAdmin;
  let dir: string;
  const cleanups: (() => Promise<unknown>)[] = [];
  const later = (fn: () => Promise<unknown>): void => { cleanups.push(fn); };

  beforeAll(async () => {
    env = liveEnv();
    dir = await mkdtemp(path.join(os.tmpdir(), "acr-speech-live-"));
    lk = await import("@acr/adapters/livekit");
    rtc = await import("../ingest/livekit-room-native.js");
    rtc.silenceRtcLogger(); // before any room opens, also for the test-only publisher
    ingestMod = await import("../ingest/livekit-ingest.js");
    pubMod = await import("./live-publisher.js");
    rtcNode = await import("@livekit/rtc-node");
    admin = lk.createRoomAdmin({ host: env.host, apiKey: env.apiKey, apiSecret: env.apiSecret });
  });
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  // ---- tokens, publishers, the real RoomPort, the real LiveKitIngest ----

  const seatToken = async (room: string, roleId: string, generation: string): Promise<string> =>
    (await lk.mintParticipantToken({ apiKey: env.apiKey, apiSecret: env.apiSecret, room, identity: lk.participantIdentity(roleId, generation) })).token;
  const workerToken = async (room: string): Promise<string> =>
    (await lk.mintWorkerToken({ apiKey: env.apiKey, apiSecret: env.apiSecret, room, identity: lk.workerIdentity(hex(4)) })).token;
  /** A hand-made HS256 token with any grant (for the refusal checks only): the claims LiveKit reads. */
  const customToken = (identity: string, video: Record<string, unknown>, secret = env.apiSecret): string => {
    const b = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const head = `${b({ alg: "HS256", typ: "JWT" })}.${b({ iss: env.apiKey, sub: identity, nbf: now - 10, exp: now + 600, video })}`;
    return `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`;
  };
  const publisher = async (room: string, roleId: string, generation: string, o: { autoSubscribe?: boolean; token?: string } = {}) => {
    const p = await pubMod.connectPublisher(env.url, o.token ?? await seatToken(room, roleId, generation), o);
    later(() => p.disconnect());
    return p;
  };
  const openWorker = async (room: string, token?: string): Promise<RoomConn> => {
    const conn = await rtc.createRtcRoomPort().open(env.url, token ?? await workerToken(room));
    later(() => conn.disconnect());
    return conn;
  };

  /**
   * The real LiveKitIngest on the real RoomPort, listening to `rooms` (role -> room). Counts frames per generation, keeps the order of
   * generations delivered, every subscribe call (by track sid), the joins and the statuses; `raw()` gives rtc-node's Room of each open
   * connection (for simulateScenario).
   */
  const listen = (rooms: Map<string, string>) => {
    const base = rtc.createRtcRoomPort();
    const subscribed: string[] = [];
    const conns: RoomConn[] = [];
    const port: RoomPort = {
      async open(url, token) {
        const c = await base.open(url, token);
        conns.push(c);
        return {
          onTrack: (fn) => c.onTrack(fn), onTrackGone: (fn) => c.onTrackGone(fn), onDisconnected: (fn) => c.onDisconnected(fn),
          subscribe: (sid) => { subscribed.push(sid); c.subscribe(sid); }, unsubscribe: (sid) => c.unsubscribe(sid),
          frames: (sid, r, ch) => c.frames(sid, r, ch), disconnect: () => c.disconnect(),
        };
      },
    };
    const counts = new Map<string, number>();
    const order: string[] = [];
    let wrongSize = 0;
    const statuses: string[] = [];
    let joins = 0;
    const ingest = new ingestMod.LiveKitIngest({
      room: port,
      join: async (roleId) => { joins++; const room = rooms.get(roleId)!; return { url: env.url, token: await workerToken(room), room }; },
      onStatus: (s) => statuses.push(s),
    });
    const done = ingest.start((roleId, generation, frame) => {
      const g = `${roleId}:${generation}`;
      counts.set(g, (counts.get(g) ?? 0) + 1);
      if (order[order.length - 1] !== g) order.push(g);
      if (frame.length !== 320) wrongSize++;
    });
    let outcome: "pending" | "resolved" | "rejected" = "pending";
    done.then(() => { outcome = "resolved"; }, () => { outcome = "rejected"; });
    later(() => ingest.stop());
    return {
      ingest, subscribed, statuses, order,
      count: (roleId: string, generation: string) => counts.get(`${roleId}:${generation}`) ?? 0,
      total: () => [...counts.values()].reduce((a, b) => a + b, 0),
      wrongSize: () => wrongSize, joins: () => joins, outcome: () => outcome,
      raw: () => conns.map((c) => (c as unknown as { room: import("@livekit/rtc-node").Room }).room),
    };
  };
  const allow = (gen: string | undefined, roleId = ROLE): Map<string, string> => (gen === undefined ? new Map() : new Map([[roleId, gen]]));
  /** Waits until `fn()` has grown by at least `by` from now. */
  const grows = async (fn: () => number, by: number, timeout = 30_000): Promise<void> => {
    const start = fn();
    await vi.waitFor(() => expect(fn() - start).toBeGreaterThanOrEqual(by), { timeout, interval: 50 });
  };

  // ---- case 1 and the grants ----

  it("case 1: with auto-subscribe off, subscribe() delivers the holder's microphone to the hidden worker as 20 ms 16 kHz mono chunks", async () => {
    const room = newRoom();
    const gen = newGen();
    const p = await publisher(room, ROLE, gen);
    const sid = await p.publish();
    const conn = await openWorker(room);
    const seen: { identity: string; trackSid: string; kind: string; source: string }[] = [];
    conn.onTrack((t) => seen.push(t));
    await vi.waitFor(() => expect(seen.some((t) => t.trackSid === sid)).toBe(true), { timeout: 30_000 });
    const t = seen.find((x) => x.trackSid === sid)!;
    expect(t.kind).toBe("audio");
    expect(t.source).toBe("microphone");
    expect(lk.parseParticipantIdentity(t.identity)).toEqual({ roleId: ROLE, generation: gen });
    // Auto-subscribe is off: a read before subscribe() waits (nothing is delivered until the worker asks).
    const early = conn.frames(sid, 16000, 1)[Symbol.asyncIterator]();
    let earlyState = "pending";
    void early.next().then((r) => { earlyState = r.done ? "done" : "value"; }, () => { earlyState = "threw"; });
    await quiet(2_000);
    expect(earlyState).toBe("pending");
    conn.unsubscribe(sid); // ends that waiting read
    await vi.waitFor(() => expect(earlyState).toBe("done"));
    const sizes: number[] = [];
    conn.subscribe(sid);
    const iter = conn.frames(sid, 16000, 1)[Symbol.asyncIterator]();
    for (let i = 0; i < 50; i++) {
      const r = await iter.next();
      if (r.done) break;
      sizes.push(r.value.length);
    }
    await iter.return?.();
    expect(sizes.length).toBe(50);
    // AudioStream with frameSizeMs 20 at 16 kHz mono: 320 samples (RtcConn drops any other rate or channel count, so a frame proves both).
    expect(new Set(sizes)).toEqual(new Set([320]));
    // The worker joined hidden: the publisher's room never lists it; the server's admin API does (case 5).
    expect([...p.room.remoteParticipants.values()].filter((x) => x.identity.startsWith(lk.WORKER_IDENTITY_PREFIX)).length).toBe(0);
    const listed = await admin.listParticipants(room);
    expect(listed.filter((i) => i.startsWith(lk.WORKER_IDENTITY_PREFIX)).length).toBe(1);
    expect(listed.filter((i) => i.startsWith(`${ROLE}.`)).length).toBe(1);
  });

  it("a participant token publishes a microphone only and can subscribe to nothing", async () => {
    const room = newRoom();
    const a = await publisher(room, ROLE, newGen());
    const sid = await a.publish();
    // A second seat identity in the same room, with auto-subscribe ON: canSubscribe false means it never receives A's track.
    const b = await publisher(room, ROLE, newGen(), { autoSubscribe: true });
    let subscribedByB = 0;
    b.room.on(rtcNode.RoomEvent.TrackSubscribed, () => { subscribedByB++; });
    await vi.waitFor(() => expect([...b.room.remoteParticipants.values()].some((x) => x.trackPublications.has(sid))).toBe(true), { timeout: 30_000 });
    const pubOfA = [...b.room.remoteParticipants.values()].flatMap((x) => [...x.trackPublications.values()]).find((x) => x.sid === sid)!;
    try { pubOfA.setSubscribed(true); } catch { /* refused locally: also a refusal */ }
    await quiet();
    expect(subscribedByB).toBe(0);
    // canPublishSources is microphone only: a screen-share audio track is refused by the server.
    const c = await publisher(room, ROLE, newGen());
    await expect(within(c.publish(rtcNode.TrackSource.SOURCE_SCREENSHARE_AUDIO), 60_000, "a refused publish")).rejects.toThrow();
  });

  // ---- the ingest: which track it takes, and attribution ----

  it("the worker subscribes only to the allowed identity of the seat room (not a stale generation, not another role)", async () => {
    const room = newRoom();
    const [gA, gB] = [newGen(), newGen()];
    const a = await publisher(room, ROLE, gA);
    const sidA = await a.publish();
    const stale = await publisher(room, ROLE, gB);
    const sidStale = await stale.publish();
    const other = await publisher(room, "account_manager", newGen());
    const sidOther = await other.publish();
    const l = listen(new Map([[ROLE, room]]));
    l.ingest.setAllowed(allow(gA));
    await grows(() => l.count(ROLE, gA), 50);
    await quiet();
    expect(l.subscribed).toEqual([sidA]);
    expect(l.subscribed).not.toContain(sidStale);
    expect(l.subscribed).not.toContain(sidOther);
    expect(l.order).toEqual([`${ROLE}:${gA}`]);
    expect(l.wrongSize()).toBe(0);
    expect(l.statuses).toEqual(["connected"]);
  });

  it("frames queued under the old generation are never delivered after setAllowed moves the seat, and the two never interleave", async () => {
    const room = newRoom();
    const [gA, gB] = [newGen(), newGen()];
    await (await publisher(room, ROLE, gA)).publish();
    await (await publisher(room, ROLE, gB)).publish();
    const l = listen(new Map([[ROLE, room]]));
    l.ingest.setAllowed(allow(gA));
    await grows(() => l.count(ROLE, gA), 100);
    const atSwitch = l.count(ROLE, gA);
    l.ingest.setAllowed(allow(gB)); // synchronously: from here no frame of gA may arrive
    await grows(() => l.count(ROLE, gB), 100);
    await quiet();
    expect(l.count(ROLE, gA)).toBe(atSwitch);
    expect(l.order).toEqual([`${ROLE}:${gA}`, `${ROLE}:${gB}`]);
  });

  // ---- case 2 ----

  it("case 2: rapid pause/resume (mute/unmute) under 100 ms and around 1 s, and a fast unpublish/republish, keep audio flowing", async () => {
    const room = newRoom();
    const gen = newGen();
    const p = await publisher(room, ROLE, gen);
    await p.publish();
    const l = listen(new Map([[ROLE, room]]));
    l.ingest.setAllowed(allow(gen));
    await grows(() => l.count(ROLE, gen), 50);
    for (const gap of [0, 0, 20, 50, 80, 0, 30]) { // under 100 ms
      l.ingest.setAllowed(allow(undefined));
      if (gap > 0) await new Promise((r) => setTimeout(r, gap)); else await Promise.resolve();
      l.ingest.setAllowed(allow(gen));
    }
    await grows(() => l.count(ROLE, gen), 100);
    for (let i = 0; i < 3; i++) { // around 1 s
      l.ingest.setAllowed(allow(undefined));
      await new Promise((r) => setTimeout(r, 1_000));
      l.ingest.setAllowed(allow(gen));
      await grows(() => l.count(ROLE, gen), 25);
    }
    // The browser mutes by unpublishing: a fast unpublish and republish, then one around 1 s.
    await p.unpublish();
    await p.publish();
    await grows(() => l.count(ROLE, gen), 100);
    await p.unpublish();
    await new Promise((r) => setTimeout(r, 1_000));
    await p.publish();
    await grows(() => l.count(ROLE, gen), 100);
    expect(l.statuses).toEqual(["connected"]);
    expect(l.outcome()).toBe("pending");
    expect(l.wrongSize()).toBe(0);
  });

  it("case 2: a refused subscription is surfaced (the read ends; the ingest retries, bounded, then reports failed)", async () => {
    const room = newRoom();
    const gen = newGen();
    const p = await publisher(room, ROLE, gen);
    const sid = await p.publish();
    // A hidden subscriber whose grant has no canSubscribe: the server refuses its subscription.
    const noSub = (): string => customToken(lk.workerIdentity(hex(4)), { room, roomJoin: true, canPublish: false, canSubscribe: false, canPublishData: false, hidden: true });
    const conn = await openWorker(room, noSub());
    const seen: string[] = [];
    conn.onTrack((t) => seen.push(t.trackSid));
    await vi.waitFor(() => expect(seen).toContain(sid), { timeout: 30_000 });
    conn.subscribe(sid);
    const iter = conn.frames(sid, 16000, 1)[Symbol.asyncIterator]();
    // The server answers nothing (live finding D60): the read ends after SUBSCRIBE_WAIT_MS instead of waiting for ever.
    const first = await within(iter.next(), 60_000, "a refused subscription");
    expect(first.done).toBe(true);
    // Through the ingest: bounded re-subscribes (MAX_TRACK_RESTARTS), then `failed`, and start() rejects with the fixed sentence.
    const base = rtc.createRtcRoomPort();
    const statuses: string[] = [];
    const ing = new ingestMod.LiveKitIngest({ room: base, join: async () => ({ url: env.url, token: noSub(), room }), onStatus: (s) => statuses.push(s) });
    later(() => ing.stop());
    const done = ing.start(() => undefined);
    ing.setAllowed(allow(gen));
    await expect(within(done, 150_000, "the ingest")).rejects.toThrow(ingestMod.LIVEKIT_INGEST_FAILED);
    expect(statuses).toEqual(["connected", "failed"]);
  }, 240_000);

  // ---- case 3 ----

  it("case 3: removeParticipant drops a publisher holding a valid token; it can reconnect with that token, and is never subscribed", async () => {
    const room = newRoom();
    const [gOld, gNew] = [newGen(), newGen()];
    const token = await seatToken(room, ROLE, gOld);
    const p = await publisher(room, ROLE, gOld, { token });
    await p.publish();
    const l = listen(new Map([[ROLE, room]]));
    l.ingest.setAllowed(allow(gNew)); // the seat now belongs to a new generation
    await vi.waitFor(() => expect(l.statuses).toEqual(["connected"]), { timeout: 30_000 });
    await admin.removeParticipant(room, lk.participantIdentity(ROLE, gOld));
    const reason = await within(p.disconnected, 30_000, "the removal");
    expect(reason).toBe(rtcNode.DisconnectReason.PARTICIPANT_REMOVED);
    // The token is still valid: the removed participant can come back (only control's sweep removes it again, every 20 s: browser live spec).
    const back = await publisher(room, ROLE, gOld, { token });
    await back.publish();
    await vi.waitFor(async () => expect(await admin.listParticipants(room)).toContain(lk.participantIdentity(ROLE, gOld)), { timeout: 30_000 });
    await quiet();
    expect(l.subscribed).toEqual([]); // a stale generation is never subscribed
    expect(l.total()).toBe(0);
  });

  // ---- case 4 ----

  it("case 4: a second connection with the same identity displaces the first, and the worker subscribes the new track", async () => {
    const room = newRoom();
    const gen = newGen();
    const first = await publisher(room, ROLE, gen);
    await first.publish();
    const l = listen(new Map([[ROLE, room]]));
    l.ingest.setAllowed(allow(gen));
    await grows(() => l.count(ROLE, gen), 50);
    const second = await publisher(room, ROLE, gen);
    const reason = await within(first.disconnected, 30_000, "the displacement");
    expect(reason).toBe(rtcNode.DisconnectReason.DUPLICATE_IDENTITY);
    const sid2 = await second.publish();
    await vi.waitFor(() => expect(l.subscribed).toContain(sid2), { timeout: 30_000 });
    await grows(() => l.count(ROLE, gen), 100);
    expect(l.statuses).toEqual(["connected"]);
  });

  // ---- case 6 (short): signal resume and full reconnect, auto-subscribe off ----

  it("case 6: after a signal reconnect and after a full reconnect of the worker's connection, the allowed track still flows", async () => {
    const room = newRoom();
    const gen = newGen();
    await (await publisher(room, ROLE, gen)).publish();
    const l = listen(new Map([[ROLE, room]]));
    l.ingest.setAllowed(allow(gen));
    await grows(() => l.count(ROLE, gen), 50);
    const [raw] = l.raw();
    let reconnected = 0;
    raw!.on(rtcNode.RoomEvent.Reconnected, () => { reconnected++; });
    await raw!.simulateScenario(rtcNode.SimulateScenarioKind.SIMULATE_SIGNAL_RECONNECT);
    await grows(() => l.count(ROLE, gen), 100, 60_000);
    await raw!.simulateScenario(rtcNode.SimulateScenarioKind.SIMULATE_NODE_FAILURE);
    await vi.waitFor(() => expect(reconnected).toBeGreaterThanOrEqual(1), { timeout: 60_000 });
    await grows(() => l.count(ROLE, gen), 100, 60_000);
    expect(l.statuses).toEqual(["connected"]);
    expect(l.outcome()).toBe("pending");
  });

  it.skipIf(!process.env.LIVEKIT_LIVE_BLIP)("case 6: a real network blip (the server frozen for about 20 s) is survived and the allowed track flows again", async () => {
    const room = newRoom();
    const gen = newGen();
    await (await publisher(room, ROLE, gen)).publish();
    const l = listen(new Map([[ROLE, room]]));
    l.ingest.setAllowed(allow(gen));
    await grows(() => l.count(ROLE, gen), 50);
    await runCmd(process.env.LIVEKIT_LIVE_BLIP);
    await grows(() => l.count(ROLE, gen), 100, 90_000);
    expect(l.outcome()).toBe("pending");
    expect(l.statuses).toEqual(["connected"]);
  });

  it.skipIf(!LONG || !process.env.LIVEKIT_LIVE_BLIP)("case 6: worker and publisher survive more than 10 minutes and a blip after the 600 s tokens expired", async () => {
    const room = newRoom();
    const gen = newGen();
    const p = await publisher(room, ROLE, gen);
    await p.publish();
    const l = listen(new Map([[ROLE, room]]));
    l.ingest.setAllowed(allow(gen));
    await grows(() => l.count(ROLE, gen), 50);
    const end = Date.now() + 11 * 60_000; // past the 600 s TTL of both tokens
    while (Date.now() < end) await grows(() => l.count(ROLE, gen), 500, 60_000); // 10 s of audio at a time, never stalled
    await runCmd(process.env.LIVEKIT_LIVE_BLIP);
    await grows(() => l.count(ROLE, gen), 100, 120_000);
    expect(l.outcome()).toBe("pending");
    expect(l.statuses).toEqual(["connected"]);
    expect(await admin.listParticipants(room)).toContain(lk.participantIdentity(ROLE, gen));
  }, 20 * 60_000);

  // ---- case 10 ----

  it("case 10: a join to a URL nothing listens on, or to a socket that never answers, fails within a bounded time", async () => {
    const port = rtc.createRtcRoomPort();
    const token = await workerToken(newRoom());
    const t0 = Date.now();
    await expect(within(port.open(`ws://127.0.0.1:${await closedPort()}`, token), 60_000, "a join to a closed port")).rejects.toThrow("the LiveKit room could not be joined");
    const closedMs = Date.now() - t0;
    const sockets: net.Socket[] = [];
    const hole = net.createServer((s) => { sockets.push(s); }); // accepts, never answers
    await new Promise<void>((r) => hole.listen(0, "127.0.0.1", r));
    later(async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => hole.close(() => r())); });
    const t1 = Date.now();
    await expect(within(port.open(`ws://127.0.0.1:${(hole.address() as net.AddressInfo).port}`, token), 90_000, "a join to a silent socket")).rejects.toThrow("the LiveKit room could not be joined");
    console.log(`case 10 timings (ms): closed port ${closedMs}, silent socket ${Date.now() - t1}`);
  });

  // ---- the forked worker (main.ts): cases 5, 7, 8 and 9 ----

  type Child = {
    child: ChildProcess; messages: { type: string; [k: string]: unknown }[]; output: () => string; exited: Promise<number | null>;
    tokens: string[]; rooms: string[]; requests: () => number;
  };
  /** Forks the real worker with SPEECH_INGEST=livekit; this test plays control: every livekit_token_request gets a fresh livekit_join. */
  const startChild = async (room: string, o: { url?: string; token?: () => Promise<string> } = {}): Promise<Child> => {
    const script = path.join(dir, `script-${hex(4)}.json`);
    await writeFile(script, JSON.stringify({ [ROLE]: Array.from({ length: 200 }, (_, i) => `Live line ${i + 1}.`) }));
    let out = "";
    const child = fork(ENTRY, [], {
      execArgv: ["--import", "tsx"], cwd: PKG, stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { PATH: process.env.PATH, STT_PROVIDER: "fake", STT_FAKE_SCRIPT: script, SPEECH_INGEST: "livekit", SPEECH_INGEST_ROLES: ROLE },
    });
    child.stdout!.on("data", (b: Buffer) => { out += b.toString(); });
    child.stderr!.on("data", (b: Buffer) => { out += b.toString(); });
    const messages: Child["messages"] = [];
    const tokens: string[] = [];
    let requests = 0;
    child.on("message", (m: { type: string; roleId?: string }) => {
      messages.push(m);
      if (m.type === "livekit_token_request" && m.roleId === ROLE) {
        requests++;
        void (o.token ?? (() => workerToken(room)))().then((token) => {
          tokens.push(token);
          if (child.connected) child.send({ type: "livekit_join", roleId: ROLE, url: o.url ?? env.url, token, room });
        });
      }
    });
    const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
    later(async () => { child.kill("SIGKILL"); await exited; });
    await vi.waitFor(() => expect(messages.some((m) => m.type === "worker_ready")).toBe(true), { timeout: 60_000 });
    return { child, messages, output: () => out, exited, tokens, rooms: [room], requests: () => requests };
  };
  const recording = (gen: string, on = true) => ({ type: "voice_state", paused: false, ended: false, holders: [{ roleId: ROLE, participantId: "p-live-1", recording: on, voiceChosen: true, generation: gen }] });
  const statusesOf = (c: Child) => c.messages.filter((m) => m.type === "livekit_status").map((m) => m.state as string);
  /** Case 9: nothing secret or identifying in what the worker and rtc-node's native core wrote. */
  const expectClean = (c: Child, extra: string[] = []): void => {
    const text = c.output();
    const secrets = [env.apiKey, env.apiSecret, env.url, env.host.host, ...c.rooms, ...c.tokens, ...c.tokens.map((t) => t.split(".")[1]!), ...extra];
    for (const s of secrets) expect(text.includes(s), `a value of length ${s.length} appears in the worker's output`).toBe(false);
    expect(text).not.toContain(`${ROLE}.g`);
    expect(text).not.toContain(lk.WORKER_IDENTITY_PREFIX);
    expect(text.toLowerCase()).not.toContain("lk-rtc");
  };

  it("cases 5 and 9: the forked worker records a live seat, writes nothing identifying, and its identity lingers after a SIGKILL until the server drops it", async () => {
    const room = newRoom();
    const gen = newGen();
    const p = await publisher(room, ROLE, gen);
    await p.publish();
    const w = await startChild(room);
    w.child.send(recording(gen));
    await vi.waitFor(() => expect(w.messages.some((m) => m.type === "voice_line" && m.roleId === ROLE)).toBe(true), { timeout: 60_000 });
    expect(statusesOf(w)).toEqual(["connected"]);
    expect((await admin.listParticipants(room)).filter((i) => i.startsWith(lk.WORKER_IDENTITY_PREFIX)).length).toBe(1);
    expectClean(w, [lk.participantIdentity(ROLE, gen), "p-live-1"]);
    w.child.kill("SIGKILL");
    await w.exited;
    const t0 = Date.now();
    const lingering = (await admin.listParticipants(room)).filter((i) => i.startsWith(lk.WORKER_IDENTITY_PREFIX)).length;
    await vi.waitFor(async () => expect((await admin.listParticipants(room)).filter((i) => i.startsWith(lk.WORKER_IDENTITY_PREFIX)).length).toBe(0), { timeout: 120_000, interval: 1_000 });
    console.log(`case 5: a SIGKILLed worker was listed ${lingering ? "still" : "no longer"} right after the kill and was gone after about ${Math.round((Date.now() - t0) / 1000)} s`);
  });

  it("case 9: at a connect failure (closed port, then a token signed with another secret) the worker exits 3 and writes nothing identifying", async () => {
    const room = newRoom();
    const closed = `ws://127.0.0.1:${await closedPort()}`;
    const w1 = await startChild(room, { url: closed });
    w1.child.send(recording(newGen()));
    expect(await within(w1.exited, 90_000, "the worker's exit")).toBe(3);
    expect(statusesOf(w1)).toEqual(["failed"]);
    expectClean(w1, [closed]);
    const forged = (): Promise<string> => Promise.resolve(customToken(lk.workerIdentity(hex(4)), { room, roomJoin: true, canSubscribe: true, hidden: true }, hex(32)));
    const w2 = await startChild(room, { token: forged });
    w2.child.send(recording(newGen()));
    expect(await within(w2.exited, 90_000, "the worker's exit")).toBe(3);
    expect(statusesOf(w2)).toEqual(["failed"]);
    expectClean(w2);
  });

  it("case 8: at the session end control sends ended, then deletes the seat rooms: the open segment is still flushed, and the worker does not exit 3", async () => {
    const room = newRoom();
    const gen = newGen();
    const p = await publisher(room, ROLE, gen);
    p.setTone({ onMs: 1_500, offMs: 1_500 }); // speech bursts: each opens a segment the hangover then closes
    await p.publish();
    const w = await startChild(room);
    w.child.send(recording(gen));
    await vi.waitFor(() => expect(w.messages.some((m) => m.type === "voice_line")).toBe(true), { timeout: 60_000 });
    // Wait until a segment is open again (speech started after the last line), then end as VoiceHost.end does: ended first, then
    // deleteRoom (async; review finding on case 8: the old order, deleteRoom first, was a race the IPC message happened to win).
    const lines = () => w.messages.filter((m) => m.type === "voice_line" || m.type === "segment_failed").length;
    const before = lines();
    const activeEdges = () => w.messages.filter((m) => m.type === "speech_activity" && m.active === true).length;
    await grows(activeEdges, 1, 30_000);
    // The burst lasts 1.5 s: let the open segment gather more than the segmenter's minSpeechMs (300 ms) of live audio first.
    await new Promise((r) => setTimeout(r, 800));
    const atEnd = lines();
    w.child.send({ type: "voice_state", paused: false, ended: true, holders: [{ roleId: ROLE, participantId: "p-live-1", recording: true, voiceChosen: true, generation: gen }] });
    void admin.deleteRoom(room);
    await vi.waitFor(() => expect(lines()).toBeGreaterThan(atEnd), { timeout: 60_000 }); // the open segment was flushed
    await quiet();
    expect(before).toBeGreaterThan(0);
    expect(statusesOf(w)).toEqual(["connected"]); // never `disconnected`: the ended state arrived first
    w.child.disconnect();
    expect(await within(w.exited, 30_000, "the worker's exit")).toBe(0);
    expectClean(w, [lk.participantIdentity(ROLE, gen)]);
  });

  it.skipIf(!process.env.LIVEKIT_LIVE_STOP || !process.env.LIVEKIT_LIVE_START)("case 7: LiveKit going away while the seat records makes the worker exit 3", async () => {
    const room = newRoom();
    const gen = newGen();
    const p = await publisher(room, ROLE, gen);
    await p.publish();
    const w = await startChild(room);
    w.child.send(recording(gen));
    await vi.waitFor(() => expect(statusesOf(w)).toEqual(["connected"]), { timeout: 60_000 });
    await runCmd(process.env.LIVEKIT_LIVE_STOP);
    try {
      expect(await within(w.exited, 120_000, "the worker's exit")).toBe(3);
      expect(statusesOf(w)).toEqual(["connected", "disconnected"]);
      expectClean(w, [lk.participantIdentity(ROLE, gen)]);
    } finally { await runCmd(process.env.LIVEKIT_LIVE_START); }
  }, 300_000);

  it.skipIf(!process.env.LIVEKIT_LIVE_RESTART)("case 7: a LiveKit restart while the seat does not record is quiet, and the seat room is joined again when it records", async () => {
    const room = newRoom();
    const gen = newGen();
    const w = await startChild(room);
    w.child.send(recording(gen));
    await vi.waitFor(() => expect(statusesOf(w)).toEqual(["connected"]), { timeout: 60_000 });
    w.child.send(recording(gen, false)); // muted: not allowed; the connection is kept
    await runCmd(process.env.LIVEKIT_LIVE_RESTART);
    await quiet(15_000);
    expect(w.child.exitCode).toBeNull();
    expect(statusesOf(w)).toEqual(["connected"]);
    const p = await publisher(room, ROLE, gen);
    await p.publish();
    const asked = w.requests();
    w.child.send(recording(gen));
    await vi.waitFor(() => expect(w.messages.some((m) => m.type === "voice_line")).toBe(true), { timeout: 90_000 });
    console.log(`case 7: token requests after the restart: ${w.requests() - asked}; statuses: ${statusesOf(w).join(",")}`);
    expect(w.child.exitCode).toBeNull();
    expectClean(w, [lk.participantIdentity(ROLE, gen)]);
  }, 300_000);
});

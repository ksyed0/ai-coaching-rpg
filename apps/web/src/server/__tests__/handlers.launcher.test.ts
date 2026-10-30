import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { Config } from "../config";
import { setEnvelopeClock } from "../envelope";
import {
  COOKIE_NAME,
  handleJoin,
  handleStream,
  SIGNED_OUT_MESSAGE,
  type Deps,
} from "../handlers";
import {
  LauncherError,
  type LauncherClient,
  type SessionInfo,
} from "../launcher-client";
import { RuntimeConnection } from "../runtime-connection";
import { seal } from "../seal";
import { StreamHub, type SessionCookie } from "../stream-hub";
import { JoinThrottle } from "../throttle";
import type { JoinedFrame } from "../wire";
import { fakeRuntime, manualTimers, sseReader, until } from "./fakes";

// join and stream with LAUNCHER_URL set: the session's own runtime is looked up through the control service on every request.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ORIGIN = "https://play.example.org";
const KEYS: Config["cookieKeys"] = [{ id: "k1", key: Buffer.alloc(32, 7) }];
const ADDR = "198.51.100.7";
const CRED = "0123456789abcdef0123456789abcdef";
const T0 = 1_900_000_000_000;
const LAUNCHER_URL = "http://127.0.0.1:47123";
const SID = "s-0123456789abcdef";

const send = (ws: WebSocket, m: unknown) => ws.send(JSON.stringify(m));
const state = {
  lastSeq: 5,
  status: "lobby",
  paused: false,
  pausedSince: null,
  currentScene: null,
  transcript: [],
} as unknown as JoinedFrame["state"];
const joinedFrame = (o: Partial<JoinedFrame> = {}): JoinedFrame => ({
  type: "joined",
  roleId: "delivery_lead",
  state,
  logIdentity: "log-1",
  credential: CRED,
  consent: { noticeVersion: "v1", notice: "n", given: false },
  replay: { afterSeq: 0, toSeq: 5, events: 0, complete: true },
  ...o,
});

let rt: Awaited<ReturnType<typeof fakeRuntime>>;
let script: (ws: WebSocket, m: any) => void;
let stops: (() => unknown)[] = [];
beforeEach(async () => {
  setEnvelopeClock(() => new Date(T0));
  script = (ws, m) => {
    if (m.type === "join") send(ws, joinedFrame());
  };
  rt = await fakeRuntime((ws, m) => script(ws, m));
  stops.push(() => rt.stop());
});
afterEach(async () => {
  setEnvelopeClock(() => new Date());
  for (const s of stops.reverse()) await s();
  stops = [];
});

function makeDeps(session: (id: string) => Promise<SessionInfo>) {
  const timers = manualTimers();
  const hub = new StreamHub({
    maxStreams: 10,
    maxStreamsPerSession: 10,
    maxStreamsPerAddress: 10,
    setTimer: timers.setTimer,
    now: () => T0,
  });
  const connect = vi.fn((url: string, address: string | null) =>
    RuntimeConnection.connect(url, address),
  );
  const sessionFn = vi.fn(session);
  const config: Config = {
    runtimeUrl: "",
    publicOrigin: ORIGIN,
    cookieKeys: KEYS,
    cookieMaxAgeHours: 12,
    maxStreams: 10,
    maxStreamsPerSession: 10,
    maxStreamsPerAddress: 10,
    launcherUrl: LAUNCHER_URL,
    launcherToken: "t".repeat(32),
  };
  const throttle = () =>
    new JoinThrottle({
      max: 5,
      windowMs: 60_000,
      blockMs: 60_000,
      now: () => T0,
    });
  const deps: Deps = {
    config,
    now: () => T0,
    connect: connect as unknown as Deps["connect"],
    joinThrottle: throttle(),
    consoleThrottle: throttle(),
    hub,
    launcher: { session: sessionFn } as unknown as LauncherClient,
  };
  return { deps, connect, session: sessionFn };
}
const running =
  () =>
  async (id: string): Promise<SessionInfo> => ({
    sessionId: id,
    scenarioId: "x",
    status: "running",
    port: Number(new URL(rt.url).port),
  });

const guarded = {
  Origin: ORIGIN,
  "X-Requested-With": "scenecoach",
  "Content-Type": "application/json",
};
const joinReq = (sessionId = SID) =>
  new Request(`${ORIGIN}/api/v1/join`, {
    method: "POST",
    headers: { ...guarded, "X-Forwarded-For": ADDR },
    body: JSON.stringify({
      sessionId,
      role: "delivery_lead",
      joinCode: "abcd - efgh",
      displayName: "Ann",
    }),
  });
const cookie = (o: Partial<SessionCookie> = {}) =>
  seal(
    {
      sessionId: SID,
      roleId: "delivery_lead",
      participantId: "p-1",
      credential: CRED,
      logIdentity: "log-1",
      expiresAt: T0 + 12 * 3_600_000,
      ...o,
    },
    KEYS,
    T0,
  );
const streamReq = (c: string) =>
  new Request(`${ORIGIN}/api/v1/stream?session=${SID}`, {
    headers: {
      Accept: "text/event-stream",
      "Sec-Fetch-Site": "same-origin",
      "X-Forwarded-For": ADDR,
      Cookie: `${COOKIE_NAME}=${c}`,
    },
  });

describe("join with a launcher", () => {
  it("connects to the session's own runtime, looked up by session id, and sets the cookie", async () => {
    const { deps, connect, session } = makeDeps(running());
    const res = await handleJoin(joinReq(), deps);
    expect(res.status).toBe(200);
    expect(session).toHaveBeenCalledWith(SID);
    expect(connect).toHaveBeenCalledWith(
      `ws://127.0.0.1:${new URL(rt.url).port}`,
      ADDR,
    );
    expect(res.headers.get("Set-Cookie")).toContain(`${COOKIE_NAME}=`);
  });

  it("a stopped, ended or unknown session is the neutral join refusal, with no runtime contact and no throttle charge", async () => {
    for (const lookup of [
      async (id: string): Promise<SessionInfo> => ({
        sessionId: id,
        scenarioId: "x",
        status: "stopped",
      }),
      async (id: string): Promise<SessionInfo> => ({
        sessionId: id,
        scenarioId: "x",
        status: "ended",
      }),
      async (): Promise<SessionInfo> => {
        throw new LauncherError("not_found");
      },
    ]) {
      const { deps, connect } = makeDeps(lookup);
      const res = await handleJoin(joinReq(), deps);
      expect(res.status).toBe(401);
      expect(
        ((await res.json()) as { error: { code: string } }).error.code,
      ).toBe("join_refused");
      expect(connect).not.toHaveBeenCalled();
      expect(deps.joinThrottle.blockedForMs(ADDR, "delivery_lead")).toBe(0);
    }
  });

  it("a launcher failure is 503 unavailable and the answer never leaks the launcher URL, its port or the token", async () => {
    for (const reason of [
      "unavailable",
      "timeout",
      "unauthorized",
      "failed",
    ] as const) {
      const { deps, connect } = makeDeps(async () => {
        throw new LauncherError(reason);
      });
      const res = await handleJoin(joinReq(), deps);
      const text = await res.text();
      expect(res.status).toBe(503);
      expect(JSON.parse(text).error.code).toBe("unavailable");
      for (const secret of [LAUNCHER_URL, "47123", "t".repeat(32), "127.0.0.1"])
        expect(text).not.toContain(secret);
      expect(connect).not.toHaveBeenCalled();
    }
  });

  it("a session id that is not valid never reaches the launcher", async () => {
    const { deps, session } = makeDeps(running());
    const res = await handleJoin(joinReq("../etc"), deps);
    expect(res.status).toBe(401);
    expect(session).not.toHaveBeenCalled();
  });
});

describe("stream with a launcher", () => {
  it("connects to the session's own runtime", async () => {
    const { deps, connect } = makeDeps(running());
    const res = await handleStream(streamReq(cookie()), deps);
    const r = sseReader(res);
    stops.push(() => r.cancel());
    await until(() => r.frames().some((f) => f.event === "joined"));
    expect(connect).toHaveBeenCalledWith(
      `ws://127.0.0.1:${new URL(rt.url).port}`,
      ADDR,
    );
  });

  it("a stopped session, an unknown one and an unreachable launcher all tell the browser to reconnect", async () => {
    for (const lookup of [
      async (id: string): Promise<SessionInfo> => ({
        sessionId: id,
        scenarioId: "x",
        status: "stopped",
      }),
      async (): Promise<SessionInfo> => {
        throw new LauncherError("not_found");
      },
      async (): Promise<SessionInfo> => {
        throw new LauncherError("unavailable");
      },
    ]) {
      const { deps, connect } = makeDeps(lookup);
      const res = await handleStream(streamReq(cookie()), deps);
      const r = sseReader(res);
      await r.finished;
      expect(r.frames()).toEqual([
        { event: "retry:3000" },
        { event: "reconnecting", data: {} },
      ]);
      expect(connect).not.toHaveBeenCalled();
    }
  });

  it("a 4002 close during the join (a reissued code) is signed_out with a cleared cookie, never reconnecting", async () => {
    script = (ws) => ws.close(4002, "reissued");
    const { deps } = makeDeps(running());
    const res = await handleStream(streamReq(cookie()), deps);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
    const r = sseReader(res);
    await r.finished;
    expect(r.frames().at(-1)).toEqual({
      event: "signed_out",
      data: { message: SIGNED_OUT_MESSAGE },
    });
    expect(r.text()).not.toContain("reconnecting");
  });

  it("a 4002 close of a live stream ends it with signed_out and no reconnecting", async () => {
    const { deps } = makeDeps(running());
    const res = await handleStream(streamReq(cookie()), deps);
    const r = sseReader(res);
    await until(() => r.frames().some((f) => f.event === "joined"));
    rt.sockets[0]!.close(4002, "reissued");
    await r.finished;
    expect(r.frames().at(-1)).toEqual({
      event: "signed_out",
      data: { message: SIGNED_OUT_MESSAGE },
    });
    expect(r.text()).not.toContain("reconnecting");
  });
});

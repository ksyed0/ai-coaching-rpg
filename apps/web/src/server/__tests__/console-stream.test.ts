import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config";
import { CONSOLE_COOKIE, secretEpoch } from "../console-session";
import { handleConsoleStream } from "../console-stream";
import { setEnvelopeClock } from "../envelope";
import { FACILITATOR_FORWARD_KEY, FacilitatorBudget, LIVE_TABS_PER_SESSION } from "../facilitator-budget";
import { FacilitatorHub } from "../facilitator-hub";
import { COOKIE_NAME, type Deps } from "../handlers";
import { LauncherError } from "../launcher-client";
import { route } from "../routes";
import { seal } from "../seal";
import { realTimer } from "../runtime-connection";
import { FakeConn, manualTimers, parseSse, sseReader, until } from "./fakes";

const ORIGIN = "https://play.example.org";
const KEYS: Config["cookieKeys"] = [{ id: "k1", key: Buffer.alloc(32, 7) }];
const SECRET = "correct horse battery staple";
const T0 = 1_900_000_000_000;
const SID = "s-0123456789abcdef";
const BUSY_MESSAGE = "This session is open in too many console tabs. Close one, then reload this page.";

const config: Config = {
  runtimeUrl: "ws://127.0.0.1:1", publicOrigin: ORIGIN, cookieKeys: KEYS, cookieMaxAgeHours: 12, maxStreams: 10, maxStreamsPerSession: 10,
  maxStreamsPerAddress: 10, facilitatorSecret: SECRET, launcherUrl: "http://127.0.0.1:47123", launcherToken: "launcher-token-" + "t".repeat(20),
};
const consoleCookie = (expiresAt = T0 + 3_600_000, secret = SECRET) =>
  `${CONSOLE_COOKIE}=${seal({ name: "Ann Lee", epoch: secretEpoch(secret), expiresAt }, KEYS, T0, "fac")}`;
const playerCookie = () =>
  `${COOKIE_NAME}=${seal({ sessionId: SID, roleId: "r", participantId: "p", credential: "c", logIdentity: "l", expiresAt: T0 + 3_600_000 }, KEYS, T0)}`;

/** A facilitator connection whose join answers like the runtime's (FakeConn plus joinFacilitator). */
class FacConn extends FakeConn {
  joins: { sessionId: string; token: string; lastSeq?: number }[] = [];
  async joinFacilitator(sessionId: string, token: string, o: { lastSeq?: number } = {}) {
    this.joins.push({ sessionId, token, ...(o.lastSeq !== undefined && { lastSeq: o.lastSeq }) });
    return {
      frame: { type: "joined" as const, roleId: "facilitator", scenes: [], replay: { afterSeq: 0, toSeq: 0, events: 0, complete: true }, state: { status: "running", lastSeq: 0 } as never },
      roster: [], status: "running" as const,
    };
  }
  override close() { super.close(); queueMicrotask(() => this.drop(1000)); }
}

let launcher: { session: ReturnType<typeof vi.fn>; facilitator: ReturnType<typeof vi.fn> };
let conns: FacConn[];
let forwarded: string[];
let connect: ReturnType<typeof vi.fn>;
let deps: Deps;
let clock: number;
let open: SseReaderLike[];
type SseReaderLike = ReturnType<typeof sseReader>;

beforeEach(() => {
  setEnvelopeClock(() => new Date(T0));
  clock = T0;
  conns = []; forwarded = []; open = [];
  launcher = {
    session: vi.fn(async () => ({ sessionId: SID, scenarioId: "pitch", status: "running", port: 1 })),
    facilitator: vi.fn(async () => ({ port: 43_211, token: "facilitator-token-" + "f".repeat(20) })),
  };
  connect = vi.fn(async (_url: string, xff: string) => { forwarded.push(xff); const c = new FacConn(); conns.push(c); return c; });
  const timers = manualTimers();
  deps = {
    config, now: () => clock, connect: connect as unknown as Deps["connect"], launcher: launcher as never,
    facilitatorBudget: new FacilitatorBudget(), facilitatorHub: new FacilitatorHub({ setTimer: timers.setTimer, now: () => clock }), setTimer: timers.setTimer,
  } as unknown as Deps;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  for (const r of open) { await r.cancel().catch(() => {}); }
  vi.restoreAllMocks();
  setEnvelopeClock(() => new Date());
});

const req = (o: { cookie?: string | null; headers?: Record<string, string | null>; id?: string; signal?: AbortSignal } = {}) => {
  const headers: Record<string, string> = { Accept: "text/event-stream", "Sec-Fetch-Site": "same-origin" };
  const cookie = o.cookie === undefined ? consoleCookie() : o.cookie;
  if (cookie !== null) headers.Cookie = cookie;
  for (const [k, v] of Object.entries(o.headers ?? {})) { if (v === null) delete headers[k]; else headers[k] = v; }
  return new Request(`${ORIGIN}/api/v1/console/sessions/${o.id ?? SID}/stream`, { headers, signal: o.signal });
};
const stream = (o: Parameters<typeof req>[0] = {}) => handleConsoleStream(req(o), deps);
const finalOf = async (res: Response) => parseSse(await res.text()).filter((f) => f.event !== undefined && !f.event.startsWith("retry:"));
async function live(o: Parameters<typeof req>[0] = {}) {
  const res = await stream(o);
  expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  const r = sseReader(res);
  open.push(r);
  await until(() => r.frames().some((f) => f.event === "roster"), { what: "the roster frame" });
  return { res, r };
}

describe("GET /api/v1/console/sessions/:id/stream", () => {
  it("a player cookie alone is 401 and neither the launcher nor the runtime is contacted", async () => {
    const res = await stream({ cookie: playerCookie() });
    expect(res.status).toBe(401);
    expect(launcher.session).not.toHaveBeenCalled();
    expect(launcher.facilitator).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("a player cookie value under the console cookie name is 401 and cleared", async () => {
    const value = playerCookie().split("=")[1]!;
    const res = await stream({ cookie: `${CONSOLE_COOKIE}=${value}` });
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(connect).not.toHaveBeenCalled();
  });

  it("a cookie from before a FACILITATOR_SECRET change is 401", async () => {
    const res = await stream({ cookie: consoleCookie(T0 + 3_600_000, "an older secret entirely") });
    expect(res.status).toBe(401);
    expect(connect).not.toHaveBeenCalled();
  });

  it("a reconnect with an expired console cookie is 401 (every request checks)", async () => {
    const cookie = consoleCookie(T0 + 1_000);
    const first = await live({ cookie });
    expect(first.res.status).toBe(200);
    clock += 2_000;
    const again = await stream({ cookie, headers: { "Last-Event-ID": "5" } });
    expect(again.status).toBe(401);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("Last-Event-ID 41 joins with lastSeq 41; absent or \"abc\" joins with lastSeq 0", async () => {
    await live({ headers: { "Last-Event-ID": "41" } });
    await live({ headers: { "Last-Event-ID": "abc" } });
    await live();
    expect(conns.map((c) => c.joins[0]!.lastSeq ?? 0)).toEqual([41, 0, 0]);
  });

  it("Sec-Fetch-Site cross-site and a foreign Origin are 403; no Origin is accepted; no text/event-stream Accept is 406", async () => {
    for (const headers of ([{ "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }, { Origin: "https://evil.example" }] as Record<string, string>[])) {
      expect((await stream({ headers })).status, JSON.stringify(headers)).toBe(403);
    }
    expect((await stream({ headers: { Accept: "application/json" } })).status).toBe(406);
    expect((await stream({ headers: { Accept: null } })).status).toBe(406);
    expect(connect).not.toHaveBeenCalled();
    expect((await stream({ headers: { Origin: ORIGIN } })).status).toBe(200);
    const { res } = await live();
    expect(res.status).toBe(200);
  });

  it("console disabled is 503, a malformed session id 404, and no launcher the 502 launcher_unavailable envelope", async () => {
    expect((await stream({ id: "..%2f" })).status).toBe(404);
    expect((await stream({ id: "has%20space" })).status).toBe(404);
    const noLauncher = await handleConsoleStream(req(), { ...deps, launcher: undefined } as Deps);
    expect(noLauncher.status).toBe(502);
    expect((await noLauncher.json()).error.code).toBe("launcher_unavailable");
    const off = await handleConsoleStream(req(), { ...deps, config: { ...config, facilitatorSecret: undefined } } as Deps);
    expect(off.status).toBe(503);
  });

  it("ended, stopped, unknown and unreachable launcher answers give ended, stopped, 404 and reconnecting", async () => {
    launcher.session.mockResolvedValueOnce({ sessionId: SID, scenarioId: "p", status: "ended" });
    expect((await finalOf(await stream())).map((f) => f.event)).toEqual(["ended"]);
    launcher.session.mockResolvedValueOnce({ sessionId: SID, scenarioId: "p", status: "stopped" });
    expect((await finalOf(await stream())).map((f) => f.event)).toEqual(["stopped"]);
    launcher.session.mockRejectedValueOnce(new LauncherError("not_found"));
    const unknown = await stream();
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.code).toBe("not_found");
    launcher.session.mockRejectedValueOnce(new LauncherError("unavailable"));
    expect((await finalOf(await stream())).map((f) => f.event)).toEqual(["reconnecting"]);
    expect(connect).not.toHaveBeenCalled();
  });

  it("a runtime that cannot be reached gives reconnecting", async () => {
    connect.mockRejectedValueOnce(new Error("refused"));
    expect((await finalOf(await stream())).map((f) => f.event)).toEqual(["reconnecting"]);
  });

  it("a fifth live tab of one session gets busy with its message and opens no socket", async () => {
    for (let i = 0; i < LIVE_TABS_PER_SESSION; i++) await live();
    const before = connect.mock.calls.length;
    const launcherBefore = launcher.facilitator.mock.calls.length;
    const fifth = await finalOf(await stream());
    expect(fifth).toEqual([{ event: "busy", data: { message: BUSY_MESSAGE } }]);
    expect(connect.mock.calls.length).toBe(before);
    expect(launcher.facilitator.mock.calls.length).toBe(launcherBefore);
  });

  it("the runtime sees X-Forwarded-For scenecoach-console whatever the request sent (a forged single value, a list, none)", async () => {
    await live({ headers: { "X-Forwarded-For": "198.51.100.7" } });
    await live({ headers: { "X-Forwarded-For": "6.6.6.6, 198.51.100.7" } });
    await live();
    expect(forwarded).toEqual([FACILITATOR_FORWARD_KEY, FACILITATOR_FORWARD_KEY, FACILITATOR_FORWARD_KEY]);
    expect(FACILITATOR_FORWARD_KEY).toBe("scenecoach-console");
  });

  it("responses carry X-Robots-Tag noindex, nofollow and Cache-Control no-store, no-transform", async () => {
    const { res } = await live();
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(res.headers.get("Cache-Control")).toBe("no-store, no-transform");
    const final = await stream({ id: SID, headers: { Accept: "text/event-stream" } });
    expect(final.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("an aborted request closes the socket and frees the live slot", async () => {
    const ac = new AbortController();
    await live({ signal: ac.signal });
    ac.abort();
    await until(() => conns[0]!.closed > 0, { what: "the socket close" });
    await until(() => deps.facilitatorHub.size() === 0, { what: "the hub stream to end" });
    await until(() => deps.facilitatorBudget.inUse(SID, "live") === 0, { what: "the slot to free" });
  });

  it("a request already aborted while the socket was joining closes the socket and opens no stream", async () => {
    const ac = new AbortController();
    launcher.facilitator.mockImplementationOnce(async () => { ac.abort(); return { port: 1, token: "t".repeat(24) }; });
    const res = await stream({ signal: ac.signal });
    await res.text().catch(() => {});
    expect(conns[0]!.closed).toBeGreaterThan(0);
    expect(deps.facilitatorHub.size()).toBe(0);
  });

  it("a cookie that expires while the socket is joining closes the socket and ends with expired", async () => {
    launcher.facilitator.mockImplementationOnce(async () => { clock += 10_000; return { port: 1, token: "t".repeat(24) }; });
    const res = await stream({ cookie: consoleCookie(T0 + 5_000) });
    expect((await finalOf(res)).map((f) => f.event)).toEqual(["expired"]);
    expect(conns[0]!.closed).toBeGreaterThan(0);
    expect(deps.facilitatorHub.size()).toBe(0);
  });

  it("a cookie that expires while streaming ends the stream at the next heartbeat and closes the socket", async () => {
    const timers = manualTimers();
    deps = { ...deps, facilitatorHub: new FacilitatorHub({ setTimer: timers.setTimer, now: () => clock }) } as Deps;
    const { r } = await live({ cookie: consoleCookie(T0 + 5_000) });
    clock += 10_000;
    timers.fire(15_000);
    await until(() => r.frames().some((f) => f.event === "expired"), { what: "expired" });
    expect(conns[0]!.closed).toBeGreaterThan(0);
  });

  it("the route function maps the handler and is exported", () => {
    expect(typeof route(handleConsoleStream)).toBe("function");
  });
});

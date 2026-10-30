import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config";
import { CONSOLE_COOKIE, secretEpoch } from "../console-session";
import { setEnvelopeClock } from "../envelope";
import { COOKIE_NAME, type Deps } from "../handlers";
import { LauncherError, type LauncherReason } from "../launcher-client";
import {
  consoleReadinessGET,
  consoleReissueAllPOST,
  consoleReissuePOST,
  consoleRestartPOST,
  consoleScenariosGET,
  consoleSessionGET,
  consoleSessionsGET,
  consoleSessionsPOST,
  consoleStartPOST,
  route,
} from "../routes";
import { seal } from "../seal";
import type {
  ClientMessage,
  FacilitatorRosterEntry,
  ServerMessage,
} from "../wire";
import { manualTimers, until } from "./fakes";

const ORIGIN = "https://play.example.org";
const KEYS: Config["cookieKeys"] = [{ id: "k1", key: Buffer.alloc(32, 7) }];
const SECRET = "correct horse battery staple";
const T0 = 1_900_000_000_000;
const SID = "s-0123456789abcdef";
const LAUNCHER_URL = "http://127.0.0.1:47123";
const LAUNCHER_TOKEN = "launcher-token-" + "t".repeat(20);
const FAC_TOKEN = "facilitator-token-" + "f".repeat(20);
const PORT = 43_211;
const CODE_A = "AAAA-1111-aaaa";
const CODE_B = "BBBB-2222-bbbb";
const CODE_NEW = "NEWC-3333-cccc";
const NAME = "Ann Lee";

const config: Config = {
  runtimeUrl: "ws://127.0.0.1:1",
  publicOrigin: ORIGIN,
  cookieKeys: KEYS,
  cookieMaxAgeHours: 12,
  maxStreams: 10,
  maxStreamsPerSession: 10,
  maxStreamsPerAddress: 10,
  facilitatorSecret: SECRET,
  launcherUrl: LAUNCHER_URL,
  launcherToken: LAUNCHER_TOKEN,
};

const consoleCookie = (name = NAME) =>
  `${CONSOLE_COOKIE}=${seal({ name, epoch: secretEpoch(SECRET), expiresAt: T0 + 3_600_000 }, KEYS, T0, "fac")}`;
const playerCookie = () =>
  `${COOKIE_NAME}=${seal({ sessionId: SID, roleId: "r", participantId: "p", credential: "c", logIdentity: "l", expiresAt: T0 + 3_600_000 }, KEYS, T0)}`;

/** A scripted facilitator connection (what withFacilitatorSocket gets from Deps.connect). */
class FakeFacConn {
  sent: ClientMessage[] = [];
  closed = 0;
  joinedWith: { sessionId: string; token: string }[] = [];
  onSend: ((m: ClientMessage, c: FakeFacConn) => void) | null = null;
  private frames = new Set<(m: ServerMessage) => void>();
  private closes = new Set<(c: number) => void>();
  constructor(
    public roster: FacilitatorRosterEntry[],
    public status: "idle" | "running" | "ended" = "idle",
  ) {}
  async joinFacilitator(sessionId: string, token: string) {
    this.joinedWith.push({ sessionId, token });
    return { roster: this.roster, status: this.status };
  }
  send(m: ClientMessage) {
    this.sent.push(m);
    this.onSend?.(m, this);
  }
  onFrame(fn: (m: ServerMessage) => void) {
    this.frames.add(fn);
    return () => {
      this.frames.delete(fn);
    };
  }
  onClose(fn: (c: number) => void) {
    this.closes.add(fn);
    return () => {
      this.closes.delete(fn);
    };
  }
  close() {
    this.closed++;
  }
  emit(m: ServerMessage) {
    for (const f of [...this.frames]) f(m);
  }
  drop() {
    for (const f of [...this.closes]) f(1006);
  }
}

const seat = (
  roleId: string,
  joined: boolean,
  consented: boolean,
  name?: string,
): FacilitatorRosterEntry => ({
  roleId,
  joined,
  consented,
  connected: joined,
  ...(name !== undefined && { name }),
});

type Launcher = {
  scenarios: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
  sessions: ReturnType<typeof vi.fn>;
  session: ReturnType<typeof vi.fn>;
  facilitator: ReturnType<typeof vi.fn>;
  reissue: ReturnType<typeof vi.fn>;
  reissueAll: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
};
function fakeLauncher(): Launcher {
  return {
    scenarios: vi.fn(async () => [{ id: "pitch", title: "The pitch" }]),
    // Includes a port: the BFF must strip it.
    createSession: vi.fn(async () => ({
      sessionId: SID,
      status: "running",
      port: PORT,
      modelLabel: "mock",
      codes: [
        { roleId: "a", code: CODE_A },
        { roleId: "b", code: CODE_B },
      ],
    })),
    sessions: vi.fn(async () => [
      {
        sessionId: SID,
        scenarioId: "pitch",
        status: "running",
        port: PORT,
        modelLabel: "mock",
      },
    ]),
    session: vi.fn(async () => ({
      sessionId: SID,
      scenarioId: "pitch",
      status: "running",
      port: PORT,
      modelLabel: "mock",
    })),
    facilitator: vi.fn(async () => ({ port: PORT, token: FAC_TOKEN })),
    reissue: vi.fn(async () => CODE_NEW),
    reissueAll: vi.fn(async () => [
      { roleId: "a", code: CODE_NEW },
      { roleId: "b", code: CODE_NEW },
    ]),
    restart: vi.fn(async () => ({
      sessionId: SID,
      scenarioId: "pitch",
      status: "running",
      modelLabel: "mock",
      codes: [{ roleId: "a", code: CODE_NEW }],
    })),
  };
}

let launcher: Launcher;
let conn: FakeFacConn;
let connect: ReturnType<typeof vi.fn>;
let timers: ReturnType<typeof manualTimers>;
let deps: Deps;
let errors: string[];
let warns: string[];

beforeEach(() => {
  setEnvelopeClock(() => new Date(T0));
  launcher = fakeLauncher();
  conn = new FakeFacConn([
    seat("a", true, true, "Pat"),
    seat("b", true, true, "Sam"),
  ]);
  connect = vi.fn(async () => conn);
  timers = manualTimers();
  deps = {
    config,
    now: () => T0,
    connect: connect as unknown as Deps["connect"],
    launcher: launcher as never,
    setTimer: timers.setTimer,
  } as unknown as Deps;
  errors = [];
  warns = [];
  vi.spyOn(console, "error").mockImplementation((...a) => {
    errors.push(a.join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation((...a) => {
    warns.push(a.join(" "));
  });
  vi.spyOn(console, "log").mockImplementation((...a) => {
    warns.push(a.join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

// The routes under test, bound to this test's deps.
const bind = (h: (r: Request, d: Deps) => Promise<Response>) => (r: Request) =>
  h(r, deps);
async function api() {
  const m = await import("../console-sessions");
  return {
    scenarios: bind(m.handleConsoleScenarios),
    list: bind(m.handleConsoleSessionsList),
    create: bind(m.handleConsoleSessionsCreate),
    get: bind(m.handleConsoleSessionGet),
    readiness: bind(m.handleConsoleReadiness),
    start: bind(m.handleConsoleStart),
    reissue: bind(m.handleConsoleReissue),
    reissueAll: bind(m.handleConsoleReissueAll),
    restart: bind(m.handleConsoleRestart),
  };
}

const GUARDED = {
  Origin: ORIGIN,
  "X-Requested-With": "scenecoach",
  "Content-Type": "application/json",
};
const base = `${ORIGIN}/api/v1/console`;
const get = (path: string, cookie: string | null = consoleCookie()) =>
  new Request(`${base}${path}`, {
    headers: cookie === null ? {} : { Cookie: cookie },
  });
const post = (
  path: string,
  body: unknown = {},
  o: {
    cookie?: string | null;
    headers?: Record<string, string | null>;
    raw?: string;
  } = {},
) => {
  const headers: Record<string, string> = { ...GUARDED };
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    if (v === null) delete headers[k];
    else headers[k] = v;
  }
  const cookie = o.cookie === undefined ? consoleCookie() : o.cookie;
  if (cookie !== null) headers.Cookie = cookie;
  return new Request(`${base}${path}`, {
    method: "POST",
    headers,
    body: o.raw ?? JSON.stringify(body),
  });
};
const json = async (res: Response) =>
  (await res.json()) as {
    success: boolean;
    data: any;
    error: { code: string; message: string } | null;
  };

describe("console session API", () => {
  it("every route returns 401 without a console cookie and with a player cookie", async () => {
    const a = await api();
    const cases: [string, () => Request][] = [];
    for (const cookie of [null, playerCookie()]) {
      cases.push(["scenarios", () => get("/scenarios", cookie)]);
      cases.push(["list", () => get("/sessions", cookie)]);
      cases.push(["get", () => get(`/sessions/${SID}`, cookie)]);
      cases.push([
        "readiness",
        () => get(`/sessions/${SID}/readiness`, cookie),
      ]);
      cases.push([
        "create",
        () => post("/sessions", { scenarioId: "pitch" }, { cookie }),
      ]);
      cases.push([
        "start",
        () => post(`/sessions/${SID}/start`, {}, { cookie }),
      ]);
      cases.push([
        "reissue",
        () => post(`/sessions/${SID}/reissue`, { roleId: "a" }, { cookie }),
      ]);
      cases.push([
        "reissueAll",
        () => post(`/sessions/${SID}/reissue-all`, {}, { cookie }),
      ]);
      cases.push([
        "restart",
        () => post(`/sessions/${SID}/restart`, {}, { cookie }),
      ]);
    }
    for (const [name, make] of cases) {
      const res = await (
        a as Record<string, (r: Request) => Promise<Response>>
      )[name]!(make());
      expect(res.status, name).toBe(401);
      expect((await json(res)).error?.code, name).toBe("unauthorized");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
    for (const v of Object.values(launcher)) expect(v).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("a disabled console is 503 on every route", async () => {
    const a = await api();
    deps = {
      ...deps,
      config: { ...config, facilitatorSecret: undefined },
    } as Deps;
    expect((await a.list(get("/sessions"))).status).toBe(503);
    expect(
      (await a.create(post("/sessions", { scenarioId: "pitch" }))).status,
    ).toBe(503);
    expect(launcher.sessions).not.toHaveBeenCalled();
  });

  it("state-changing routes refuse a foreign Origin and a missing custom header (403) before touching the launcher", async () => {
    const a = await api();
    const targets: [string, string, unknown][] = [
      ["create", "/sessions", { scenarioId: "pitch" }],
      ["start", `/sessions/${SID}/start`, {}],
      ["reissue", `/sessions/${SID}/reissue`, { roleId: "a" }],
      ["reissueAll", `/sessions/${SID}/reissue-all`, {}],
      ["restart", `/sessions/${SID}/restart`, {}],
    ];
    const bads: Record<string, string | null>[] = [
      { Origin: "https://evil.example.com" },
      { Origin: null },
      { "X-Requested-With": null },
      { "Sec-Fetch-Site": "cross-site" },
    ];
    for (const [name, path, body] of targets)
      for (const headers of bads) {
        const res = await (
          a as Record<string, (r: Request) => Promise<Response>>
        )[name]!(post(path, body, { headers }));
        expect(res.status, `${name} ${JSON.stringify(headers)}`).toBe(403);
      }
    for (const v of Object.values(launcher)) expect(v).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("create returns codes once and a repeat GET never contains them", async () => {
    const a = await api();
    const res = await a.create(post("/sessions", { scenarioId: "pitch" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await json(res)).data).toEqual({
      sessionId: SID,
      modelLabel: "mock",
      codes: [
        { roleId: "a", code: CODE_A },
        { roleId: "b", code: CODE_B },
      ],
    });
    expect(launcher.createSession).toHaveBeenCalledWith("pitch");
    for (const r of [
      await a.get(get(`/sessions/${SID}`)),
      await a.list(get("/sessions")),
      await a.readiness(get(`/sessions/${SID}/readiness`)),
    ]) {
      const text = await r.text();
      expect(text).not.toContain(CODE_A);
      expect(text).not.toContain(CODE_B);
      expect(text).not.toContain("codes");
    }
  });

  it("create/GET responses never contain a port, a token or the launcher URL", async () => {
    const a = await api();
    const texts = [
      await (await a.create(post("/sessions", { scenarioId: "pitch" }))).text(),
      await (await a.get(get(`/sessions/${SID}`))).text(),
      await (await a.list(get("/sessions"))).text(),
      await (await a.scenarios(get("/scenarios"))).text(),
      await (await a.readiness(get(`/sessions/${SID}/readiness`))).text(),
      await (await a.restart(post(`/sessions/${SID}/restart`))).text(),
    ];
    for (const t of texts) {
      expect(t).not.toContain(String(PORT));
      expect(t).not.toContain("port");
      expect(t).not.toContain(FAC_TOKEN);
      expect(t).not.toContain(LAUNCHER_TOKEN);
      expect(t).not.toContain("127.0.0.1");
      expect(t).not.toContain(LAUNCHER_URL);
    }
    expect(JSON.parse(texts[1]!).data).toEqual({
      sessionId: SID,
      scenarioId: "pitch",
      status: "running",
      modelLabel: "mock",
    });
    expect(JSON.parse(texts[2]!).data).toEqual([
      {
        sessionId: SID,
        scenarioId: "pitch",
        status: "running",
        modelLabel: "mock",
      },
    ]);
    expect(JSON.parse(texts[3]!).data).toEqual([
      { id: "pitch", title: "The pitch" },
    ]);
  });

  it("create validates its body strictly", async () => {
    const a = await api();
    const bad = [
      post("/sessions", { scenarioId: "pitch", extra: 1 }),
      post("/sessions", {}),
      post("/sessions", { scenarioId: 5 }),
      post("/sessions", { scenarioId: "../etc" }),
      post("/sessions", { scenarioId: "Pitch" }),
      post("/sessions", {}, { raw: "[1]" }),
      post("/sessions", {}, { raw: "not json" }),
      post(
        "/sessions",
        { scenarioId: "pitch" },
        { headers: { "Content-Type": "text/plain" } },
      ),
      post("/sessions", { scenarioId: "pitch", pad: "x".repeat(2000) }),
    ];
    for (const r of bad) expect((await a.create(r)).status).toBe(400);
    expect(launcher.createSession).not.toHaveBeenCalled();
  });

  it("readiness canStart is false until every seat is joined and consented", async () => {
    const a = await api();
    const cases: [
      FacilitatorRosterEntry[],
      "idle" | "running" | "ended",
      boolean,
    ][] = [
      [[seat("a", true, true), seat("b", true, true)], "idle", true],
      [[seat("a", true, true), seat("b", true, false)], "idle", false],
      [[seat("a", true, true), seat("b", false, false)], "idle", false],
      [[], "idle", false],
      [[seat("a", true, true), seat("b", true, true)], "running", false],
    ];
    for (const [roster, status, canStart] of cases) {
      conn = new FakeFacConn(roster, status);
      const res = await a.readiness(get(`/sessions/${SID}/readiness`));
      expect(res.status).toBe(200);
      const d = (await json(res)).data;
      expect(d.canStart).toBe(canStart);
      expect(d.status).toBe(status);
      expect(d.launcherStatus).toBe("running");
      expect(d.modelLabel).toBe("mock");
      expect(conn.closed).toBe(1);
    }
    // A fresh pair is fetched together on each call, one socket per call.
    expect(launcher.facilitator).toHaveBeenCalledTimes(cases.length);
    expect(connect).toHaveBeenCalledWith(`ws://127.0.0.1:${PORT}`, null);
  });

  it("readiness for a stopped or ended session opens no socket", async () => {
    const a = await api();
    for (const status of ["stopped", "ended"] as const) {
      launcher.session.mockResolvedValueOnce({
        sessionId: SID,
        scenarioId: "pitch",
        status,
      });
      const res = await a.readiness(get(`/sessions/${SID}/readiness`));
      expect(res.status).toBe(200);
      expect((await json(res)).data).toEqual({
        launcherStatus: status,
        status: null,
        modelLabel: null,
        roster: [],
        canStart: false,
        missing: [],
      });
    }
    expect(launcher.facilitator).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("readiness missing lists role ids only", async () => {
    const a = await api();
    conn = new FakeFacConn([
      seat("a", true, true, "Pat Secretname"),
      seat("b", true, false, "Sam Hiddenname"),
      seat("c", false, false),
    ]);
    const res = await a.readiness(get(`/sessions/${SID}/readiness`));
    const text = await res.text();
    const d = JSON.parse(text).data;
    expect(d.missing).toEqual(["b", "c"]);
    expect(d.roster).toHaveLength(3);
    expect(d.roster[0]).toEqual({
      roleId: "a",
      name: "Pat Secretname",
      joined: true,
      consented: true,
      connected: true,
    });
    // Names appear in the roster, never in `missing`.
    expect(JSON.stringify(d.missing)).not.toMatch(/Secretname|Hiddenname/);
  });

  it("readiness caps a display name at 60 characters and reports an unreachable runtime as status null", async () => {
    const a = await api();
    conn = new FakeFacConn([seat("a", true, true, "x".repeat(200))]);
    const d1 = (
      await json(await a.readiness(get(`/sessions/${SID}/readiness`)))
    ).data;
    expect([...d1.roster[0].name]).toHaveLength(60);
    connect.mockRejectedValueOnce(new Error("ECONNREFUSED 127.0.0.1"));
    const res = await a.readiness(get(`/sessions/${SID}/readiness`));
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({
      launcherStatus: "running",
      status: null,
      modelLabel: "mock",
      roster: [],
      canStart: false,
      missing: [],
    });
  });

  it("start while the gate is unmet returns the plain 409 and the session is not started", async () => {
    const a = await api();
    conn = new FakeFacConn([seat("a", true, true), seat("b", true, false)]);
    conn.onSend = (m, c) => {
      if (m.type === "start")
        queueMicrotask(() =>
          c.emit({
            type: "error",
            code: "seats_not_ready",
            message: "seats_not_ready: b,c,<script>",
          }),
        );
    };
    const res = await a.start(post(`/sessions/${SID}/start`));
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.success).toBe(false);
    expect(body.error).toEqual({
      code: "conflict",
      message: "Not everyone has joined and consented yet.",
    });
    expect(body.data).toEqual({
      started: false,
      reason: "seats_not_ready",
      missing: ["b", "c"],
    });
    expect(JSON.stringify(body)).not.toContain("script");
    expect(conn.sent).toEqual([{ type: "start" }]);
    expect(conn.closed).toBe(1);
  });

  it("start falls back to the readiness-derived missing roles when the runtime message cannot be parsed", async () => {
    const a = await api();
    conn = new FakeFacConn([seat("a", true, true), seat("b", true, false)]);
    conn.onSend = (m, c) => {
      if (m.type === "start")
        queueMicrotask(() =>
          c.emit({
            type: "error",
            code: "seats_not_ready",
            message: "Not <b>ready</b>",
          }),
        );
    };
    const body = await json(await a.start(post(`/sessions/${SID}/start`)));
    expect(body.data).toEqual({
      started: false,
      reason: "seats_not_ready",
      missing: ["b"],
    });
  });

  it("start succeeds when session.started arrives and the socket is closed", async () => {
    const a = await api();
    conn.onSend = (m, c) => {
      if (m.type !== "start") return;
      queueMicrotask(() => {
        c.emit({ type: "event", event: { type: "scene.opened" } as never });
        c.emit({ type: "event", event: { type: "session.started" } as never });
      });
    };
    const res = await a.start(post(`/sessions/${SID}/start`));
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ started: true });
    expect(conn.closed).toBe(1);
    expect(conn.joinedWith).toEqual([{ sessionId: SID, token: FAC_TOKEN }]);
    expect(timers.live()).toHaveLength(0);
  });

  it("start maps already_started to 409 and any other runtime error to the neutral 502", async () => {
    const a = await api();
    conn.onSend = (m, c) => {
      if (m.type === "start")
        queueMicrotask(() =>
          c.emit({
            type: "error",
            code: "already_started",
            message: "already_started",
          }),
        );
    };
    const r1 = await a.start(post(`/sessions/${SID}/start`));
    expect(r1.status).toBe(409);
    expect((await json(r1)).error?.code).toBe("conflict");
    conn = new FakeFacConn([]);
    conn.onSend = (m, c) => {
      if (m.type === "start")
        queueMicrotask(() =>
          c.emit({
            type: "error",
            code: "internal",
            message: "boom at /srv/runtime/x.ts",
          }),
        );
    };
    const r2 = await a.start(post(`/sessions/${SID}/start`));
    expect(r2.status).toBe(502);
    const t = JSON.stringify(await json(r2));
    expect(t).toContain("The session service is not reachable. Try again.");
    expect(t).not.toContain("/srv");
    expect(conn.closed).toBe(1);
  });

  it("start times out neutrally when nothing arrives", async () => {
    const a = await api();
    const pending = a.start(post(`/sessions/${SID}/start`));
    await until(() => timers.live().length > 0, { what: "the start timer" });
    expect(timers.live().map((t) => t)).toHaveLength(1);
    timers.fire(10_000);
    const res = await pending;
    expect(res.status).toBe(504);
    const body = await json(res);
    expect(body.error?.code).toBe("start_timeout");
    expect(body.error?.message).toBe(
      "The session did not confirm the start. Check the lobby, then try again.",
    );
    expect(conn.closed).toBe(1);
  });

  it("start is neutral when the socket drops before an answer", async () => {
    const a = await api();
    conn.onSend = (m, c) => {
      if (m.type === "start") queueMicrotask(() => c.drop());
    };
    const res = await a.start(post(`/sessions/${SID}/start`));
    expect(res.status).toBe(502);
    expect(conn.closed).toBe(1);
  });

  it('reissue passes the console name from the cookie, never from the body (a body field "by" is rejected)', async () => {
    const a = await api();
    const res = await a.reissue(
      post(
        `/sessions/${SID}/reissue`,
        { roleId: "a" },
        { cookie: consoleCookie("Dana Cook") },
      ),
    );
    expect(res.status).toBe(200);
    expect(launcher.reissue).toHaveBeenCalledWith(SID, "a", "Dana Cook");
    const forged = await a.reissue(
      post(`/sessions/${SID}/reissue`, { roleId: "a", by: "Mallory" }),
    );
    expect(forged.status).toBe(400);
    const forgedAll = await a.reissueAll(
      post(`/sessions/${SID}/reissue-all`, { by: "Mallory" }),
    );
    expect(forgedAll.status).toBe(400);
    expect(launcher.reissue).toHaveBeenCalledTimes(1);
    expect(launcher.reissueAll).not.toHaveBeenCalled();
    await a.reissueAll(
      post(
        `/sessions/${SID}/reissue-all`,
        {},
        { cookie: consoleCookie("Dana Cook") },
      ),
    );
    expect(launcher.reissueAll).toHaveBeenCalledWith(SID, "Dana Cook");
  });

  it("reissue returns the new code once", async () => {
    const a = await api();
    const res = await a.reissue(
      post(`/sessions/${SID}/reissue`, { roleId: "a" }),
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await json(res)).data).toEqual({ roleId: "a", code: CODE_NEW });
    const later = await (
      await a.readiness(get(`/sessions/${SID}/readiness`))
    ).text();
    expect(later).not.toContain(CODE_NEW);
    expect(errors.join("\n") + warns.join("\n")).not.toContain(CODE_NEW);
    const all = await a.reissueAll(post(`/sessions/${SID}/reissue-all`));
    expect((await json(all)).data).toEqual({
      codes: [
        { roleId: "a", code: CODE_NEW },
        { roleId: "b", code: CODE_NEW },
      ],
    });
    expect(
      (
        await a.reissue(
          post(`/sessions/${SID}/reissue`, { roleId: "Bad Role" }),
        )
      ).status,
    ).toBe(400);
    expect((await a.reissue(post(`/sessions/${SID}/reissue`, {}))).status).toBe(
      400,
    );
  });

  it("restart returns the new status, label and any codes", async () => {
    const a = await api();
    const res = await a.restart(post(`/sessions/${SID}/restart`));
    expect((await json(res)).data).toEqual({
      sessionId: SID,
      launcherStatus: "running",
      modelLabel: "mock",
      codes: [{ roleId: "a", code: CODE_NEW }],
    });
    launcher.restart.mockResolvedValueOnce({
      sessionId: SID,
      scenarioId: "pitch",
      status: "running",
    });
    expect(
      (await json(await a.restart(post(`/sessions/${SID}/restart`)))).data,
    ).toEqual({ sessionId: SID, launcherStatus: "running", modelLabel: null });
  });

  it("reissue-all is refused after the start (409 mapped)", async () => {
    const a = await api();
    launcher.reissueAll.mockRejectedValueOnce(new LauncherError("conflict"));
    const res = await a.reissueAll(post(`/sessions/${SID}/reissue-all`));
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error).toEqual({
      code: "conflict",
      message: "That action is not possible in the session's current state.",
    });
  });

  it("a LauncherError becomes the neutral 502 with the fixed text, for each reason in the closed set", async () => {
    const a = await api();
    const expected: Record<LauncherReason, [number, string, string]> = {
      unavailable: [
        502,
        "launcher_unavailable",
        "The session service is not reachable. Try again.",
      ],
      timeout: [
        502,
        "launcher_unavailable",
        "The session service is not reachable. Try again.",
      ],
      failed: [
        502,
        "launcher_unavailable",
        "The session service is not reachable. Try again.",
      ],
      unauthorized: [
        502,
        "launcher_unavailable",
        "The session service is not reachable. Try again.",
      ],
      not_found: [404, "not_found", "That session was not found."],
      conflict: [
        409,
        "conflict",
        "That action is not possible in the session's current state.",
      ],
      capacity: [429, "capacity", "The maximum number of sessions is running."],
      bad_request: [400, "bad_request", "The request could not be read."],
    };
    for (const [reason, [status, code, message]] of Object.entries(
      expected,
    ) as [LauncherReason, [number, string, string]][]) {
      launcher.sessions.mockRejectedValueOnce(new LauncherError(reason));
      const res = await a.list(get("/sessions"));
      expect(res.status, reason).toBe(status);
      expect((await json(res)).error, reason).toEqual({ code, message });
      launcher.createSession.mockRejectedValueOnce(new LauncherError(reason));
      expect(
        (await a.create(post("/sessions", { scenarioId: "pitch" }))).status,
        reason,
      ).toBe(status);
      launcher.session.mockRejectedValueOnce(new LauncherError(reason));
      expect(
        (await a.readiness(get(`/sessions/${SID}/readiness`))).status,
        reason,
      ).toBe(status);
    }
    // A non-launcher failure is the same neutral 502.
    launcher.scenarios.mockRejectedValueOnce(new Error("TypeError at /srv/x"));
    const odd = await a.scenarios(get("/scenarios"));
    expect(odd.status).toBe(502);
    expect(await odd.text()).not.toContain("/srv");
  });

  it("an invalid or path-like session id is 404 and never reaches the launcher", async () => {
    const a = await api();
    const ids = [
      "..",
      "..%2Fetc",
      "a%2Fb",
      "has space",
      "x".repeat(65),
      "%00",
      "s-1;rm",
      "a.b",
    ];
    for (const id of ids) {
      for (const [name, make] of [
        ["get", () => get(`/sessions/${id}`)],
        ["readiness", () => get(`/sessions/${id}/readiness`)],
        ["start", () => post(`/sessions/${id}/start`)],
        ["reissue", () => post(`/sessions/${id}/reissue`, { roleId: "a" })],
        ["reissueAll", () => post(`/sessions/${id}/reissue-all`)],
        ["restart", () => post(`/sessions/${id}/restart`)],
      ] as [string, () => Request][]) {
        const res = await (
          a as Record<string, (r: Request) => Promise<Response>>
        )[name]!(make());
        expect(res.status, `${name} ${id}`).toBe(404);
        expect((await json(res)).error?.code).toBe("not_found");
      }
    }
    for (const v of Object.values(launcher)) expect(v).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("no log line contains a token, code, name or URL", async () => {
    const a = await api();
    // Provoke every failure path that logs.
    for (const reason of [
      "unauthorized",
      "unavailable",
      "timeout",
      "failed",
      "conflict",
      "capacity",
      "not_found",
      "bad_request",
    ] as const) {
      launcher.createSession.mockRejectedValueOnce(new LauncherError(reason));
      await a.create(post("/sessions", { scenarioId: "pitch" }));
    }
    launcher.scenarios.mockRejectedValueOnce(
      new Error(`boom ${LAUNCHER_TOKEN} ${LAUNCHER_URL}`),
    );
    await a.scenarios(get("/scenarios"));
    launcher.facilitator.mockRejectedValueOnce(
      new LauncherError("unavailable"),
    );
    await a.start(post(`/sessions/${SID}/start`));
    connect.mockRejectedValueOnce(new Error(`ECONNREFUSED ${FAC_TOKEN}`));
    await a.start(post(`/sessions/${SID}/start`));
    await a.create(
      post(
        "/sessions",
        { scenarioId: "pitch" },
        { cookie: consoleCookie("Dana Cook") },
      ),
    );
    await a.reissue(
      post(
        `/sessions/${SID}/reissue`,
        { roleId: "a" },
        { cookie: consoleCookie("Dana Cook") },
      ),
    );
    const all = [...errors, ...warns].join("\n");
    expect(errors.length).toBeGreaterThan(0);
    for (const secret of [
      LAUNCHER_TOKEN,
      FAC_TOKEN,
      LAUNCHER_URL,
      "127.0.0.1",
      CODE_A,
      CODE_B,
      CODE_NEW,
      "Dana Cook",
      NAME,
      String(PORT),
    ])
      expect(all).not.toContain(secret);
  });
});

describe("route bindings", () => {
  it("the console session routes are exported through routes.ts as functions", () => {
    for (const f of [
      consoleScenariosGET,
      consoleSessionsGET,
      consoleSessionsPOST,
      consoleSessionGET,
      consoleReadinessGET,
      consoleStartPOST,
      consoleReissuePOST,
      consoleReissueAllPOST,
      consoleRestartPOST,
    ])
      expect(typeof f).toBe("function");
  });
});

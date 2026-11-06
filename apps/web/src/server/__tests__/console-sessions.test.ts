import {
  FacilitatorBudget,
  SHORT_SOCKETS_PER_SESSION,
} from "../facilitator-budget";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FacilitatorHub } from "../facilitator-hub";
import { realTimer } from "../runtime-connection";
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
    return {
      frame: {
        type: "joined" as const,
        roleId: "facilitator",
        state: { status: this.status } as never,
      },
      roster: this.roster,
      status: this.status,
    };
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
    if (this.reportedCode !== null) {
      fn(this.reportedCode);
      return () => {};
    }
    this.closes.add(fn);
    return () => {
      this.closes.delete(fn);
    };
  }
  close() {
    this.closed++;
    // Like the real connection, close() ends in a close report (the facilitator budget frees its slot on it).
    queueMicrotask(() => this.report(1000));
  }
  private reportedCode: number | null = null;
  /** The close report, once only; a listener added afterwards is called at once (like RuntimeConnection.onClose). */
  private report(code: number) {
    if (this.reportedCode !== null) return;
    this.reportedCode = code;
    for (const f of [...this.closes]) f(code);
  }
  emit(m: ServerMessage) {
    for (const f of [...this.frames]) f(m);
  }
  drop() {
    this.report(1006);
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
    facilitatorBudget: new FacilitatorBudget(),
    facilitatorHub: new FacilitatorHub({ setTimer: realTimer, now: Date.now }),
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
    remove: bind(m.handleConsoleRemove),
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
        "remove",
        () => post(`/sessions/${SID}/remove`, { roleId: "a" }, { cookie }),
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
    expect(connect).toHaveBeenCalledWith(
      `ws://127.0.0.1:${PORT}`,
      "scenecoach-console",
    );
  });

  it("readiness answers includeInGroup false when the launcher's info says false and true when it has no field", async () => {
    const a = await api();
    for (const [field, want] of [[{ includeInGroup: false }, false], [{ includeInGroup: true }, true], [{}, true]] as const) {
      launcher.session.mockResolvedValueOnce({ sessionId: SID, scenarioId: "pitch", status: "stopped", ...field });
      expect((await json(await a.readiness(get(`/sessions/${SID}/readiness`)))).data.includeInGroup).toBe(want);
    }
    launcher.session.mockResolvedValueOnce({ sessionId: SID, scenarioId: "pitch", status: "running", includeInGroup: false });
    expect((await json(await a.readiness(get(`/sessions/${SID}/readiness`)))).data.includeInGroup).toBe(false);
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
        includeInGroup: true,
        status: null,
        modelLabel: null,
        roster: [],
        canStart: false,
        missing: [],
        aiWaiting: [],
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
      includeInGroup: true,
      status: null,
      modelLabel: "mock",
      roster: [],
      canStart: false,
      missing: [],
      aiWaiting: [],
    });
  });

  it("readiness with no short slot is status null, not an error", async () => {
    const a = await api();
    for (let i = 0; i < SHORT_SOCKETS_PER_SESSION; i++)
      expect(deps.facilitatorBudget.tryAcquire(SID, "short")).not.toBeNull();
    const res = await a.readiness(get(`/sessions/${SID}/readiness`));
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({
      launcherStatus: "running",
      status: null,
      roster: [],
      canStart: false,
    });
    expect(connect).not.toHaveBeenCalled();
    expect(launcher.facilitator).not.toHaveBeenCalled();
  });

  it("Start with no short slot is 503 busy", async () => {
    const a = await api();
    for (let i = 0; i < SHORT_SOCKETS_PER_SESSION; i++)
      deps.facilitatorBudget.tryAcquire(SID, "short");
    const res = await a.start(post(`/sessions/${SID}/start`));
    expect(res.status).toBe(503);
    const body = await json(res);
    expect(body.error?.code).toBe("busy");
    expect(body.error?.message).toBe(
      "Too many console connections to this session are open. Close a console tab and try again.",
    );
    expect(connect).not.toHaveBeenCalled();
    expect(launcher.facilitator).not.toHaveBeenCalled();
    expect(conn.sent).toEqual([]);
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
      aiWaiting: [],
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
      aiWaiting: [],
    });
  });

  const aiSeat = (roleId: string, joined: boolean): FacilitatorRosterEntry => ({
    ...seat(roleId, joined, false),
    ai: true,
  });
  const refuse = (message: string, code = "seats_not_ready") => {
    conn.onSend = (m, c) => {
      if (m.type === "start")
        queueMicrotask(() => c.emit({ type: "error", code, message }));
    };
  };

  it("readiness lists an AI seat with ai true, counts it in aiWaiting until joined and never in missing", async () => {
    const a = await api();
    conn = new FakeFacConn([seat("a", true, true), seat("b", true, true), aiSeat("tech_lead", false)]);
    let d = (await json(await a.readiness(get(`/sessions/${SID}/readiness`)))).data;
    expect(d.roster.find((e: { roleId: string }) => e.roleId === "tech_lead").ai).toBe(true);
    expect(d.missing).toEqual([]);
    expect(d.aiWaiting).toEqual(["tech_lead"]);
    expect(d.canStart).toBe(false);
    conn = new FakeFacConn([seat("a", true, true), seat("b", true, true), aiSeat("tech_lead", true)]);
    d = (await json(await a.readiness(get(`/sessions/${SID}/readiness`)))).data;
    expect(d.missing).toEqual([]);
    expect(d.aiWaiting).toEqual([]);
    expect(d.canStart).toBe(true);
  });

  it("an AI seat that joined but never consented does not keep a human missing, and a human not consented still does", async () => {
    const a = await api();
    conn = new FakeFacConn([seat("a", true, false), aiSeat("tech_lead", true)]);
    const d = (await json(await a.readiness(get(`/sessions/${SID}/readiness`)))).data;
    expect(d.missing).toEqual(["a"]);
    expect(d.aiWaiting).toEqual([]);
    expect(d.canStart).toBe(false);
  });

  it("readiness for a session with no AI roles has aiWaiting [] (also when not asked)", async () => {
    const a = await api();
    expect((await json(await a.readiness(get(`/sessions/${SID}/readiness`)))).data.aiWaiting).toEqual([]);
    launcher.session.mockResolvedValueOnce({ sessionId: SID, scenarioId: "pitch", status: "stopped" });
    expect((await json(await a.readiness(get(`/sessions/${SID}/readiness`)))).data.aiWaiting).toEqual([]);
  });

  it("a start refused \"seats_not_ready: b,tech_lead\" answers missing [b] and aiWaiting [tech_lead]", async () => {
    const a = await api();
    conn = new FakeFacConn([seat("a", true, true), seat("b", false, false), aiSeat("tech_lead", false)]);
    refuse("seats_not_ready: b,tech_lead");
    const res = await a.start(post(`/sessions/${SID}/start`));
    expect(res.status).toBe(409);
    expect((await json(res)).data).toEqual({ started: false, reason: "seats_not_ready", missing: ["b"], aiWaiting: ["tech_lead"] });
  });

  it("a refusal where all missing are AI answers missing [] and drops an id that is not an id", async () => {
    const a = await api();
    conn = new FakeFacConn([seat("a", true, true), aiSeat("tech_lead", false)]);
    refuse("seats_not_ready: tech_lead,Tech Lead,<x>");
    const body = await json(await a.start(post(`/sessions/${SID}/start`)));
    expect(body.data).toEqual({ started: false, reason: "seats_not_ready", missing: [], aiWaiting: ["tech_lead"] });
  });

  it("the unparseable-message fallback splits the roster the same way", async () => {
    const a = await api();
    conn = new FakeFacConn([seat("a", true, false), aiSeat("tech_lead", false)]);
    refuse("nope");
    const body = await json(await a.start(post(`/sessions/${SID}/start`)));
    expect(body.data).toEqual({ started: false, reason: "seats_not_ready", missing: ["a"], aiWaiting: ["tech_lead"] });
  });

  it("a start refused ai_notice answers 409 with the notice copy and does not wait for the timeout", async () => {
    const a = await api();
    refuse("ai_notice", "ai_notice");
    const res = await a.start(post(`/sessions/${SID}/start`));
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error).toEqual({
      code: "ai_notice",
      message: "This server's consent notice does not mention AI players. AI players need notice v2 or later.",
    });
    expect(body.data).toEqual({ started: false, reason: "ai_notice" });
    expect(conn.closed).toBe(1);
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

  it("start ignores error frames no start can produce, and still ends on the real answer (BUG-0015, M-9)", async () => {
    const a = await api();
    conn.onSend = (m, c) => {
      if (m.type !== "start") return;
      // Stray answers to something else on the same socket come first; the start's own answer follows.
      queueMicrotask(() => {
        c.emit({ type: "error", code: "not_started", message: "not_started" });
        c.emit({ type: "error", code: "forbidden", message: "forbidden" });
        c.emit({
          type: "error",
          code: "already_started",
          message: "already_started",
        });
      });
    };
    const res = await a.start(post(`/sessions/${SID}/start`));
    expect(res.status).toBe(409);
    expect((await json(res)).error?.message).toBe(
      "The session has already started.",
    );
  });

  it("start is not ended by a stray error frame: only the timeout answers when nothing real arrives", async () => {
    const a = await api();
    conn.onSend = (m, c) => {
      if (m.type === "start")
        queueMicrotask(() =>
          c.emit({
            type: "error",
            code: "not_started",
            message: "not_started",
          }),
        );
    };
    const pending = a.start(post(`/sessions/${SID}/start`));
    await until(() => timers.live().length > 0, { what: "the start timer" });
    timers.fire(10_000);
    expect((await pending).status).toBe(504);
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

  it("remove sends the cookie's name and reason removed and returns the new code once", async () => {
    const a = await api();
    const res = await a.remove(
      post(
        `/sessions/${SID}/remove`,
        { roleId: "a" },
        { cookie: consoleCookie("Dana Cook") },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(launcher.reissue).toHaveBeenCalledTimes(1);
    expect(launcher.reissue).toHaveBeenCalledWith(
      SID,
      "a",
      "Dana Cook",
      "removed",
    );
    expect((await json(res)).data).toEqual({ roleId: "a", code: CODE_NEW });
    expect(errors.join("\n") + warns.join("\n")).not.toContain(CODE_NEW);
    const later = await (
      await a.readiness(get(`/sessions/${SID}/readiness`))
    ).text();
    expect(later).not.toContain(CODE_NEW);
    expect((await a.remove(post(`/sessions/${SID}/remove`, {}))).status).toBe(
      400,
    );
    expect(
      (await a.remove(post(`/sessions/${SID}/remove`, { roleId: "Bad Role" })))
        .status,
    ).toBe(400);
    expect(launcher.reissue).toHaveBeenCalledTimes(1);
  });

  it('a launcher conflict is 409 "A participant can only be removed before the start."', async () => {
    const a = await api();
    launcher.reissue.mockRejectedValueOnce(new LauncherError("conflict"));
    const res = await a.remove(
      post(`/sessions/${SID}/remove`, { roleId: "a" }),
    );
    expect(res.status).toBe(409);
    expect((await json(res)).error).toEqual({
      code: "conflict",
      message: "A participant can only be removed before the start.",
    });
    launcher.reissue.mockRejectedValueOnce(new LauncherError("not_found"));
    expect(
      (await a.remove(post(`/sessions/${SID}/remove`, { roleId: "a" }))).status,
    ).toBe(404);
    launcher.reissue.mockRejectedValueOnce(new LauncherError("unavailable"));
    expect(
      (await a.remove(post(`/sessions/${SID}/remove`, { roleId: "a" }))).status,
    ).toBe(502);
  });

  it("remove checks Origin, the custom header and the cookie like reissue", async () => {
    const a = await api();
    const path = `/sessions/${SID}/remove`;
    for (const headers of [
      { Origin: "https://evil.example.com" },
      { Origin: null },
      { "X-Requested-With": null },
      { "Sec-Fetch-Site": "cross-site" },
    ] as Record<string, string | null>[])
      expect(
        (await a.remove(post(path, { roleId: "a" }, { headers }))).status,
        JSON.stringify(headers),
      ).toBe(403);
    expect(
      (await a.remove(post(path, { roleId: "a" }, { cookie: null }))).status,
    ).toBe(401);
    const player = await a.remove(
      post(path, { roleId: "a" }, { cookie: playerCookie() }),
    );
    expect(player.status).toBe(401);
    expect((await json(player)).error?.code).toBe("unauthorized");
    expect(launcher.reissue).not.toHaveBeenCalled();
  });

  it("remove on a disabled console is 503 and the launcher is not called", async () => {
    const a = await api();
    deps = {
      ...deps,
      config: { ...config, facilitatorSecret: undefined },
    } as Deps;
    const res = await a.remove(
      post(`/sessions/${SID}/remove`, { roleId: "a" }),
    );
    expect(res.status).toBe(503);
    expect((await json(res)).success).toBe(false);
    expect(launcher.reissue).not.toHaveBeenCalled();
  });

  it("a body with by or reason is 400", async () => {
    const a = await api();
    for (const extra of [
      { by: "Mallory" },
      { reason: "removed" },
      { reason: "x" },
    ])
      expect(
        (
          await a.remove(
            post(`/sessions/${SID}/remove`, { roleId: "a", ...extra }),
          )
        ).status,
      ).toBe(400);
    expect(launcher.reissue).not.toHaveBeenCalled();
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
      ai_role: [
        409,
        "ai_role",
        "This role is played by an AI player. Switch it back to human first.",
      ],
      ai_notice: [
        409,
        "ai_notice",
        "This server's consent notice does not mention AI players. AI players need notice v2 or later.",
      ],
      ai_started: [
        409,
        "ai_started",
        "Roles can no longer be changed: the session has started.",
      ],
      ai_no_human: [409, "ai_no_human", "At least one role must stay human."],
      ai_too_many: [409, "ai_too_many", "At most 8 roles can be AI players."],
      ai_invalid: [400, "bad_request", "The request could not be read."],
      ai_busy: [409, "ai_busy", "The AI player is already answering. Wait a moment, then try again."],
      ai_budget: [409, "ai_budget", "The AI players have used this session's model budget. They stay silent."],
      ai_absent: [409, "ai_absent", "The AI player is not connected right now."],
      ai_expired: [409, "ai_expired", "The prompt took too long to confirm. Try again."],
      busy: [502, "launcher_unavailable", "The session service is not reachable. Try again."],
      // The evaluate and review reasons (US-0064) are answered by console-report-handlers.ts; any other route reads them as unreachable.
      invalid: [502, "launcher_unavailable", "The session service is not reachable. Try again."],
      not_ended: [502, "launcher_unavailable", "The session service is not reachable. Try again."],
      already_evaluated: [502, "launcher_unavailable", "The session service is not reachable. Try again."],
      already_running: [502, "launcher_unavailable", "The session service is not reachable. Try again."],
      too_many_running: [502, "launcher_unavailable", "The session service is not reachable. Try again."],
      confirm_mismatch: [502, "launcher_unavailable", "The session service is not reachable. Try again."],
      orphan: [502, "launcher_unavailable", "The session service is not reachable. Try again."],
      no_review: [502, "launcher_unavailable", "The session service is not reachable. Try again."],
      unknown_criterion: [502, "launcher_unavailable", "The session service is not reachable. Try again."],
      unknown_subject: [502, "launcher_unavailable", "The session service is not reachable. Try again."],
      stale: [502, "launcher_unavailable", "The session service is not reachable. Try again."],
      blocked: [502, "launcher_unavailable", "The session service is not reachable. Try again."],
      not_released: [502, "launcher_unavailable", "The session service is not reachable. Try again."],
      not_editable: [502, "launcher_unavailable", "The session service is not reachable. Try again."],
      superseded: [502, "launcher_unavailable", "The session service is not reachable. Try again."],
      needs_amend: [502, "launcher_unavailable", "The session service is not reachable. Try again."],
      refused: [502, "launcher_unavailable", "The session service is not reachable. Try again."],
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
        ["remove", () => post(`/sessions/${id}/remove`, { roleId: "a" })],
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

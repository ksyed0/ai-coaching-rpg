import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountSlug } from "../console-report-handlers";
import { setEnvelopeClock } from "../envelope";
import type { Deps } from "../handlers";
import { FacilitatorHub } from "../facilitator-hub";
import { LauncherClient, LauncherError, type AccountInfo, type SessionInfo } from "../launcher-client";
import {
  ADMIN, FACILITATOR, FIXTURE_ORIGIN as ORIGIN, FIXTURE_T0 as T0, accountCookie, consoleAuth, fakeDeps, legacyCookie,
} from "../test-support/console-fixtures";
import { FakeConn, manualTimers, sseReader, until } from "./fakes";

// US-0083 Task 6: session ownership on every console route that takes a session id. The route table is read from the real Next route
// files under app/api/v1/console/sessions/[id], and each file's exported handlers are called through routes.ts's shared deps, so a new
// route file that names a session and skips the ownership check fails here instead of being skipped.

const SID_MINE = "s-1111111111111111";
const SID_OTHER = "s-2222222222222222";
const SID_UNOWNED = "s-3333333333333333";
const SID_UNKNOWN = "s-4444444444444444";
const OTHER_FAC: AccountInfo = { ...FACILITATOR, id: "acc-fac-0099", login: "sam@client.example", name: "Sam Ortiz", epoch: 5 };
const REVOKED: AccountInfo = { ...FACILITATOR, id: "acc-fac-0077", login: "old@client.example", name: "Old One", status: "revoked", epoch: 9 };
const SAME = { Origin: ORIGIN, "X-Requested-With": "scenecoach", "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" };
const SHARED = Symbol.for("scenecoach.web.deps");

const INFOS: Record<string, SessionInfo> = {
  [SID_MINE]: { sessionId: SID_MINE, scenarioId: "friday-escalation", status: "stopped", owner: FACILITATOR.id },
  [SID_OTHER]: { sessionId: SID_OTHER, scenarioId: "friday-escalation", status: "stopped", owner: OTHER_FAC.id },
  [SID_UNOWNED]: { sessionId: SID_UNOWNED, scenarioId: "friday-escalation", status: "stopped" },
};

// ---- the route table, from the app's route files ----

const APP_CONSOLE = path.resolve(__dirname, "../../app/api/v1/console");
const SESSION_DIR = path.join(APP_CONSOLE, "sessions", "[id]");

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (name === "route.ts") out.push(p);
  }
  return out.sort();
}

type RouteCase = { file: string; template: string; method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH"; handler: (req: Request) => Promise<Response> };
const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"] as const;

async function sessionRoutes(): Promise<RouteCase[]> {
  const cases: RouteCase[] = [];
  for (const file of routeFiles(SESSION_DIR)) {
    const rel = path.relative(APP_CONSOLE, path.dirname(file)).split(path.sep).join("/");
    const mod = (await import(file)) as Record<string, unknown>;
    for (const m of METHODS) {
      const h = mod[m];
      if (typeof h === "function") cases.push({ file: rel, template: `/api/v1/console/${rel}`, method: m, handler: h as RouteCase["handler"] });
    }
  }
  return cases;
}

/** Fills the path's dynamic segments: the session id, and a well-formed value for every other one. */
function urlFor(template: string, sid: string): string {
  return ORIGIN + template.replace("[id]", sid).replace("[roleId]", "alice").replace("[role]", "alice").replace("[subject]", "group");
}
function requestFor(c: RouteCase, sid: string, cookie: string): Request {
  const headers = { ...SAME, Accept: "text/event-stream", Cookie: cookie };
  return c.method === "GET"
    ? new Request(urlFor(c.template, sid), { headers })
    : new Request(urlFor(c.template, sid), { method: c.method, headers, body: "{}" });
}

/** Routes that are for admins only: a facilitator is refused 403 there whatever the session. */
const ADMIN_ONLY = new Set(["sessions/[id]/owner"]);

// ---- deps whose every side effect is observable ----

type Spied = Deps & { auth: ReturnType<typeof consoleAuth>; calls: string[] };

/** A fake launcher: `session` answers from INFOS (unknown is not_found); any other method is recorded and refused with a conflict. */
function spiedDeps(auth = consoleAuth([ADMIN, FACILITATOR, OTHER_FAC, REVOKED])): Spied {
  const calls: string[] = [];
  const session = vi.fn(async (id: string) => {
    const i = INFOS[id];
    if (!i) throw new LauncherError("not_found");
    return { ...i };
  });
  const deps = fakeDeps({ auth, connect: vi.fn(async () => { throw new Error("no runtime in this test"); }) as unknown as Deps["connect"] }) as Spied;
  const base = { ...auth.launcher, session } as Record<PropertyKey, unknown>;
  deps.launcher = new Proxy(base, {
    get: (t, k) => {
      if (Object.hasOwn(t, k)) return t[k];
      if (typeof k !== "string" || k === "then") return undefined;
      return async () => { calls.push(k); throw new LauncherError("conflict"); };
    },
  }) as unknown as Deps["launcher"];
  deps.calls = calls;
  vi.spyOn(deps.facilitatorHub, "send");
  vi.spyOn(deps.facilitatorHub, "open");
  vi.spyOn(deps.consoleReportThrottle, "fail");
  vi.spyOn(deps.consoleReportThrottle, "blockedForMs");
  return deps;
}

function install(deps: Deps) {
  (globalThis as { [SHARED]?: Deps })[SHARED] = deps;
}

async function snapshot(res: Response) {
  const headers = [...res.headers.entries()].sort(([a], [b]) => a.localeCompare(b));
  return { status: res.status, headers, body: await res.text() };
}

const NEUTRAL_BODY = JSON.stringify({ success: false, data: null, error: { code: "not_found", message: "That session was not found." }, meta: { version: "1.0", timestamp: new Date(T0).toISOString() } });

beforeEach(() => {
  setEnvelopeClock(() => new Date(T0));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  delete (globalThis as { [SHARED]?: Deps })[SHARED];
  vi.restoreAllMocks();
  setEnvelopeClock(() => new Date());
});

describe("console route table", () => {
  it("test_console_ownership_route_table_lists_every_session_route", async () => {
    const found = (await sessionRoutes()).map((c) => `${c.method} ${c.file}`);
    // A floor, not the list: a new route file joins the table by itself. These are the Review Focus routes.
    for (const r of [
      "GET sessions/[id]", "POST sessions/[id]/command", "GET sessions/[id]/stream", "GET sessions/[id]/readiness", "POST sessions/[id]/reissue",
      "POST sessions/[id]/reissue-all", "POST sessions/[id]/remove", "POST sessions/[id]/restart", "POST sessions/[id]/start", "POST sessions/[id]/facts",
      "POST sessions/[id]/ai-roles", "POST sessions/[id]/ai-roles/[roleId]/intents", "POST sessions/[id]/ai-roles/[roleId]/prompt",
      "GET sessions/[id]/report", "POST sessions/[id]/report/evaluate", "POST sessions/[id]/report/evaluate/cancel", "POST sessions/[id]/report/export",
      "POST sessions/[id]/report/open", "POST sessions/[id]/report/release", "POST sessions/[id]/report/resolve", "GET sessions/[id]/report/subjects/[subject]",
      "POST sessions/[id]/report/subjects/[subject]/accept", "POST sessions/[id]/report/subjects/[subject]/amend", "POST sessions/[id]/report/subjects/[subject]/comment",
      "POST sessions/[id]/report/subjects/[subject]/edit", "POST sessions/[id]/report/subjects/[subject]/edit-summary", "POST sessions/[id]/report/subjects/[subject]/withdraw",
      "GET sessions/[id]/report-links", "POST sessions/[id]/report-links", "POST sessions/[id]/report-links/[role]", "POST sessions/[id]/owner",
    ]) expect(found).toContain(r);
  });
});

describe("ownership on every console route that takes a session id", () => {
  it("test_console_ownership_facilitator_gets_404_for_another_facilitators_session_on_every_route", async () => {
    const cases = await sessionRoutes();
    expect(cases.length).toBeGreaterThanOrEqual(31);
    for (const c of cases) {
      if (ADMIN_ONLY.has(c.file)) continue;
      const deps = spiedDeps();
      install(deps);
      const other = await snapshot(await c.handler(requestFor(c, SID_OTHER, accountCookie(FACILITATOR))));
      const unknown = await snapshot(await c.handler(requestFor(c, SID_UNKNOWN, accountCookie(FACILITATOR))));
      const label = `${c.method} ${c.file}`;
      expect(other.status, label).toBe(404);
      expect(other.body, label).toBe(NEUTRAL_BODY);
      // Byte-identical to an unknown session: status, headers and body.
      expect(other, label).toEqual(unknown);
      // Nothing happened before the refusal: no launcher call besides the lookup, no runtime, no hub, no throttle charge.
      expect(deps.calls, label).toEqual([]);
      expect(deps.connect, label).not.toHaveBeenCalled();
      expect(deps.facilitatorHub.send, label).not.toHaveBeenCalled();
      expect(deps.facilitatorHub.open, label).not.toHaveBeenCalled();
      expect(deps.consoleReportThrottle.fail, label).not.toHaveBeenCalled();
      expect(deps.consoleReportThrottle.blockedForMs, label).not.toHaveBeenCalled();
    }
  });

  it("test_console_ownership_session_without_owner_is_admin_only", async () => {
    for (const c of await sessionRoutes()) {
      if (ADMIN_ONLY.has(c.file)) continue;
      const deps = spiedDeps();
      install(deps);
      const label = `${c.method} ${c.file}`;
      const fac = await snapshot(await c.handler(requestFor(c, SID_UNOWNED, accountCookie(FACILITATOR))));
      expect(fac.status, label).toBe(404);
      expect(fac.body, label).toBe(NEUTRAL_BODY);
      expect(deps.calls, label).toEqual([]);
      const admin = await c.handler(requestFor(c, SID_UNOWNED, accountCookie(ADMIN)));
      expect(admin.status, label).not.toBe(404);
    }
  });

  it("test_console_ownership_admin_can_use_any_session", async () => {
    for (const c of await sessionRoutes()) {
      const label = `${c.method} ${c.file}`;
      for (const [cookie, sid] of [[accountCookie(ADMIN), SID_OTHER], [accountCookie(ADMIN), SID_MINE], [legacyCookie("Ann"), SID_OTHER], [legacyCookie("Ann"), SID_UNOWNED]] as const) {
        const deps = spiedDeps();
        install(deps);
        const res = await c.handler(requestFor(c, sid, cookie));
        expect(res.status, `${label} ${sid}`).not.toBe(404);
        expect(res.status, `${label} ${sid}`).not.toBe(401);
        expect(res.status, `${label} ${sid}`).not.toBe(403);
      }
    }
  });

  it("test_console_ownership_facilitator_can_use_their_own_session", async () => {
    for (const c of await sessionRoutes()) {
      const deps = spiedDeps();
      install(deps);
      const res = await c.handler(requestFor(c, SID_MINE, accountCookie(FACILITATOR)));
      const label = `${c.method} ${c.file}`;
      if (ADMIN_ONLY.has(c.file)) expect(res.status, label).toBe(403);
      else expect(res.status, label).not.toBe(404);
    }
  });

  it("test_console_ownership_the_session_lookup_is_made_once_per_request", async () => {
    const cases = await sessionRoutes();
    for (const file of ["sessions/[id]", "sessions/[id]/readiness", "sessions/[id]/stream"]) {
      const c = cases.find((x) => x.file === file && x.method === "GET")!;
      const deps = spiedDeps();
      install(deps);
      const res = await c.handler(requestFor(c, SID_MINE, accountCookie(FACILITATOR)));
      expect(res.status, file).toBe(200);
      expect((deps.launcher as unknown as { session: ReturnType<typeof vi.fn> }).session, file).toHaveBeenCalledTimes(1);
    }
  });
});

describe("list and create", () => {
  const listDeps = () => {
    const deps = spiedDeps();
    const sessions = vi.fn(async () => Object.values(INFOS).map((i) => ({ ...i })));
    const createSession = vi.fn(async () => ({ sessionId: SID_MINE, status: "running", port: 40001, modelLabel: "mock", codes: [{ roleId: "alice", code: "ABCD-EFGH" }] }));
    const base = deps.launcher as unknown as Record<string, unknown>;
    deps.launcher = new Proxy(base, { get: (t, k) => (k === "sessions" ? sessions : k === "createSession" ? createSession : Reflect.get(t, k)) }) as unknown as Deps["launcher"];
    install(deps);
    return { deps, sessions, createSession };
  };
  const list = async (cookie: string) => {
    const { consoleSessionsGET } = await import("../routes");
    const res = await consoleSessionsGET(new Request(`${ORIGIN}/api/v1/console/sessions`, { headers: { Cookie: cookie } }));
    return { status: res.status, data: ((await res.json()) as { data: { sessionId: string; owner?: string }[] }).data };
  };

  it("test_console_ownership_list_is_filtered_for_a_facilitator_not_for_an_admin", async () => {
    listDeps();
    const fac = await list(accountCookie(FACILITATOR));
    expect(fac.status).toBe(200);
    expect(fac.data.map((s) => s.sessionId)).toEqual([SID_MINE]);
    expect(fac.data[0]).not.toHaveProperty("owner");
    const other = await list(accountCookie(OTHER_FAC));
    expect(other.data.map((s) => s.sessionId)).toEqual([SID_OTHER]);
    for (const cookie of [accountCookie(ADMIN), legacyCookie("Ann")]) {
      const admin = await list(cookie);
      expect(admin.data.map((s) => s.sessionId)).toEqual([SID_MINE, SID_OTHER, SID_UNOWNED]);
      expect(admin.data.map((s) => s.owner)).toEqual([FACILITATOR.id, OTHER_FAC.id, undefined]);
    }
  });

  it("test_console_ownership_create_records_the_caller_as_owner", async () => {
    const { consoleSessionsPOST } = await import("../routes");
    const create = (cookie: string) =>
      consoleSessionsPOST(new Request(`${ORIGIN}/api/v1/console/sessions`, { method: "POST", headers: { ...SAME, Cookie: cookie }, body: JSON.stringify({ scenarioId: "friday-escalation" }) }));
    let s = listDeps();
    expect((await create(accountCookie(FACILITATOR))).status).toBe(200);
    expect(s.createSession.mock.calls).toEqual([["friday-escalation", FACILITATOR.id]]);
    s = listDeps();
    expect((await create(accountCookie(ADMIN))).status).toBe(200);
    expect(s.createSession.mock.calls).toEqual([["friday-escalation", ADMIN.id]]);
    s = listDeps();
    expect((await create(legacyCookie("Ann"))).status).toBe(200);
    expect(s.createSession.mock.calls).toEqual([["friday-escalation"]]);
    // A body cannot choose the owner.
    s = listDeps();
    const res = await consoleSessionsPOST(new Request(`${ORIGIN}/api/v1/console/sessions`, { method: "POST", headers: { ...SAME, Cookie: accountCookie(FACILITATOR) }, body: JSON.stringify({ scenarioId: "friday-escalation", owner: OTHER_FAC.id }) }));
    expect(res.status).toBe(400);
    expect(s.createSession).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/console/sessions/:id/owner", () => {
  const ownerDeps = (auth = consoleAuth([ADMIN, FACILITATOR, OTHER_FAC, REVOKED])) => {
    const deps = spiedDeps(auth);
    const accountsList = vi.fn(async () => [ADMIN, FACILITATOR, OTHER_FAC, REVOKED].map((a) => ({ ...a })));
    const setOwner = vi.fn(async (id: string, owner: string | null) => {
      const i = INFOS[id];
      if (!i) throw new LauncherError("not_found");
      const { owner: _o, ...rest } = i;
      return owner === null ? rest : { ...rest, owner };
    });
    const base = deps.launcher as unknown as Record<string, unknown>;
    deps.launcher = new Proxy(base, { get: (t, k) => (k === "accountsList" ? accountsList : k === "setOwner" ? setOwner : Reflect.get(t, k)) }) as unknown as Deps["launcher"];
    install(deps);
    return { deps, accountsList, setOwner };
  };
  const setOwner = async (sid: string, cookie: string, body: unknown, headers: Record<string, string> = SAME) => {
    const { POST } = (await import("../../app/api/v1/console/sessions/[id]/owner/route")) as { POST: (r: Request) => Promise<Response> };
    return POST(new Request(`${ORIGIN}/api/v1/console/sessions/${sid}/owner`, { method: "POST", headers: { ...headers, Cookie: cookie }, body: JSON.stringify(body) }));
  };
  const code = async (res: Response) => ((await res.json()) as { error: { code: string } | null }).error?.code;

  it("test_console_ownership_set_owner_is_admin_only_and_unknown_account_is_invalid", async () => {
    // A facilitator is refused 403 for every session, its own, another's and an unknown one alike, and nothing is called.
    for (const sid of [SID_MINE, SID_OTHER, SID_UNKNOWN]) {
      const s = ownerDeps();
      const res = await setOwner(sid, accountCookie(FACILITATOR), { owner: FACILITATOR.id });
      expect(res.status).toBe(403);
      expect(await code(res)).toBe("forbidden");
      expect(s.setOwner).not.toHaveBeenCalled();
      expect(s.accountsList).not.toHaveBeenCalled();
    }
    // An admin assigns any known account.
    let s = ownerDeps();
    let res = await setOwner(SID_UNOWNED, accountCookie(ADMIN), { owner: FACILITATOR.id });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ sessionId: SID_UNOWNED, owner: FACILITATOR.id });
    expect(s.setOwner.mock.calls).toEqual([[SID_UNOWNED, FACILITATOR.id]]);
    // Unknown and revoked accounts are `invalid`, and control is not asked to record them.
    for (const owner of ["acc-nobody-0000", REVOKED.id]) {
      s = ownerDeps();
      res = await setOwner(SID_OTHER, accountCookie(ADMIN), { owner });
      expect(res.status).toBe(400);
      expect(await code(res)).toBe("invalid");
      expect(s.setOwner).not.toHaveBeenCalled();
    }
    // null clears the owner (admin only from then on), without a list lookup.
    s = ownerDeps();
    res = await setOwner(SID_OTHER, accountCookie(ADMIN), { owner: null });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ sessionId: SID_OTHER, owner: null });
    expect(s.setOwner.mock.calls).toEqual([[SID_OTHER, null]]);
    // A legacy session acts as admin while the latch is open, and is signed out once it closes.
    s = ownerDeps();
    expect((await setOwner(SID_OTHER, legacyCookie("Ann"), { owner: FACILITATOR.id })).status).toBe(200);
    s.deps.auth.closeLatch();
    expect((await setOwner(SID_OTHER, legacyCookie("Ann"), { owner: FACILITATOR.id })).status).toBe(401);
    // An unknown session is the neutral 404.
    s = ownerDeps();
    res = await setOwner(SID_UNKNOWN, accountCookie(ADMIN), { owner: FACILITATOR.id });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NEUTRAL_BODY);
    // Malformed bodies are 400 bad_request before any call.
    for (const body of [{}, { owner: 7 }, { owner: "" }, { owner: "x".repeat(65) }, { owner: FACILITATOR.id, by: "x" }]) {
      s = ownerDeps();
      res = await setOwner(SID_OTHER, accountCookie(ADMIN), body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await code(res)).toBe("bad_request");
      expect(s.setOwner).not.toHaveBeenCalled();
    }
  });

  it("test_console_ownership_set_owner_checks_origin_header_and_must_change", async () => {
    for (const headers of [{ ...SAME, Origin: "https://evil.example" }, { ...SAME, "X-Requested-With": "" }, { ...SAME, "Sec-Fetch-Site": "cross-site" }]) {
      const s = ownerDeps();
      const res = await setOwner(SID_OTHER, accountCookie(ADMIN), { owner: FACILITATOR.id }, headers);
      expect(res.status).toBe(403);
      expect(s.setOwner).not.toHaveBeenCalled();
    }
    const auth = consoleAuth([{ ...ADMIN, mustChange: true }, FACILITATOR]);
    const s = ownerDeps(auth);
    const res = await setOwner(SID_OTHER, accountCookie(ADMIN), { owner: FACILITATOR.id });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("must_change_password");
    expect(s.setOwner).not.toHaveBeenCalled();
  });
});

describe("review writes: the account's audit name and throttle", () => {
  const reportDeps = () => {
    const deps = spiedDeps();
    const reportOpen = vi.fn(async () => ({}));
    const reportCancel = vi.fn(async () => ({}));
    const base = deps.launcher as unknown as Record<string, unknown>;
    deps.launcher = new Proxy(base, { get: (t, k) => (k === "reportOpen" ? reportOpen : k === "reportCancel" ? reportCancel : Reflect.get(t, k)) }) as unknown as Deps["launcher"];
    install(deps);
    return { deps, reportOpen, reportCancel };
  };
  const open = async (sid: string, cookie: string, body: unknown) => {
    const { consoleReportOpenPOST } = await import("../routes");
    return consoleReportOpenPOST(new Request(`${ORIGIN}/api/v1/console/sessions/${sid}/report/open`, { method: "POST", headers: { ...SAME, Cookie: cookie }, body: JSON.stringify(body) }));
  };

  it("test_console_ownership_account_slug_is_safe_and_bounded", () => {
    expect(accountSlug("Dana Cook", "acc-fac-0002")).toBe("dana-cook-accfac");
    expect(accountSlug("Ann Lee", "9f3a1c2b4d5e6f70")).toBe("ann-lee-9f3a1c");
    const long = accountSlug("Zoë O'Brien-Smith 李 ".repeat(8), "ABCDEF0123456789");
    expect(long).toMatch(/^[A-Za-z0-9_-]{1,56}$/);
    expect(long.endsWith("-abcdef")).toBe(true);
    expect(long.length).toBe(47);
    for (const name of ["李", "😀😀", "a", " ", "x".repeat(200)]) expect(accountSlug(name, "0123456789abcdef")).toMatch(/^[A-Za-z0-9_-]{1,56}$/);
    expect(accountSlug("😀", "0123456789abcdef")).toBe("--012345");
  });

  it("test_console_ownership_review_by_is_the_account_slug_and_body_by_is_ignored", async () => {
    let s = reportDeps();
    expect((await open(SID_MINE, accountCookie(FACILITATOR), { by: "Mallory" })).status).toBe(200);
    expect(s.reportOpen.mock.calls).toEqual([[SID_MINE, accountSlug(FACILITATOR.name, FACILITATOR.id)]]);
    s = reportDeps();
    expect((await open(SID_MINE, accountCookie(FACILITATOR), {})).status).toBe(200);
    expect(s.reportOpen.mock.calls).toEqual([[SID_MINE, "dana-cook-accfac"]]);
    // Even a `by` that would be refused as a name is ignored for an account.
    s = reportDeps();
    expect((await open(SID_OTHER, accountCookie(ADMIN), { by: "not a name!" })).status).toBe(200);
    expect(s.reportOpen.mock.calls).toEqual([[SID_OTHER, accountSlug(ADMIN.name, ADMIN.id)]]);
    // Legacy keeps today's rule: the typed name from the body, required and checked.
    s = reportDeps();
    expect((await open(SID_OTHER, legacyCookie("Ann"), { by: "ann_l" })).status).toBe(200);
    expect(s.reportOpen.mock.calls).toEqual([[SID_OTHER, "ann_l"]]);
    s = reportDeps();
    expect((await open(SID_OTHER, legacyCookie("Ann"), {})).status).toBe(400);
    expect(s.reportOpen).not.toHaveBeenCalled();
  });

  it("test_console_ownership_report_write_throttle_survives_a_cookie_reseal", async () => {
    const { consoleReportCancelPOST } = await import("../routes");
    const cancel = (cookie: string) =>
      consoleReportCancelPOST(new Request(`${ORIGIN}/api/v1/console/sessions/${SID_MINE}/report/evaluate/cancel`, { method: "POST", headers: { ...SAME, Cookie: cookie }, body: "{}" }));
    const s = reportDeps();
    for (let i = 0; i < 60; i++) expect((await cancel(accountCookie(FACILITATOR, { expiresAt: T0 + 1000 + i }))).status).toBe(200);
    // A new sign-in (a different cookie value) of the same account shares the bucket.
    const res = await cancel(accountCookie(FACILITATOR, { expiresAt: T0 + 5_000_000 }));
    expect(res.status).toBe(429);
    expect(s.reportCancel).toHaveBeenCalledTimes(60);
    // Another account has a bucket of its own.
    expect((await cancel(accountCookie(ADMIN))).status).toBe(200);
  });
});

describe("launcher client", () => {
  const BASE = "http://127.0.0.1:47123";
  const envelope = (data: unknown) => new Response(JSON.stringify({ success: true, data, error: null }), { status: 200, headers: { "Content-Type": "application/json" } });
  const client = (handler: (url: string, init: RequestInit) => Response) => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body === undefined ? undefined : JSON.parse(init.body as string) });
      return handler(String(input), init ?? {});
    });
    return { c: new LauncherClient({ baseUrl: BASE, token: "t".repeat(32), fetch: fetchFn as unknown as typeof fetch }), calls };
  };
  const INFO = { sessionId: SID_MINE, scenarioId: "friday-escalation", status: "running", port: 40001, modelLabel: "mock" };
  const ACC = { id: "0123456789abcdef", login: "dana@client.example", name: "Dana", role: "facilitator", status: "active", mustChange: false, epoch: 2, tempExpiresAt: null, createdAt: 1, createdBy: null };

  it("test_console_ownership_launcher_client_carries_owner_through_to_info", async () => {
    let k = client(() => envelope({ ...INFO, owner: FACILITATOR.id }));
    expect((await k.c.session(SID_MINE)).owner).toBe(FACILITATOR.id);
    k = client(() => envelope({ ...INFO, codes: [{ roleId: "alice", code: "ABCD" }] }));
    await k.c.createSession("friday-escalation", FACILITATOR.id);
    await k.c.createSession("friday-escalation");
    expect(k.calls.map((x) => x.body)).toEqual([{ scenarioId: "friday-escalation", owner: FACILITATOR.id }, { scenarioId: "friday-escalation" }]);
    k = client(() => envelope({ ...INFO, owner: OTHER_FAC.id }));
    expect((await k.c.setOwner(SID_MINE, OTHER_FAC.id)).owner).toBe(OTHER_FAC.id);
    await k.c.setOwner(SID_MINE, null);
    expect(k.calls).toEqual([
      { url: `${BASE}/sessions/${SID_MINE}/owner`, method: "PUT", body: { owner: OTHER_FAC.id } },
      { url: `${BASE}/sessions/${SID_MINE}/owner`, method: "PUT", body: { owner: null } },
    ]);
  });

  it("test_console_ownership_launcher_client_lists_accounts_field_by_field", async () => {
    const k = client(() => envelope({ accounts: [ACC, { ...ACC, id: "fedcba9876543210", role: "admin", password: { salt: "s", hash: "h" } }] }));
    const list = await k.c.accountsList();
    expect(k.calls).toEqual([{ url: `${BASE}/accounts`, method: "GET", body: undefined }]);
    expect(list).toEqual([
      { id: "0123456789abcdef", login: "dana@client.example", name: "Dana", role: "facilitator", status: "active", mustChange: false, epoch: 2 },
      { id: "fedcba9876543210", login: "dana@client.example", name: "Dana", role: "admin", status: "active", mustChange: false, epoch: 2 },
    ]);
    for (const bad of [{ accounts: [{ ...ACC, role: "root" }] }, { accounts: "x" }, [ACC]]) {
      await expect(client(() => envelope(bad)).c.accountsList()).rejects.toMatchObject({ reason: "failed" });
    }
  });
});

describe("a change of owner ends the session's open streams", () => {
  /** A facilitator connection whose join answers like the runtime's. */
  class FacConn extends FakeConn {
    async joinFacilitator() {
      return {
        frame: { type: "joined" as const, roleId: "facilitator", scenes: [], replay: { afterSeq: 0, toSeq: 0, events: 0, complete: true }, state: { status: "running", lastSeq: 0 } as never },
        roster: [], status: "running" as const,
      };
    }
    override close() { super.close(); queueMicrotask(() => this.drop(1000)); }
  }

  let readers: ReturnType<typeof sseReader>[] = [];
  afterEach(async () => {
    for (const r of readers) await r.cancel().catch(() => {});
    readers = [];
  });

  /** Live sessions S (owned by FACILITATOR) and T (owned by OTHER_FAC); setOwner records into the same table the stream reads. */
  function liveDeps(o: { setOwnerFails?: boolean } = {}) {
    const owners = new Map<string, string | undefined>([[SID_MINE, FACILITATOR.id], [SID_OTHER, OTHER_FAC.id]]);
    const timers = manualTimers();
    const auth = consoleAuth([ADMIN, FACILITATOR, OTHER_FAC, REVOKED]);
    const setOwner = vi.fn(async (id: string, owner: string | null) => {
      if (o.setOwnerFails) throw new LauncherError("unavailable");
      if (!owners.has(id)) throw new LauncherError("not_found");
      owners.set(id, owner ?? undefined);
      const ow = owners.get(id);
      return { sessionId: id, scenarioId: "friday-escalation", status: "running" as const, ...(ow !== undefined && { owner: ow }) };
    });
    const deps = fakeDeps({
      auth,
      connect: (async () => new FacConn()) as unknown as Deps["connect"],
      facilitatorHub: new FacilitatorHub({ setTimer: timers.setTimer, now: () => T0 }),
      setTimer: timers.setTimer,
      launcher: {
        session: vi.fn(async (id: string) => {
          if (!owners.has(id)) throw new LauncherError("not_found");
          const ow = owners.get(id);
          return { sessionId: id, scenarioId: "friday-escalation", status: "running", port: 1, ...(ow !== undefined && { owner: ow }) };
        }),
        facilitator: vi.fn(async () => ({ port: 43_211, token: "facilitator-token-" + "f".repeat(20) })),
        accountsList: vi.fn(async () => [ADMIN, FACILITATOR, OTHER_FAC, REVOKED].map((a) => ({ ...a }))),
        setOwner,
      },
    });
    install(deps);
    return { deps, setOwner };
  }
  const streamReq = (sid: string, cookie: string) =>
    new Request(`${ORIGIN}/api/v1/console/sessions/${sid}/stream`, { headers: { Accept: "text/event-stream", "Sec-Fetch-Site": "same-origin", Cookie: cookie } });
  async function openStream(sid: string, cookie: string) {
    const { consoleStreamGET } = await import("../routes");
    const res = await consoleStreamGET(streamReq(sid, cookie));
    expect(res.status).toBe(200);
    const r = sseReader(res);
    readers.push(r);
    await until(() => r.frames().some((f) => f.event === "roster"), { what: "the roster frame" });
    return r;
  }
  const reconnect = async (sid: string, cookie: string) => {
    const { consoleStreamGET } = await import("../routes");
    return consoleStreamGET(streamReq(sid, cookie));
  };
  const assign = async (sid: string, owner: string | null) => {
    const { consoleSessionOwnerPOST } = await import("../routes");
    return consoleSessionOwnerPOST(new Request(`${ORIGIN}/api/v1/console/sessions/${sid}/owner`, { method: "POST", headers: { ...SAME, Cookie: accountCookie(ADMIN) }, body: JSON.stringify({ owner }) }));
  };
  const finalOf = (r: ReturnType<typeof sseReader>) => r.frames().map((f) => f.event).filter((e) => e === "reconnecting" || e === "expired" || e === "ended");

  it("test_console_ownership_reassigning_a_session_ends_its_open_streams", async () => {
    const { deps } = liveDeps();
    const a = await openStream(SID_MINE, accountCookie(FACILITATOR));
    const admin = await openStream(SID_MINE, accountCookie(ADMIN));
    const elsewhere = await openStream(SID_OTHER, accountCookie(OTHER_FAC));
    expect(deps.facilitatorHub.size()).toBe(3);
    expect((await assign(SID_MINE, OTHER_FAC.id)).status).toBe(200);
    // Every stream on that session ends at once and is told to reconnect; the reconnect's ownership check decides.
    await until(() => a.done() && admin.done(), { what: "the session's streams to end" });
    expect(finalOf(a)).toEqual(["reconnecting"]);
    expect(finalOf(admin)).toEqual(["reconnecting"]);
    // A stream on another session is untouched.
    expect(elsewhere.done()).toBe(false);
    expect(deps.facilitatorHub.size()).toBe(1);
    // The previous owner's reconnect is the neutral 404; the new owner's and the admin's reconnect open.
    const old = await reconnect(SID_MINE, accountCookie(FACILITATOR));
    expect(old.status).toBe(404);
    expect(await old.text()).toBe(NEUTRAL_BODY);
    await openStream(SID_MINE, accountCookie(OTHER_FAC));
    await openStream(SID_MINE, accountCookie(ADMIN));
  });

  it("test_console_ownership_clearing_the_owner_ends_its_open_streams", async () => {
    const { deps } = liveDeps();
    const a = await openStream(SID_MINE, accountCookie(FACILITATOR));
    const elsewhere = await openStream(SID_OTHER, accountCookie(OTHER_FAC));
    expect((await assign(SID_MINE, null)).status).toBe(200);
    await until(() => a.done(), { what: "the owner's stream to end" });
    expect(finalOf(a)).toEqual(["reconnecting"]);
    expect(elsewhere.done()).toBe(false);
    expect(deps.facilitatorHub.size()).toBe(1);
    expect((await reconnect(SID_MINE, accountCookie(FACILITATOR))).status).toBe(404);
  });

  it("test_console_ownership_a_failed_assignment_leaves_streams_open", async () => {
    // An unknown account is refused before control is asked; a control failure is refused after. Neither closes anything.
    for (const [fails, owner, status] of [[false, "acc-nobody-0000", 400], [false, REVOKED.id, 400], [true, OTHER_FAC.id, 502]] as const) {
      const { deps } = liveDeps({ setOwnerFails: fails });
      const close = vi.spyOn(deps.facilitatorHub, "closeSession");
      const a = await openStream(SID_MINE, accountCookie(FACILITATOR));
      expect((await assign(SID_MINE, owner)).status).toBe(status);
      expect(close).not.toHaveBeenCalled();
      expect(a.done()).toBe(false);
      expect(deps.facilitatorHub.size()).toBe(1);
      for (const r of readers) await r.cancel().catch(() => {});
      readers = [];
    }
  });

  it("test_console_ownership_a_throw_while_closing_streams_does_not_fail_the_assignment", async () => {
    const { deps, setOwner } = liveDeps();
    vi.spyOn(deps.facilitatorHub, "closeSession").mockImplementation(() => { throw new Error("boom"); });
    const res = await assign(SID_MINE, OTHER_FAC.id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ sessionId: SID_MINE, owner: OTHER_FAC.id });
    expect(setOwner).toHaveBeenCalledTimes(1);
  });

  it("test_console_ownership_hub_close_session_ends_only_that_sessions_streams", async () => {
    const { deps } = liveDeps();
    const a1 = await openStream(SID_MINE, accountCookie(FACILITATOR));
    const a2 = await openStream(SID_MINE, accountCookie(ADMIN));
    const b = await openStream(SID_OTHER, accountCookie(OTHER_FAC));
    expect(deps.facilitatorHub.closeSession(SID_MINE)).toBe(2);
    await until(() => a1.done() && a2.done(), { what: "both streams to end" });
    expect(b.done()).toBe(false);
    expect(deps.facilitatorHub.closeSession(SID_MINE)).toBe(0);
    expect(deps.facilitatorHub.closeSession(SID_UNKNOWN)).toBe(0);
    expect(deps.facilitatorHub.size()).toBe(1);
  });
});

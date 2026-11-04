import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config";
import { CONSOLE_COOKIE, secretEpoch } from "../console-session";
import { setEnvelopeClock } from "../envelope";
import { COOKIE_NAME, type Deps } from "../handlers";
import { LauncherError, type LauncherReason } from "../launcher-client";
import { consoleAiIntentsPOST, consoleAiRolesPOST } from "../routes";
import { seal } from "../seal";

const ORIGIN = "https://play.example.org";
const KEYS: Config["cookieKeys"] = [{ id: "k1", key: Buffer.alloc(32, 7) }];
const SECRET = "correct horse battery staple";
const T0 = 1_900_000_000_000;
const SID = "s-0123456789abcdef";
const CODE_H = "HHHH-1111-hhhh";

const config: Config = {
  runtimeUrl: "ws://127.0.0.1:1",
  publicOrigin: ORIGIN,
  cookieKeys: KEYS,
  cookieMaxAgeHours: 12,
  maxStreams: 10,
  maxStreamsPerSession: 10,
  maxStreamsPerAddress: 10,
  facilitatorSecret: SECRET,
  launcherUrl: "http://127.0.0.1:47123",
  launcherToken: "launcher-token-" + "t".repeat(20),
};
const consoleCookie = () =>
  `${CONSOLE_COOKIE}=${seal({ name: "Ann Lee", epoch: secretEpoch(SECRET), expiresAt: T0 + 3_600_000 }, KEYS, T0, "fac")}`;
const playerCookie = () =>
  `${COOKIE_NAME}=${seal({ sessionId: SID, roleId: "r", participantId: "p", credential: "c", logIdentity: "l", expiresAt: T0 + 3_600_000 }, KEYS, T0)}`;

const AI = {
  ai_role: [409, "This role is played by an AI player. Switch it back to human first."],
  ai_notice: [409, "This server's consent notice does not mention AI players. AI players need notice v2 or later."],
  ai_started: [409, "Roles can no longer be changed: the session has started."],
  ai_no_human: [409, "At least one role must stay human."],
  ai_too_many: [409, "At most 8 roles can be AI players."],
} as const;

type Launcher = { setAiRoles: ReturnType<typeof vi.fn>; intents: ReturnType<typeof vi.fn>; reissue: ReturnType<typeof vi.fn> };
let launcher: Launcher;
let deps: Deps;
let errors: string[];

beforeEach(() => {
  setEnvelopeClock(() => new Date(T0));
  launcher = {
    setAiRoles: vi.fn(async (_id: string, roles: string[]) => ({ roles, codes: [{ roleId: "delivery_lead", code: CODE_H }] })),
    intents: vi.fn(async () => []),
    reissue: vi.fn(async () => CODE_H),
  };
  deps = { config, now: () => T0, launcher: launcher as never } as unknown as Deps;
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
  vi.spyOn(console, "warn").mockImplementation((...a) => { errors.push(a.join(" ")); });
  vi.spyOn(console, "log").mockImplementation((...a) => { errors.push(a.join(" ")); });
});
afterEach(() => vi.restoreAllMocks());

const GUARDED = { Origin: ORIGIN, "X-Requested-With": "scenecoach", "Content-Type": "application/json" };
const post = (
  path: string,
  body: unknown = {},
  o: { cookie?: string | null; headers?: Record<string, string | null>; raw?: string } = {},
) => {
  const headers: Record<string, string> = { ...GUARDED };
  for (const [k, v] of Object.entries(o.headers ?? {})) (v === null ? delete headers[k] : (headers[k] = v));
  const cookie = o.cookie === undefined ? consoleCookie() : o.cookie;
  if (cookie !== null) headers.Cookie = cookie;
  return new Request(`${ORIGIN}/api/v1/console${path}`, { method: "POST", headers, body: o.raw ?? JSON.stringify(body) });
};
const json = async (res: Response) => (await res.json()) as { success: boolean; data: any; error: { code: string; message: string } | null };
async function handlers() {
  const m = await import("../console-ai");
  const s = await import("../console-sessions");
  return {
    roles: (r: Request) => m.handleConsoleAiRoles(r, deps),
    intents: (r: Request) => m.handleConsoleAiIntents(r, deps),
    reissue: (r: Request) => s.handleConsoleReissue(r, deps),
    remove: (r: Request) => s.handleConsoleRemove(r, deps),
  };
}
const rolesPath = `/sessions/${SID}/ai-roles`;
const ids = (n: number, len = 8) => Array.from({ length: n }, (_, i) => String(i).padStart(len, "a"));

describe("POST ai-roles guards", () => {
  it("is 401 without a console cookie or with a player cookie, 403 without Origin or X-Requested-With, and never calls the launcher", async () => {
    const h = await handlers();
    for (const cookie of [null, playerCookie()]) {
      const res = await h.roles(post(rolesPath, { roles: [] }, { cookie }));
      expect(res.status).toBe(401);
      const i = await h.intents(post(`${rolesPath}/tech_lead/intents`, {}, { cookie }));
      expect(i.status).toBe(401);
    }
    const bad: Record<string, string | null>[] = [{ Origin: null }, { "X-Requested-With": null }, { Origin: "https://evil.example" }, { "Sec-Fetch-Site": "cross-site" }];
    for (const headers of bad) {
      expect((await h.roles(post(rolesPath, { roles: [] }, { headers }))).status).toBe(403);
      expect((await h.intents(post(`${rolesPath}/tech_lead/intents`, {}, { headers }))).status).toBe(403);
    }
    expect(launcher.setAiRoles).not.toHaveBeenCalled();
    expect(launcher.intents).not.toHaveBeenCalled();
  });

  it("an extra key, 13 roles, a duplicate, 'Tech Lead', a non-array, a non-string and a long id are 400 and the launcher is never called", async () => {
    const h = await handlers();
    const bodies: unknown[] = [
      { roles: [], extra: 1 },
      { roles: ids(13) },
      { roles: ["tech_lead", "tech_lead"] },
      { roles: ["Tech Lead"] },
      { roles: ["../x"] },
      { roles: "tech_lead" },
      { roles: [1] },
      { roles: ["x".repeat(129)] },
      {},
      [],
      "x",
    ];
    for (const b of bodies) {
      const res = await h.roles(post(rolesPath, b));
      expect(res.status, JSON.stringify(b).slice(0, 40)).toBe(400);
      expect((await json(res)).error?.code).toBe("bad_request");
    }
    expect((await h.roles(post(rolesPath, null, { raw: "{nope" }))).status).toBe(400);
    expect((await h.roles(post(rolesPath, { roles: [] }, { headers: { "Content-Type": "text/plain" } }))).status).toBe(400);
    expect((await h.roles(post("/sessions/bad%20id/ai-roles", { roles: [] }))).status).toBe(404);
    expect(launcher.setAiRoles).not.toHaveBeenCalled();
  });

  it("a body of 12 ids of 128 characters (over 1 KiB) is accepted and one over 4 KiB is 400", async () => {
    const h = await handlers();
    const long = Array.from({ length: 12 }, (_, i) => String(i).padStart(2, "0") + "a".repeat(126));
    const raw = JSON.stringify({ roles: long });
    expect(raw.length).toBeGreaterThan(1024);
    expect(raw.length).toBeLessThan(4096);
    expect((await h.roles(post(rolesPath, null, { raw }))).status).toBe(200);
    expect(launcher.setAiRoles).toHaveBeenCalledWith(SID, long);
    launcher.setAiRoles.mockClear();
    const over = JSON.stringify({ roles: ["a"], pad: "x".repeat(4096) });
    const res = await h.roles(post(rolesPath, null, { raw: over }));
    expect(res.status).toBe(400);
    expect(launcher.setAiRoles).not.toHaveBeenCalled();
  });
});

describe("POST ai-roles answers", () => {
  it("forwards the roles and answers only { roles, codes } built from the launcher's reply", async () => {
    const h = await handlers();
    launcher.setAiRoles.mockResolvedValueOnce({
      roles: ["tech_lead"],
      codes: [{ roleId: "delivery_lead", code: CODE_H, token: "LEAK", port: 4242 }],
      port: 4242,
      token: "LEAK",
    });
    const res = await h.roles(post(rolesPath, { roles: ["tech_lead"] }));
    expect(res.status).toBe(200);
    expect(launcher.setAiRoles).toHaveBeenCalledWith(SID, ["tech_lead"]);
    const b = await json(res);
    expect(b.data).toEqual({ roles: ["tech_lead"], codes: [{ roleId: "delivery_lead", code: CODE_H }] });
    expect(JSON.stringify(b)).not.toContain("LEAK");
    expect(errors.join("\n")).not.toContain(CODE_H);
  });

  it("an empty list is accepted (all roles back to human)", async () => {
    const h = await handlers();
    expect((await h.roles(post(rolesPath, { roles: [] }))).status).toBe(200);
    expect(launcher.setAiRoles).toHaveBeenCalledWith(SID, []);
  });

  it("drops a code whose role is in roles, even when the launcher returned it (defence in depth)", async () => {
    const h = await handlers();
    launcher.setAiRoles.mockResolvedValueOnce({
      roles: ["tech_lead"],
      codes: [{ roleId: "tech_lead", code: "AIAI-0000" }, { roleId: "delivery_lead", code: CODE_H }],
    });
    const b = await json(await h.roles(post(rolesPath, { roles: ["tech_lead"] })));
    expect(b.data.codes).toEqual([{ roleId: "delivery_lead", code: CODE_H }]);
    expect(JSON.stringify(b)).not.toContain("AIAI-0000");
  });

  it.each(Object.keys(AI) as (keyof typeof AI)[])("%s answers its own copy and never the launcher's text", async (reason) => {
    const h = await handlers();
    launcher.setAiRoles.mockRejectedValueOnce(new LauncherError(reason as LauncherReason));
    const res = await h.roles(post(rolesPath, { roles: ["tech_lead"] }));
    expect(res.status).toBe(AI[reason][0]);
    const b = await json(res);
    expect(b.error).toEqual({ code: reason, message: AI[reason][1] });
  });

  it("the launcher's own message text never reaches the answer", async () => {
    const h = await handlers();
    const err = new LauncherError("ai_started");
    err.message = "SECRET launcher text";
    launcher.setAiRoles.mockRejectedValueOnce(err);
    const res = await h.roles(post(rolesPath, { roles: ["tech_lead"] }));
    expect(JSON.stringify(await json(res))).not.toContain("SECRET");
  });

  it("ai_invalid is a generic 400", async () => {
    const h = await handlers();
    launcher.setAiRoles.mockRejectedValueOnce(new LauncherError("ai_invalid"));
    const res = await h.roles(post(rolesPath, { roles: ["tech_lead"] }));
    expect(res.status).toBe(400);
    expect((await json(res)).error?.code).toBe("bad_request");
  });

  it("a timeout is 504 ai_roles_unconfirmed with its exact copy", async () => {
    const h = await handlers();
    launcher.setAiRoles.mockRejectedValueOnce(new LauncherError("timeout"));
    const res = await h.roles(post(rolesPath, { roles: ["tech_lead"] }));
    expect(res.status).toBe(504);
    expect((await json(res)).error).toEqual({
      code: "ai_roles_unconfirmed",
      message: "The change may or may not have been made. Check the roster, then switch the role again.",
    });
  });

  it.each([
    ["not_found", 404, "not_found"],
    ["conflict", 409, "conflict"],
    ["unavailable", 502, "launcher_unavailable"],
    ["failed", 502, "launcher_unavailable"],
  ] as const)("%s maps like the other console routes", async (reason, status, code) => {
    const h = await handlers();
    launcher.setAiRoles.mockRejectedValueOnce(new LauncherError(reason));
    const res = await h.roles(post(rolesPath, { roles: ["tech_lead"] }));
    expect(res.status).toBe(status);
    expect((await json(res)).error?.code).toBe(code);
  });

  it("no launcher configured is the unreachable answer", async () => {
    const h = await handlers();
    delete (deps as { launcher?: unknown }).launcher;
    expect((await h.roles(post(rolesPath, { roles: [] }))).status).toBe(502);
  });
});

describe("POST ai-roles/:roleId/intents", () => {
  it("answers { entries } from the launcher", async () => {
    const h = await handlers();
    const e = { ts: 1, sceneId: "s1", trigger: "reply", outcome: "spoken" };
    launcher.intents.mockResolvedValueOnce([{ ...e, extra: 1 }]);
    const res = await h.intents(post(`${rolesPath}/tech_lead/intents`, {}));
    expect(res.status).toBe(200);
    expect(launcher.intents).toHaveBeenCalledWith(SID, "tech_lead");
    expect((await json(res)).data).toEqual({ entries: [e] });
  });

  it("a roleId that is not an id is 404 with no launcher call", async () => {
    const h = await handlers();
    for (const seg of ["..%2F", "Tech%20Lead", "%E0%A4%A", "x".repeat(129), ".."]) {
      const res = await h.intents(post(`${rolesPath}/${seg}/intents`, {}));
      expect(res.status, seg).toBe(404);
    }
    expect(launcher.intents).not.toHaveBeenCalled();
  });

  it("a body with a key is 400 and the launcher is not called", async () => {
    const h = await handlers();
    expect((await h.intents(post(`${rolesPath}/tech_lead/intents`, { x: 1 }))).status).toBe(400);
    expect(launcher.intents).not.toHaveBeenCalled();
  });

  it("launcher failures map like the other routes", async () => {
    const h = await handlers();
    launcher.intents.mockRejectedValueOnce(new LauncherError("not_found"));
    expect((await h.intents(post(`${rolesPath}/tech_lead/intents`, {}))).status).toBe(404);
    launcher.intents.mockRejectedValueOnce(new LauncherError("unavailable"));
    expect((await h.intents(post(`${rolesPath}/tech_lead/intents`, {}))).status).toBe(502);
  });
});

describe("reissue and remove of an AI role", () => {
  it("answer the same ai_role copy", async () => {
    const h = await handlers();
    for (const [name, path] of [["reissue", `/sessions/${SID}/reissue`], ["remove", `/sessions/${SID}/remove`]] as const) {
      launcher.reissue.mockRejectedValueOnce(new LauncherError("ai_role"));
      const res = await h[name](post(path, { roleId: "tech_lead" }));
      expect(res.status, name).toBe(409);
      expect((await json(res)).error).toEqual({ code: "ai_role", message: AI.ai_role[1] });
    }
  });
});

describe("route bindings", () => {
  it("are functions exported through routes.ts", () => {
    expect(typeof consoleAiRolesPOST).toBe("function");
    expect(typeof consoleAiIntentsPOST).toBe("function");
  });
});

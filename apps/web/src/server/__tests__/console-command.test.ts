import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config";
import { CONSOLE_COOKIE, secretEpoch } from "../console-session";
import { setEnvelopeClock } from "../envelope";
import type { CommandOutcome } from "../facilitator-hub";
import { COOKIE_NAME, type Deps } from "../handlers";
import { seal } from "../seal";
import { COMMAND_ANSWERS, COMMAND_MAX_BODY_BYTES, handleConsoleCommand, handleConsoleFacts } from "../console-command";

const ORIGIN = "https://play.example.org";
const KEYS: Config["cookieKeys"] = [{ id: "k1", key: Buffer.alloc(32, 7) }];
const SECRET = "correct horse battery staple";
const T0 = 1_900_000_000_000;
const SID = "s-0123456789abcdef";
const OTHER = "s-fedcba9876543210";
const CH = "0b9f6c1e-2d3a-4c5b-8e7f-1a2b3c4d5e6f";
const NAME = "Ann Lee";
const config: Config = {
  runtimeUrl: "ws://127.0.0.1:1", publicOrigin: ORIGIN, cookieKeys: KEYS, cookieMaxAgeHours: 12, maxStreams: 10, maxStreamsPerSession: 10,
  maxStreamsPerAddress: 10, facilitatorSecret: SECRET, launcherUrl: "http://127.0.0.1:47123", launcherToken: "launcher-token-" + "t".repeat(20),
};
const consoleCookie = (name = NAME) => `${CONSOLE_COOKIE}=${seal({ name, epoch: secretEpoch(SECRET), expiresAt: T0 + 3_600_000 }, KEYS, T0, "fac")}`;
const playerCookie = () => `${COOKIE_NAME}=${seal({ sessionId: SID, roleId: "r", participantId: "p", credential: "c", logIdentity: "l", expiresAt: T0 + 3_600_000 }, KEYS, T0)}`;

let send: ReturnType<typeof vi.fn>;
let factsFor: ReturnType<typeof vi.fn>;
let deps: Deps;
let logs: string[];

beforeEach(() => {
  setEnvelopeClock(() => new Date(T0));
  send = vi.fn(async (): Promise<CommandOutcome> => ({ kind: "ok" }));
  factsFor = vi.fn((): unknown => null);
  deps = { config, now: () => T0, launcher: {} as never, facilitatorHub: { send, factsFor } } as unknown as Deps;
  logs = [];
  for (const m of ["error", "warn", "log", "info"] as const) vi.spyOn(console, m).mockImplementation((...a) => { logs.push(a.join(" ")); });
});
afterEach(() => { vi.restoreAllMocks(); });

const GUARDED = { Origin: ORIGIN, "X-Requested-With": "scenecoach", "Content-Type": "application/json" };
const post = (path: string, body: unknown, o: { cookie?: string | null; headers?: Record<string, string | null>; raw?: string } = {}) => {
  const headers: Record<string, string> = { ...GUARDED };
  for (const [k, v] of Object.entries(o.headers ?? {})) { if (v === null) delete headers[k]; else headers[k] = v; }
  const cookie = o.cookie === undefined ? consoleCookie() : o.cookie;
  if (cookie !== null) headers.Cookie = cookie;
  return new Request(`${ORIGIN}/api/v1/console/sessions/${path}`, { method: "POST", headers, body: o.raw ?? JSON.stringify(body) });
};
const command = (body: unknown, o?: Parameters<typeof post>[2]) => handleConsoleCommand(post(`${SID}/command`, body, o), deps);
const facts = (body: unknown, o?: Parameters<typeof post>[2]) => handleConsoleFacts(post(`${SID}/facts`, body, o), deps);
const json = async (res: Response) => (await res.json()) as { success: boolean; data: any; error: { code: string; message: string } | null };

describe("the guards of the command and facts routes", () => {
  const routes: [string, (b: unknown, o?: Parameters<typeof post>[2]) => Promise<Response>, unknown][] = [
    ["command", command, { channel: CH, kind: "pause" }],
    ["facts", facts, { channel: CH }],
  ];
  it("a foreign or missing Origin, a missing X-Requested-With and Sec-Fetch-Site cross-site are 403 and the hub is not called", async () => {
    for (const [name, call, body] of routes)
      for (const headers of <Record<string, string | null>[]>[{ Origin: "https://evil.example.com" }, { Origin: null }, { "X-Requested-With": null }, { "Sec-Fetch-Site": "cross-site" }]) {
        expect((await call(body, { headers })).status, `${name} ${JSON.stringify(headers)}`).toBe(403);
      }
    expect(send).not.toHaveBeenCalled();
    expect(factsFor).not.toHaveBeenCalled();
  });

  it("a player cookie is 401; a disabled console is 503", async () => {
    for (const [, call, body] of routes) {
      for (const cookie of [null, playerCookie()]) expect((await call(body, { cookie })).status).toBe(401);
    }
    deps = { ...deps, config: { ...config, facilitatorSecret: undefined } } as Deps;
    for (const [, call, body] of routes) expect((await call(body)).status).toBe(503);
    expect(send).not.toHaveBeenCalled();
    expect(factsFor).not.toHaveBeenCalled();
  });

  it("a session id that is not valid is 404", async () => {
    const res = await handleConsoleCommand(post("bad%20id!/command", { channel: CH, kind: "pause" }), deps);
    expect(res.status).toBe(404);
  });
});

describe("the command route", () => {
  it("each kind maps to its runtime message with by from the cookie", async () => {
    const cases: [Record<string, unknown>, unknown][] = [
      [{ kind: "pause" }, { type: "command", command: { command: "pause" }, by: NAME }],
      [{ kind: "resume" }, { type: "command", command: { command: "resume" }, by: NAME }],
      [{ kind: "advance" }, { type: "command", command: { command: "advance" }, by: NAME }],
      [{ kind: "advance", expectSceneId: "s1" }, { type: "command", command: { command: "advance" }, expectSceneId: "s1", by: NAME }],
      [{ kind: "fire_inject", injectId: "inj-1", expectSceneId: "s1" }, { type: "command", command: { command: "fire_inject", injectId: "inj-1" }, expectSceneId: "s1", by: NAME }],
      [{ kind: "whisper", roleId: "a", text: " psst ", expectSceneId: "s1" }, { type: "command", command: { command: "whisper", roleId: "a", text: " psst " }, expectSceneId: "s1", by: NAME }],
      [{ kind: "release_hidden", roleId: "npc", fact: 2 }, { type: "command", command: { command: "release_hidden", roleId: "npc", fact: 2 }, by: NAME }],
      [{ kind: "set_npc_stance", roleId: "npc", goals: ["  one ", "two"] }, { type: "command", command: { command: "set_npc_stance", roleId: "npc", goals: ["one", "two"] }, by: NAME }],
      [{ kind: "end_now" }, { type: "end_now", by: NAME }],
      [{ kind: "end_now", message: "Thanks all" }, { type: "end_now", message: "Thanks all", by: NAME }],
    ];
    for (const [body, wire] of cases) {
      send.mockClear();
      const res = await command({ channel: CH, ...body });
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect((await json(res)).data).toEqual({ done: true });
      expect(send).toHaveBeenCalledWith({ sessionId: SID, channel: CH, message: wire });
    }
  });

  it("a body carrying by is 400", async () => {
    for (const kind of [{ kind: "pause" }, { kind: "end_now" }]) {
      expect((await command({ channel: CH, ...kind, by: "Mallory" })).status).toBe(400);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("unknown keys, a key another kind takes (pause with text), an unknown kind, fact 0, 51 or 1.5, whisper text empty, blank or 2001 units, 11 goals or a 501-unit goal, a closing message of 301 code points, a non-UUID channel, and text/plain are 400", async () => {
    const goals = (n: number, len = 3) => Array.from({ length: n }, () => "g".repeat(len));
    const bad: [string, unknown, Parameters<typeof post>[2]?][] = [
      ["unknown key", { channel: CH, kind: "pause", extra: 1 }],
      ["pause with text", { channel: CH, kind: "pause", text: "x" }],
      ["advance with roleId", { channel: CH, kind: "advance", roleId: "a" }],
      ["expectSceneId on end_now", { channel: CH, kind: "end_now", expectSceneId: "s1" }],
      ["unknown kind", { channel: CH, kind: "explode" }],
      ["no kind", { channel: CH }],
      ["fact 0", { channel: CH, kind: "release_hidden", roleId: "a", fact: 0 }],
      ["fact 51", { channel: CH, kind: "release_hidden", roleId: "a", fact: 51 }],
      ["fact 1.5", { channel: CH, kind: "release_hidden", roleId: "a", fact: 1.5 }],
      ["fact string", { channel: CH, kind: "release_hidden", roleId: "a", fact: "1" }],
      ["whisper empty", { channel: CH, kind: "whisper", roleId: "a", text: "" }],
      ["whisper blank", { channel: CH, kind: "whisper", roleId: "a", text: " \n\t " }],
      ["whisper 2001", { channel: CH, kind: "whisper", roleId: "a", text: "x".repeat(2001) }],
      ["11 goals", { channel: CH, kind: "set_npc_stance", roleId: "a", goals: goals(11) }],
      ["no goals", { channel: CH, kind: "set_npc_stance", roleId: "a", goals: [] }],
      ["501-unit goal", { channel: CH, kind: "set_npc_stance", roleId: "a", goals: ["x".repeat(501)] }],
      ["blank goal", { channel: CH, kind: "set_npc_stance", roleId: "a", goals: ["ok", "   "] }],
      ["goal not a string", { channel: CH, kind: "set_npc_stance", roleId: "a", goals: [1] }],
      ["301 code points", { channel: CH, kind: "end_now", message: "😀".repeat(301) }],
      ["non-UUID channel", { channel: "abc", kind: "pause" }],
      ["upper-case channel", { channel: CH.toUpperCase(), kind: "pause" }],
      ["bad role id", { channel: CH, kind: "whisper", roleId: "../x", text: "hi" }],
      ["text/plain", { channel: CH, kind: "pause" }, { headers: { "Content-Type": "text/plain" } }],
    ];
    for (const [name, body, o] of bad) expect((await command(body, o)).status, name).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  const padded = (bytes: number) => {
    const base = JSON.stringify({ channel: CH, kind: "pause" });
    return base + " ".repeat(bytes - Buffer.byteLength(base));
  };

  it("a valid body of 32768 bytes reaches the hub and one of 32769 bytes is 400", async () => {
    const at = padded(32768);
    expect(Buffer.byteLength(at)).toBe(32768);
    expect((await command(null, { raw: at })).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    send.mockClear();
    const over = padded(32769);
    expect(Buffer.byteLength(over)).toBe(32769);
    expect((await command(null, { raw: over })).status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("a stance of 10 goals of 500 three-byte characters is accepted", async () => {
    const goals = Array.from({ length: 10 }, () => "€".repeat(500));
    const raw = JSON.stringify({ channel: CH, kind: "set_npc_stance", roleId: "a", goals });
    expect(Buffer.byteLength(raw)).toBeGreaterThan(15_000);
    const res = await command(null, { raw });
    expect(res.status).toBe(200);
    expect(send.mock.calls[0]![0].message.command.goals).toEqual(goals);
  });

  it("a stance of 10 goals of 500 control characters (escaped to about 30 KB) is accepted", async () => {
    const goals = Array.from({ length: 10 }, () => "\u0001".repeat(500));
    const raw = JSON.stringify({ channel: CH, kind: "set_npc_stance", roleId: "a", goals });
    expect(Buffer.byteLength(raw)).toBeGreaterThan(29_000);
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(32768);
    const res = await command(null, { raw });
    // "\u0001" is not whitespace, so trim keeps it: 500 units each.
    expect(res.status).toBe(200);
    expect(send.mock.calls[0]![0].message.command.goals).toHaveLength(10);
  });

  it("the end_now closing message is counted in code points: 300 emoji are accepted, 301 are 400", async () => {
    expect((await command({ channel: CH, kind: "end_now", message: "😀".repeat(300) })).status).toBe(200);
    expect((await command({ channel: CH, kind: "end_now", message: "😀".repeat(301) })).status).toBe(400);
  });

  it("the accepted side of each boundary: whisper 2000, fact 1 and 50, a 500-unit goal, scene ids on pause and resume are mapped", async () => {
    const ok = [
      { kind: "whisper", roleId: "a", text: "x".repeat(2000) },
      { kind: "release_hidden", roleId: "a", fact: 1 },
      { kind: "release_hidden", roleId: "a", fact: 50 },
      { kind: "set_npc_stance", roleId: "a", goals: [" " + "g".repeat(500) + " "] },
    ];
    for (const b of ok) expect((await command({ channel: CH, ...b })).status, JSON.stringify(b).slice(0, 60)).toBe(200);
  });

  it("an expectSceneId on pause or resume is 400; a bad injectId and a bad expectSceneId are 400", async () => {
    for (const body of [
      { kind: "pause", expectSceneId: "s1" }, { kind: "resume", expectSceneId: "s1" },
      { kind: "fire_inject", injectId: "../x" }, { kind: "fire_inject", injectId: "" }, { kind: "fire_inject", injectId: 5 },
      { kind: "advance", expectSceneId: "../x" }, { kind: "advance", expectSceneId: 5 },
    ]) expect((await command({ channel: CH, ...body })).status, JSON.stringify(body)).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("no launcher is 502 launcher_unavailable after the body checks and before the hub", async () => {
    deps = { ...deps, launcher: undefined } as Deps;
    const res = await command({ channel: CH, kind: "pause" });
    expect(res.status).toBe(502);
    expect((await json(res)).error?.code).toBe("launcher_unavailable");
    expect((await command({ channel: CH, kind: "nope" })).status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("a runtime refusal whose code is pending, no_channel, unconfirmed or other gets the safe default", async () => {
    for (const code of ["pending", "no_channel", "unconfirmed", "other"]) {
      send.mockResolvedValue({ kind: "refused", code });
      const res = await command({ channel: CH, kind: "pause" });
      expect(res.status, code).toBe(502);
      expect((await json(res)).error).toEqual({ code: "command_failed", message: "The session could not take that action. Check the live view, then try again." });
    }
  });

  it("a channel of another session is 409 no_channel and nothing is sent", async () => {
    send.mockImplementation(async (a: { sessionId: string }) => (a.sessionId === OTHER ? { kind: "ok" } : { kind: "no_channel" }));
    const res = await command({ channel: CH, kind: "pause" });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toEqual({ code: "no_channel", message: COMMAND_ANSWERS.no_channel.message });
    // The hub is asked only for the session in the URL, never another.
    expect(send.mock.calls.every((c) => c[0].sessionId === SID)).toBe(true);
  });

  const rows: [string, CommandOutcome, number, string, string][] = [
    ["stale_scene", { kind: "refused", code: "stale_scene" }, 409, "stale_scene", "The scene changed. Review the live view and try again."],
    ["not_started", { kind: "refused", code: "not_started" }, 409, "not_started", "The session has not started yet."],
    ["starting", { kind: "refused", code: "starting" }, 409, "starting", "The session is still starting. Try again in a moment."],
    ["ended", { kind: "refused", code: "ended" }, 409, "ended", "The session has ended."],
    ["already_released", { kind: "refused", code: "already_released" }, 409, "already_released", "That fact is already released."],
    ["unknown_inject", { kind: "refused", code: "unknown_inject" }, 409, "conflict", "That action is not possible in the session's current state."],
    ["unknown_role", { kind: "refused", code: "unknown_role" }, 409, "conflict", "That action is not possible in the session's current state."],
    ["npc_role", { kind: "refused", code: "npc_role" }, 409, "conflict", "That action is not possible in the session's current state."],
    ["unknown_fact", { kind: "refused", code: "unknown_fact" }, 409, "conflict", "That action is not possible in the session's current state."],
    ["rate_limited", { kind: "refused", code: "rate_limited" }, 429, "rate_limited", "Too many actions at once. Wait a moment and try again."],
    ["log_failed (any other code)", { kind: "refused", code: "log_failed" }, 502, "command_failed", "The session could not take that action. Check the live view, then try again."],
    ["a code that is a table key but not a runtime code", { kind: "refused", code: "constructor" }, 502, "command_failed", "The session could not take that action. Check the live view, then try again."],
    ["unconfirmed", { kind: "unconfirmed" }, 504, "command_unconfirmed", "The session did not confirm the action. Check the live view before you try again."],
    ["no_channel", { kind: "no_channel" }, 409, "no_channel", "The live view is not connected. Wait until it is live again, then try again."],
    ["pending", { kind: "pending" }, 409, "command_pending", "Another action is still being confirmed. Wait a moment, then try again."],
  ];
  for (const [name, outcome, status, code, message] of rows)
    it(`answers ${name} with ${status} ${code}${name === "stale_scene" ? ` and "${message}"` : ""}`, async () => {
      send.mockResolvedValue(outcome);
      const res = await command({ channel: CH, kind: "advance", expectSceneId: "s1" });
      expect(res.status).toBe(status);
      const b = await json(res);
      expect(b.success).toBe(false);
      expect(b.error).toEqual({ code, message });
    });

  it("a refusal is answered with fixed copy only: the runtime's message text never appears in the body", async () => {
    // The hub's outcome has no message field; even a stray one on the object must not be echoed.
    send.mockResolvedValue({ kind: "refused", code: "stale_scene", message: "RUNTIME-SECRET-TEXT Pat said", text: "RUNTIME-SECRET-TEXT" } as unknown as CommandOutcome);
    const res = await command({ channel: CH, kind: "advance" });
    const text = await res.text();
    expect(text).not.toContain("RUNTIME-SECRET-TEXT");
    expect(text).not.toContain("Pat");
  });

  it("responses carry noindex and no-store", async () => {
    for (const outcome of [{ kind: "ok" }, { kind: "refused", code: "x" }, { kind: "unconfirmed" }] as CommandOutcome[]) {
      send.mockResolvedValue(outcome);
      const res = await command({ channel: CH, kind: "pause" });
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    }
    const bad = await command({ kind: "pause" });
    expect(bad.headers.get("Cache-Control")).toBe("no-store");
    expect(bad.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("no log line carries the channel, a name or the command text", async () => {
    const text = "WHISPER-TEXT-XYZ";
    for (const outcome of [{ kind: "ok" }, { kind: "refused", code: "log_failed" }, { kind: "unconfirmed" }, { kind: "no_channel" }] as CommandOutcome[]) {
      send.mockResolvedValue(outcome);
      await command({ channel: CH, kind: "whisper", roleId: "a", text });
    }
    await command({ channel: CH, kind: "whisper", roleId: "a", text: "" });
    await facts({ channel: CH });
    for (const line of logs) {
      expect(line).not.toContain(CH);
      expect(line).not.toContain(NAME);
      expect(line).not.toContain(text);
    }
  });
});

describe("the facts route", () => {
  it("a body with a key other than channel or a non-UUID channel is 400", async () => {
    for (const body of [{ channel: CH, extra: 1 }, { channel: CH, by: "x" }, { channel: "nope" }, { channel: 5 }, {}]) {
      expect((await facts(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await facts({ channel: CH }, { headers: { "Content-Type": "text/plain" } })).status).toBe(400);
    expect(factsFor).not.toHaveBeenCalled();
  });

  it("an unknown channel or another session's channel is 409 no_channel", async () => {
    const res = await facts({ channel: CH });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toEqual({ code: "no_channel", message: "The live view is not connected. Wait until it is live again, then try again." });
    expect(factsFor).toHaveBeenCalledWith(SID, CH);
  });

  it("a known channel is 200 with the fact text and no knowledge, goals or role other than the hidden-fact keys", async () => {
    const roles = [{ roleId: "npc", facts: [{ n: 1, text: "The vault code is 1234" }, { n: 2, text: "She lied" }] }];
    // The hub's value is the only source; the route adds nothing and passes no other key on.
    factsFor.mockReturnValue(roles.map((r) => ({ ...r, goals: ["GOAL"], knowledge: ["KNOW"] })));
    const res = await facts({ channel: CH });
    expect(res.status).toBe(200);
    const b = await json(res);
    expect(Object.keys(b.data)).toEqual(["roles"]);
    expect(b.data.roles[0].facts).toEqual(roles[0]!.facts);
    expect(b.data.roles).toEqual(roles);
    expect(JSON.stringify(b)).not.toMatch(/GOAL|KNOW/);
  });

  it("a stray key inside a fact item or a role never leaves", async () => {
    factsFor.mockReturnValue([{ roleId: "npc", knowledge: ["K"], facts: [{ n: 1, text: "T", released: true, goal: "G" }] }]);
    const b = await json(await facts({ channel: CH }));
    expect(b.data).toEqual({ roles: [{ roleId: "npc", facts: [{ n: 1, text: "T" }] }] });
  });

  it("the response is no-store and noindex", async () => {
    factsFor.mockReturnValue([]);
    for (const res of [await facts({ channel: CH }), await facts({ channel: "x" })]) {
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    }
  });
});

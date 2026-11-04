import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config";
import { handleConsoleAiPrompt } from "../console-ai";
import { CONSOLE_COOKIE, secretEpoch } from "../console-session";
import { setEnvelopeClock } from "../envelope";
import type { CommandOutcome } from "../facilitator-hub";
import { COOKIE_NAME, type Deps } from "../handlers";
import { LauncherError, type LauncherReason } from "../launcher-client";
import { consoleAiPromptPOST } from "../routes";
import { seal } from "../seal";

const ORIGIN = "https://play.example.org";
const KEYS: Config["cookieKeys"] = [{ id: "k1", key: Buffer.alloc(32, 7) }];
const SECRET = "correct horse battery staple";
const T0 = 1_900_000_000_000;
const SID = "s-0123456789abcdef";
const CH = "0b9f6c1e-2d3a-4c5b-8e7f-1a2b3c4d5e6f";
const RES = "0123456789abcdef0123456789abcdef";
const MARK = "HINT-MARKER-77";
const config: Config = {
  runtimeUrl: "ws://127.0.0.1:1", publicOrigin: ORIGIN, cookieKeys: KEYS, cookieMaxAgeHours: 12, maxStreams: 10, maxStreamsPerSession: 10,
  maxStreamsPerAddress: 10, facilitatorSecret: SECRET, launcherUrl: "http://127.0.0.1:47123", launcherToken: "launcher-token-" + "t".repeat(20),
};
const consoleCookie = (name = "Ann Lee") => `${CONSOLE_COOKIE}=${seal({ name, epoch: secretEpoch(SECRET), expiresAt: T0 + 3_600_000 }, KEYS, T0, "fac")}`;
const playerCookie = () => `${COOKIE_NAME}=${seal({ sessionId: SID, roleId: "r", participantId: "p", credential: "c", logIdentity: "l", expiresAt: T0 + 3_600_000 }, KEYS, T0)}`;

let order: string[];
let launcher: { reserveTurn: ReturnType<typeof vi.fn>; runTurn: ReturnType<typeof vi.fn>; releaseTurn: ReturnType<typeof vi.fn> };
let send: ReturnType<typeof vi.fn>;
let deps: Deps;
let logs: string[];

beforeEach(() => {
  setEnvelopeClock(() => new Date(T0));
  order = [];
  launcher = {
    reserveTurn: vi.fn(async () => { order.push("reserve"); return RES; }),
    runTurn: vi.fn(async () => { order.push("run"); }),
    releaseTurn: vi.fn(async () => { order.push("release"); }),
  };
  send = vi.fn(async (): Promise<CommandOutcome> => { order.push("command"); return { kind: "ok" }; });
  deps = { config, now: () => T0, launcher: launcher as never, facilitatorHub: { send } } as unknown as Deps;
  logs = [];
  for (const m of ["error", "warn", "log", "info"] as const) vi.spyOn(console, m).mockImplementation((...a) => { logs.push(a.join(" ")); });
});
afterEach(() => vi.restoreAllMocks());

const GUARDED = { Origin: ORIGIN, "X-Requested-With": "scenecoach", "Content-Type": "application/json" };
const post = (body: unknown, o: { cookie?: string | null; headers?: Record<string, string | null>; path?: string; raw?: string } = {}) => {
  const headers: Record<string, string> = { ...GUARDED };
  for (const [k, v] of Object.entries(o.headers ?? {})) { if (v === null) delete headers[k]; else headers[k] = v; }
  const cookie = o.cookie === undefined ? consoleCookie() : o.cookie;
  if (cookie !== null) headers.Cookie = cookie;
  return new Request(`${ORIGIN}/api/v1/console/sessions/${SID}/ai-roles/${o.path ?? "tech_lead"}/prompt`, { method: "POST", headers, body: o.raw ?? JSON.stringify(body) });
};
const prompt = (body: unknown, o?: Parameters<typeof post>[1]) => handleConsoleAiPrompt(post(body, o), deps);
const json = async (res: Response) => (await res.json()) as { success: boolean; data: any; error: { code: string; message: string } | null };
const good = { channel: CH };
const untouched = () => {
  expect(launcher.reserveTurn).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
};

describe("prompt an AI player: guards", () => {
  it("is 401 without a console cookie or with a player cookie, 403 without Origin, X-Requested-With or on cross-site", async () => {
    for (const cookie of [null, playerCookie()]) expect((await prompt(good, { cookie })).status).toBe(401);
    const bad: Record<string, string | null>[] = [{ Origin: null }, { "X-Requested-With": null }, { Origin: "https://evil.example" }, { "Sec-Fetch-Site": "cross-site" }];
    for (const headers of bad) expect((await prompt(good, { headers })).status).toBe(403);
    untouched();
  });

  it("a body with by, an extra key, a 301-code-point hint, a bad channel or a non-string hint is 400 before the launcher is called", async () => {
    const bodies: unknown[] = [
      { ...good, by: "Mallory" }, { ...good, extra: 1 }, { ...good, hint: "a".repeat(301) }, { ...good, hint: "\u{1F600}".repeat(301) },
      { ...good, hint: 5 }, { channel: "nope" }, {}, { channel: 5 },
    ];
    for (const b of bodies) expect((await prompt(b)).status, JSON.stringify(b).slice(0, 50)).toBe(400);
    expect((await prompt(null, { raw: "{nope" })).status).toBe(400);
    expect((await prompt(good, { headers: { "Content-Type": "text/plain" } })).status).toBe(400);
    untouched();
  });

  it("a hint that is 300 raw code points or fewer but longer than 300 after NFKC is 400 (the control side would drop it)", async () => {
    // "\uFB01" folds to "fi", "\u00BD" to "1\u20442", U+FDFA to 18 characters.
    for (const hint of ["\uFB01".repeat(151), "\u00BD".repeat(101), "\uFDFA".repeat(17), `${"a".repeat(299)}\uFB01`]) {
      expect(Array.from(hint).length, "raw").toBeLessThanOrEqual(300);
      expect((await prompt({ ...good, hint })).status, hint.slice(0, 5)).toBe(400);
    }
    untouched();
    expect((await prompt({ ...good, hint: "\uFB01".repeat(150) })).status).toBe(200);
    expect((await prompt({ ...good, hint: `${"a".repeat(300)} ` })).status).toBe(200);
  });

  it("a roleId that is not an id is 404 with no launcher call", async () => {
    for (const path of ["..%2F", "Tech%20Lead", "%E0%A4%A", "x".repeat(129)]) expect((await prompt(good, { path })).status, path).toBe(404);
    untouched();
  });

  it("a 300-code-point hint of 4-byte characters (1,200 bytes) is accepted and reaches runTurn whole", async () => {
    const hint = "\u{1F600}".repeat(300);
    expect(new TextEncoder().encode(hint).length).toBe(1200);
    expect((await prompt({ ...good, hint })).status).toBe(200);
    expect(launcher.runTurn).toHaveBeenCalledWith(SID, "tech_lead", RES, hint);
  });

  it("a valid body is accepted up to 4 KiB and is 400 only because of the byte cap beyond it", async () => {
    const valid = JSON.stringify(good);
    expect((await prompt(null, { raw: valid + " ".repeat(4096 - valid.length) })).status).toBe(200);
    expect((await prompt(null, { raw: valid + " ".repeat(4097 - valid.length) })).status).toBe(400);
    expect(launcher.reserveTurn).toHaveBeenCalledTimes(1);
  });
});

describe("prompt an AI player: the steps", () => {
  it("run in order reserve, command, run; the runtime message has no hint and carries by from the cookie; the answer is { done: true }", async () => {
    const res = await prompt({ ...good, hint: "say hello" }, { cookie: consoleCookie("Dana Cook") });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ done: true });
    expect(order).toEqual(["reserve", "command", "run"]);
    expect(launcher.reserveTurn).toHaveBeenCalledWith(SID, "tech_lead");
    expect(send).toHaveBeenCalledWith({
      sessionId: SID, channel: CH,
      message: { type: "command", command: { command: "prompt_ai", roleId: "tech_lead" }, by: "Dana Cook" },
    });
    expect(launcher.runTurn).toHaveBeenCalledWith(SID, "tech_lead", RES, "say hello");
    expect(launcher.releaseTurn).not.toHaveBeenCalled();
  });

  it("run is not started before the command's answer arrives, and is started after an ok one", async () => {
    let resolve!: (o: CommandOutcome) => void;
    send.mockImplementationOnce(() => new Promise<CommandOutcome>((r) => { order.push("command"); resolve = r; }));
    const pending = prompt(good);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(launcher.runTurn).not.toHaveBeenCalled();
    resolve({ kind: "ok" });
    expect((await pending).status).toBe(200);
    expect(order).toEqual(["reserve", "command", "run"]);
  });

  it("a throwing send releases the reservation and answers the neutral command failure", async () => {
    send.mockRejectedValueOnce(new Error("boom RES"));
    const res = await prompt(good);
    expect(res.status).toBe(502);
    expect((await json(res)).error?.code).toBe("command_failed");
    expect(launcher.releaseTurn).toHaveBeenCalledWith(SID, "tech_lead", RES);
    expect(launcher.runTurn).not.toHaveBeenCalled();
  });

  it("without a hint, runTurn gets no hint", async () => {
    await prompt(good);
    expect(launcher.runTurn.mock.calls[0]).toEqual([SID, "tech_lead", RES, undefined]);
  });

  it("a refused reserve sends no command", async () => {
    launcher.reserveTurn.mockRejectedValueOnce(new LauncherError("ai_busy"));
    const res = await prompt(good);
    expect(res.status).toBe(409);
    expect(send).not.toHaveBeenCalled();
    expect(launcher.runTurn).not.toHaveBeenCalled();
    expect(launcher.releaseTurn).not.toHaveBeenCalled();
  });

  it("a refused command (paused) releases the reservation and never runs", async () => {
    send.mockImplementationOnce(async () => { order.push("command"); return { kind: "refused", code: "paused" }; });
    const res = await prompt(good);
    expect(res.status).toBe(409);
    expect((await json(res)).error).toEqual({ code: "paused", message: "The session is paused. Resume it before you prompt an AI player." });
    expect(order).toEqual(["reserve", "command", "release"]);
    expect(launcher.releaseTurn).toHaveBeenCalledWith(SID, "tech_lead", RES);
    expect(launcher.runTurn).not.toHaveBeenCalled();
  });

  it("every non-ok command outcome releases and answers the command copy (no ack in time is the 504 of the command route)", async () => {
    const rows: [CommandOutcome, number, string][] = [
      [{ kind: "unconfirmed" }, 504, "command_unconfirmed"],
      [{ kind: "no_channel" }, 409, "no_channel"],
      [{ kind: "pending" }, 409, "command_pending"],
      [{ kind: "refused", code: "not_in_scene" }, 409, "not_in_scene"],
      [{ kind: "refused", code: "not_ai_role" }, 409, "conflict"],
      [{ kind: "refused", code: "stale_scene" }, 409, "stale_scene"],
      [{ kind: "refused", code: "log_failed" }, 502, "command_failed"],
    ];
    for (const [outcome, status, code] of rows) {
      launcher.releaseTurn.mockClear(); launcher.runTurn.mockClear();
      send.mockResolvedValueOnce(outcome);
      const res = await prompt(good);
      expect(res.status, code).toBe(status);
      expect((await json(res)).error?.code).toBe(code);
      expect(launcher.releaseTurn).toHaveBeenCalledTimes(1);
      expect(launcher.runTurn).not.toHaveBeenCalled();
    }
  });

  it("a failing release does not change the command answer", async () => {
    send.mockResolvedValueOnce({ kind: "refused", code: "paused" });
    launcher.releaseTurn.mockRejectedValueOnce(new LauncherError("unavailable"));
    expect((await prompt(good)).status).toBe(409);
  });

  it("a failed run after an ok command answers 502 ai_run_failed", async () => {
    launcher.runTurn.mockRejectedValueOnce(new LauncherError("unavailable"));
    const res = await prompt(good);
    expect(res.status).toBe(502);
    expect((await json(res)).error).toEqual({ code: "ai_run_failed", message: "The prompt was recorded, but the AI player could not start. Try again." });
    expect(launcher.releaseTurn).toHaveBeenCalledWith(SID, "tech_lead", RES);
  });

  it("a failing release after a failed run still answers ai_run_failed", async () => {
    launcher.runTurn.mockRejectedValueOnce(new LauncherError("unavailable"));
    launcher.releaseTurn.mockRejectedValueOnce(new LauncherError("unavailable"));
    expect((await json(await prompt(good))).error?.code).toBe("ai_run_failed");
  });

  it("a refusal of run by the control service still means the command was logged: ai_run_failed", async () => {
    launcher.runTurn.mockRejectedValueOnce(new LauncherError("ai_expired"));
    const res = await prompt(good);
    expect((await json(res)).error?.code).toBe("ai_run_failed");
  });
});

describe("prompt an AI player: copy", () => {
  const COPY: [LauncherReason, number, string][] = [
    ["ai_busy", 409, "The AI player is already answering. Wait a moment, then try again."],
    ["ai_budget", 409, "The AI players have used this session's model budget. They stay silent."],
    ["ai_absent", 409, "The AI player is not connected right now."],
    ["ai_expired", 409, "The prompt took too long to confirm. Try again."],
  ];
  it.each(COPY)("a reserve refused with %s answers its own copy, never the launcher's or runtime's text", async (reason, status, message) => {
    const err = new LauncherError(reason);
    err.message = "SECRET launcher text";
    launcher.reserveTurn.mockRejectedValueOnce(err);
    const res = await prompt(good);
    expect(res.status).toBe(status);
    const b = await json(res);
    expect(b.error).toEqual({ code: reason, message });
    expect(JSON.stringify(b)).not.toContain("SECRET");
  });

  it("not_found, unavailable and failed from reserve map like the other console routes", async () => {
    for (const [reason, status] of [["not_found", 404], ["unavailable", 502], ["failed", 502]] as const) {
      launcher.reserveTurn.mockRejectedValueOnce(new LauncherError(reason));
      expect((await prompt(good)).status, reason).toBe(status);
    }
  });

  it("the runtime's message text never reaches the answer", async () => {
    send.mockResolvedValueOnce({ kind: "refused", code: "paused", message: "RUNTIME-SECRET" } as unknown as CommandOutcome);
    expect(JSON.stringify(await json(await prompt(good)))).not.toContain("RUNTIME-SECRET");
  });
});

describe("prompt an AI player: secrets", () => {
  it("the hint reaches runTurn and nothing else; the reservation token is in no response, log or hub message", async () => {
    const responses: string[] = [];
    responses.push(await (await prompt({ ...good, hint: MARK })).text());
    send.mockResolvedValueOnce({ kind: "refused", code: "paused" });
    responses.push(await (await prompt({ ...good, hint: MARK })).text());
    launcher.runTurn.mockRejectedValueOnce(new LauncherError("failed"));
    responses.push(await (await prompt({ ...good, hint: MARK })).text());
    launcher.reserveTurn.mockRejectedValueOnce(new LauncherError("ai_busy"));
    responses.push(await (await prompt({ ...good, hint: MARK })).text());
    expect(launcher.runTurn.mock.calls[0]![3]).toBe(MARK);
    const hub = JSON.stringify(send.mock.calls);
    expect(hub).not.toContain(MARK);
    expect(hub).not.toContain(RES);
    for (const r of responses) { expect(r).not.toContain(MARK); expect(r).not.toContain(RES); }
    const all = logs.join("\n");
    expect(all).not.toContain(MARK);
    expect(all).not.toContain(RES);
    expect(JSON.stringify(launcher.releaseTurn.mock.calls)).not.toContain(MARK);
  });

  it("no launcher configured is the unreachable answer", async () => {
    delete (deps as { launcher?: unknown }).launcher;
    expect((await prompt(good)).status).toBe(502);
    expect(send).not.toHaveBeenCalled();
  });

  it("is exported through routes.ts", () => {
    expect(typeof consoleAiPromptPOST).toBe("function");
  });
});

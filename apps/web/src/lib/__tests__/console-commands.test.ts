// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { fetchFacts, sendCommand, useConsoleCommands } from "../console-commands";
import { fakeFetch, ok, refused } from "./fakes";

afterEach(cleanup);
const CH = "11111111-1111-4111-8111-111111111111";
const URL_CMD = "/api/v1/console/sessions/abc12345/command";

describe("sendCommand", () => {
  it("posts the channel and the command with X-Requested-With", async () => {
    const f = fakeFetch();
    const r = await sendCommand("abc12345", CH, { kind: "whisper", roleId: "cfo", text: "hi", expectSceneId: "s1" }, f.fetch);
    expect(r.ok).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(URL_CMD);
    expect(f.calls[0]!.init.method).toBe("POST");
    expect((f.calls[0]!.init.headers as Record<string, string>)["X-Requested-With"]).toBe("scenecoach");
    expect(f.calls[0]!.body).toEqual({ channel: CH, kind: "whisper", roleId: "cfo", text: "hi", expectSceneId: "s1" });
  });
});

describe("fetchFacts", () => {
  it("posts the channel to the facts route and returns the roles", async () => {
    const roles = [{ roleId: "cfo", facts: [{ n: 1, text: "T" }] }];
    const f = fakeFetch(() => ({ status: 200, body: ok({ roles }) }));
    expect(await fetchFacts("abc12345", CH, f.fetch)).toEqual({ ok: true, roles });
    expect(f.calls[0]!.url).toBe("/api/v1/console/sessions/abc12345/facts");
    expect(f.calls[0]!.body).toEqual({ channel: CH });
  });
  it("a failure is the BFF's message, or the status copy; a 504 is not retried", async () => {
    const f = fakeFetch(() => ({ status: 409, body: refused("no_channel", "Not live.") }));
    expect(await fetchFacts("abc12345", CH, f.fetch)).toEqual({ ok: false, message: "Not live." });
    const g = fakeFetch(() => ({ status: 504, body: refused("command_unconfirmed", "") }));
    const r = await fetchFacts("abc12345", CH, g.fetch);
    expect(r.ok).toBe(false);
    expect(g.calls).toHaveLength(1);
    const h = fakeFetch(() => ({ status: 200, body: ok({ nope: 1 }) }));
    expect((await fetchFacts("abc12345", CH, h.fetch)).ok).toBe(false);
  });
});

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

describe("useConsoleCommands", () => {
  it("run is one at a time: a second run while pending sends nothing", async () => {
    const f = fakeFetch();
    f.hold();
    const h = renderHook(() => useConsoleCommands("abc12345", CH, f.fetch));
    let first!: Promise<boolean>;
    act(() => { first = h.result.current.run({ kind: "pause" }); });
    expect(h.result.current.pending).toBe(true);
    let second = true;
    await act(async () => { second = await h.result.current.run({ kind: "resume" }); });
    expect(second).toBe(false);
    expect(f.calls).toHaveLength(1);
    f.release();
    await act(async () => { expect(await first).toBe(true); });
    expect(h.result.current.pending).toBe(false);
    expect(h.result.current.status).toBe("Paused.");
  });

  it("without a channel it sends nothing", async () => {
    const f = fakeFetch();
    const h = renderHook(() => useConsoleCommands("abc12345", null, f.fetch));
    await act(async () => { expect(await h.result.current.run({ kind: "pause" })).toBe(false); });
    expect(f.calls).toHaveLength(0);
  });

  it("announces each kind; End now has none; a new run clears the old status and error", async () => {
    const expected: [Parameters<ReturnType<typeof useConsoleCommands>["run"]>[0], string | null][] = [
      [{ kind: "resume" }, "Resumed."],
      [{ kind: "advance" }, "Moving on to the next scene."],
      [{ kind: "fire_inject", injectId: "i" }, "Inject fired."],
      [{ kind: "whisper", roleId: "r", text: "t" }, "Whisper sent."],
      [{ kind: "release_hidden", roleId: "r", fact: 1 }, "Fact released."],
      [{ kind: "set_npc_stance", roleId: "r", goals: ["g"] }, "Stance changed."],
      [{ kind: "end_now" }, null],
    ];
    const f = fakeFetch();
    const h = renderHook(() => useConsoleCommands("abc12345", CH, f.fetch));
    for (const [c, s] of expected) {
      await act(async () => { expect(await h.result.current.run(c)).toBe(true); });
      expect(h.result.current.status, c.kind).toBe(s);
      expect(h.result.current.error).toBeNull();
    }
    const g = fakeFetch((_u, b) => ((b as { kind: string }).kind === "pause" ? { status: 409, body: refused("ended", "The session has ended.") } : { status: 200, body: ok({ done: true }) }));
    const k = renderHook(() => useConsoleCommands("abc12345", CH, g.fetch));
    await act(async () => { await k.result.current.run({ kind: "resume" }); });
    expect(k.result.current.status).toBe("Resumed.");
    await act(async () => { expect(await k.result.current.run({ kind: "pause" })).toBe(false); });
    expect(k.result.current.status).toBeNull();
    expect(k.result.current.error).toBe("The session has ended.");
    await act(async () => { await k.result.current.run({ kind: "resume" }); });
    expect(k.result.current.error).toBeNull();
  });

  it("a 409 stale_scene shows the BFF's message; status 0 shows the unreachable copy; 401 the signed-out copy", async () => {
    const cases: [number, unknown, string][] = [
      [409, refused("stale_scene", "The scene changed. Review the live view and try again."), "The scene changed. Review the live view and try again."],
      [0, null, "The session service is not reachable. Try again."],
      [401, refused("unauthorized", "Sign in."), "You have been signed out. Sign in again."],
    ];
    for (const [status, body, text] of cases) {
      const f = status === 0
        ? { fetch: (async () => { throw new Error("down"); }) as unknown as typeof fetch }
        : fakeFetch(() => ({ status, body }));
      const h = renderHook(() => useConsoleCommands("abc12345", CH, f.fetch));
      await act(async () => { expect(await h.result.current.run({ kind: "advance", expectSceneId: "s1" })).toBe(false); });
      expect(h.result.current.error, String(status)).toBe(text);
      expect(h.result.current.status).toBeNull();
    }
  });

  it("a 504 is shown and nothing is sent again", async () => {
    const f = fakeFetch(() => ({ status: 504, body: refused("command_unconfirmed", "The session did not confirm the action. Check the live view before you try again.") }));
    const h = renderHook(() => useConsoleCommands("abc12345", CH, f.fetch));
    await act(async () => { await h.result.current.run({ kind: "pause" }); });
    await flush();
    expect(h.result.current.error).toBe("The session did not confirm the action. Check the live view before you try again.");
    expect(f.calls).toHaveLength(1);
  });

  it("an over-long BFF message falls back to the status copy", async () => {
    const f = fakeFetch(() => ({ status: 502, body: refused("command_failed", "x".repeat(301)) }));
    const h = renderHook(() => useConsoleCommands("abc12345", CH, f.fetch));
    await act(async () => { await h.result.current.run({ kind: "pause" }); });
    expect(h.result.current.error).toBe("The session service is not reachable. Try again.");
  });
});

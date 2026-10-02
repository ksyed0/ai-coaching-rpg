import { describe, expect, it } from "vitest";
import { parseArgs, parseInput, parseServerMessage, isFatalError, joinMessage, USAGE } from "../commands.js";

describe("parseArgs", () => {
  it("parses a player with defaults", () => {
    expect(parseArgs(["--role", "delivery_lead", "--name", "Kamal"])).toEqual({
      ok: true, opts: { facilitator: false, role: "delivery_lead", name: "Kamal", url: "ws://localhost:8080", session: "local" },
    });
  });
  it("parses a facilitator and custom url/session", () => {
    expect(parseArgs(["--facilitator", "--url", "wss://h:1/x", "--session", "s1"])).toEqual({
      ok: true, opts: { facilitator: true, role: undefined, name: undefined, url: "wss://h:1/x", session: "s1" },
    });
  });
  it.each([
    [[], "needs --role and --name"],
    [["--role", "a"], "needs --role and --name"],
    [["--name", "a"], "needs --role and --name"],
    [["--facilitator", "--role", "a"], "cannot be combined"],
    [["--facilitator", "--name", "a"], "cannot be combined"],
    [["--role", "a", "--name", "b", "--url", "http://x"], "ws:// or wss://"],
    [["--role", "a", "--name", "b", "--url", "nonsense"], "ws:// or wss://"],
    [["--role", "a", "--name", "  "], "--name"],
    [["--role", "a", "--name", "x".repeat(65)], "--name"],
    [["--role", "a", "--name", "b\x1b[2J"], "--name"],
    [["--role", "", "--name", "b"], "--role"],
    [["--role", "a", "--name", "b", "--session", ""], "--session"],
    [["--bogus"], "usage"],
    [["--role"], "usage"],
    [["--role", "a", "--name", "b", "extra"], "usage"],
  ])("rejects %j", (argv, msg) => {
    const r = parseArgs(argv as string[]);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toContain(msg); expect(r.error).toContain(USAGE); }
  });
});

describe("parseInput (facilitator)", () => {
  const f = (l: string) => parseInput(l, true);
  it("ignores empty lines", () => { expect(f("")).toEqual({ kind: "none" }); expect(f("   ")).toEqual({ kind: "none" }); });
  it("maps commands", () => {
    expect(f("/start")).toEqual({ kind: "send", message: { type: "start" } });
    expect(f("/pause")).toEqual({ kind: "send", message: { type: "command", command: { command: "pause" } } });
    expect(f("/resume")).toEqual({ kind: "send", message: { type: "command", command: { command: "resume" } } });
    expect(f("/advance")).toEqual({ kind: "send", message: { type: "command", command: { command: "advance" } } });
    expect(f("/inject abc")).toEqual({ kind: "send", message: { type: "command", command: { command: "fire_inject", injectId: "abc" } } });
    expect(f("/whisper cto  keep   calm ")).toEqual({ kind: "send", message: { type: "command", command: { command: "whisper", roleId: "cto", text: "keep   calm" } } });
    expect(f("/quit")).toEqual({ kind: "quit" });
  });
  it("prints help for bad usage and unknown commands, never sends", () => {
    for (const l of ["/inject", "/whisper", "/whisper cto", "/nope", "/", "plain speech", "/start extra"]) expect(f(l).kind).toBe("help");
    expect(f("/help").kind).toBe("help");
  });
  it("rejects over-long whispers", () => { expect(f("/whisper a " + "x".repeat(2001)).kind).toBe("help"); });
});

describe("parseInput (player)", () => {
  const p = (l: string) => parseInput(l, false);
  it("sends speech trimmed", () => { expect(p("  hello there ")).toEqual({ kind: "send", message: { type: "say", text: "hello there" } }); });
  it("ignores empty, handles quit and help", () => {
    expect(p("")).toEqual({ kind: "none" });
    expect(p("/quit")).toEqual({ kind: "quit" });
    expect(p("/help").kind).toBe("help");
  });
  it("never speaks slash lines in character", () => {
    for (const l of ["/start", "/pause", "/whisper x y", "/typo"]) expect(p(l).kind).toBe("help");
  });
  it("rejects over-long speech", () => { expect(p("x".repeat(2001)).kind).toBe("help"); });
});

describe("parseServerMessage / isFatalError / joinMessage", () => {
  it("parses valid messages and rejects junk", () => {
    expect(parseServerMessage('{"type":"error","code":"c","message":"m"}')).toEqual({ type: "error", code: "c", message: "m" });
    expect(parseServerMessage('{"type":"joined","roleId":"a","state":{}}')?.type).toBe("joined");
    expect(parseServerMessage('{"type":"event","event":{"type":"utterance"}}')?.type).toBe("event");
    for (const bad of ["not json", "null", "[]", '{"type":"event"}', '{"type":"joined"}', '{"type":"error","code":1}', '{"type":"zzz"}']) expect(parseServerMessage(bad)).toBeNull();
  });
  it("treats any error before joining as fatal, and a few after", () => {
    expect(isFatalError("role_taken", false)).toBe(true);
    expect(isFatalError("anything", false)).toBe(true);
    expect(isFatalError("not_started", true)).toBe(false);
    expect(isFatalError("forbidden", true)).toBe(false);
  });
  it("builds join messages", () => {
    expect(joinMessage({ facilitator: true, url: "ws://x", session: "s" })).toEqual({ type: "join_facilitator", sessionId: "s" });
    expect(joinMessage({ facilitator: false, role: "r", name: "n", url: "ws://x", session: "s" })).toEqual({ type: "join", sessionId: "s", roleId: "r", participantId: "n" });
  });
});

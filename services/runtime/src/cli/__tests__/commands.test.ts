import { describe, expect, it } from "vitest";
import { parseArgs, parseInput, parseServerMessage, isFatalError, joinMessage, USAGE, FACILITATOR_HELP } from "../commands.js";

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
  const NEEDS = "error: a player needs --role and --name (or use --facilitator)";
  const NAME = "error: --name must be 1-64 printable characters";
  it.each<[string[], string]>([
    [[], NEEDS],
    [["--role", "a"], NEEDS],
    [["--name", "a"], NEEDS],
    [["--facilitator", "--role", "a"], "error: --facilitator cannot be combined with --role or --name"],
    [["--facilitator", "--name", "a"], "error: --facilitator cannot be combined with --role or --name"],
    [["--role", "a", "--name", "b", "--url", "http://x"], "error: --url must be a ws:// or wss:// URL"],
    [["--role", "a", "--name", "b", "--url", "nonsense"], "error: --url must be a ws:// or wss:// URL"],
    [["--role", "a", "--name", "  "], NAME],
    [["--role", "a", "--name", "x".repeat(65)], NAME],
    [["--role", "a", "--name", "b\x1b[2J"], NAME],
    [["--role", "", "--name", "b"], "error: --role must be 1-128 printable characters"],
    [["--role", "a", "--name", "b", "--session", ""], "error: --session must be 1-128 printable characters"],
    [["--role", "a", "--role", "b", "--name", "n"], "error: --role was given more than once"],
    [["--facilitator", "--facilitator"], "error: --facilitator was given more than once"],
    [["--role", "a", "--name", "n", "--url", "ws://a", "--url", "ws://b"], "error: --url was given more than once"],
  ])("rejects %j with the specific message", (argv, msg) => {
    const r = parseArgs(argv);
    expect(r).toEqual({ ok: false, error: msg, usage: USAGE });
  });
  it.each<[string[], string]>([
    [["--bogus"], "error: Unknown option '--bogus'"],
    [["--role"], "error: Option '--role <value>' argument missing"],
    [["--role", "--name", "x"], "error: Option '--role' argument is ambiguous."],
    [["--role", "a", "--name", "b", "extra"], "error: Unexpected argument 'extra'"],
  ])("rejects malformed argv %j", (argv, prefix) => {
    const r = parseArgs(argv);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error.startsWith(prefix)).toBe(true); expect(r.error).not.toContain("\n"); expect(r.usage).toBe(USAGE); }
  });
  it("accepts a name containing a dash value via = syntax", () => {
    const r = parseArgs(["--role", "a", "--name=-x"]);
    expect(r.ok && r.opts.name).toBe("-x");
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

describe("facilitator token options (US-0017)", () => {
  it("--token on the command line is refused with a message that does not repeat the value", () => {
    for (const argv of [["--facilitator", "--token", "supersecret-supersecret"], ["--facilitator", "--token=supersecret-supersecret"]]) {
      const r = parseArgs(argv);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.error).toContain("FACILITATOR_TOKEN"); expect(r.error).toContain("--token-file"); expect(JSON.stringify(r)).not.toContain("supersecret"); }
    }
  });
  it("--token-file is accepted for a facilitator only", () => {
    expect(parseArgs(["--facilitator", "--token-file", "/tmp/t"])).toMatchObject({ ok: true, opts: { facilitator: true, tokenFile: "/tmp/t" } });
    expect(parseArgs(["--role", "a", "--name", "b", "--token-file", "/tmp/t"])).toMatchObject({ ok: false, error: "error: --token-file only applies to --facilitator" });
    expect(parseArgs(["--facilitator", "--token-file", ""])).toMatchObject({ ok: false });
  });
  it("joinMessage carries the token only when one was resolved", () => {
    expect(joinMessage({ facilitator: true, url: "ws://x", session: "s" })).toEqual({ type: "join_facilitator", sessionId: "s" });
    expect(joinMessage({ facilitator: true, url: "ws://x", session: "s", token: "abcdefghijklmnop" })).toEqual({ type: "join_facilitator", sessionId: "s", token: "abcdefghijklmnop" });
    expect(joinMessage({ facilitator: false, role: "r", name: "n", url: "ws://x", session: "s", token: "abcdefghijklmnop" })).toEqual({ type: "join", sessionId: "s", roleId: "r", participantId: "n" });
  });
});

describe("parseInput: /release and /hidden (US-0016)", () => {
  const f = (l: string) => parseInput(l, true);
  it("sends release_hidden with a 1-based fact number", () => {
    expect(f("/release cfo 1")).toEqual({ kind: "send", message: { type: "command", command: { command: "release_hidden", roleId: "cfo", fact: 1 } } });
    expect(f("/release   client_sponsor   12 ")).toMatchObject({ kind: "send", message: { command: { roleId: "client_sponsor", fact: 12 } } });
    expect(f("/release cfo 50")).toMatchObject({ kind: "send" });
  });
  it.each(["/release", "/release cfo", "/release cfo 0", "/release cfo 51", "/release cfo -1", "/release cfo 1.5", "/release cfo one", "/release cfo 1 2", "/release cfo 0001x", "/release cfo 1e1", `/release ${"r".repeat(129)} 1`])("answers %j with usage and sends nothing", (line) => {
    const r = f(line);
    expect(r.kind).toBe("help");
    expect((r as { message: string }).message).toContain("usage: /release <role> <n>");
  });
  it("/hidden is local and takes no argument", () => {
    expect(f("/hidden")).toEqual({ kind: "hidden" });
    expect(f("/hidden cfo").kind).toBe("help");
  });
  it("the help line lists both, and a player gets neither", () => {
    expect(FACILITATOR_HELP).toContain("/hidden");
    expect(FACILITATOR_HELP).toContain("/release <role> <n>");
    expect(parseInput("/release cfo 1", false).kind).toBe("help");
    expect(parseInput("/hidden", false).kind).toBe("help");
    expect(parseInput("/release cfo 1", false)).not.toMatchObject({ kind: "send" });
  });
});

describe("join code options (US-0033)", () => {
  it("test_parseArgs_code_on_the_command_line_is_refused_without_repeating_it", () => {
    for (const argv of [["--role", "a", "--name", "b", "--code", "ABCD-EFGH-JKMN"], ["--role", "a", "--name", "b", "--code=ABCD-EFGH-JKMN"], ["--role", "a", "--name", "b", "--join-code", "ABCD-EFGH-JKMN"]]) {
      const r = parseArgs(argv);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.error).toContain("JOIN_CODE"); expect(r.error).toContain("--code-file"); expect(JSON.stringify(r)).not.toContain("ABCD"); }
    }
  });
  it("test_parseArgs_code_file_is_for_players_only", () => {
    expect(parseArgs(["--role", "a", "--name", "b", "--code-file", "/tmp/c"])).toMatchObject({ ok: true, opts: { role: "a", codeFile: "/tmp/c" } });
    expect(parseArgs(["--facilitator", "--code-file", "/tmp/c"])).toMatchObject({ ok: false, error: "error: --code-file only applies to a player (--role)" });
    expect(parseArgs(["--role", "a", "--name", "b", "--code-file", ""])).toMatchObject({ ok: false, error: "error: --code-file must be a file path" });
    expect(parseArgs(["--role", "a", "--name", "b", "--code-file", "/a", "--code-file", "/b"])).toMatchObject({ ok: false, error: "error: --code-file was given more than once" });
  });
  it("test_joinMessage_carries_the_code_for_a_player_only", () => {
    expect(joinMessage({ facilitator: false, role: "r", name: "n", url: "ws://x", session: "s", joinCode: "ABCD-EFGH-JKMN" })).toEqual({ type: "join", sessionId: "s", roleId: "r", participantId: "n", joinCode: "ABCD-EFGH-JKMN" });
    expect(joinMessage({ facilitator: true, url: "ws://x", session: "s", joinCode: "ABCD-EFGH-JKMN" })).toEqual({ type: "join_facilitator", sessionId: "s" });
    expect(USAGE).toContain("--code-file");
  });
});

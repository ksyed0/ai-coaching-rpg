import { describe, expect, it } from "vitest";
import { DEMO_USAGE, MAX_SPEED, MIN_SPEED, parseDemoArgs } from "../args.js";

const ok = (argv: string[]) => {
  const r = parseDemoArgs(argv);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.opts;
};

describe("parseDemoArgs", () => {
  it("defaults: mock mode, speed 1, colour allowed, no json, no url", () => {
    expect(ok([])).toEqual({ fast: false, speed: 1, json: undefined, live: false, url: undefined, session: undefined, noColor: false, help: false });
  });
  it("parses every flag", () => {
    expect(ok(["--speed", "2.5", "--json", "out.json", "--live", "--url", "ws://localhost:8080", "--session", "s_1", "--no-color"])).toEqual({
      fast: false, speed: 2.5, json: "out.json", live: true, url: "ws://localhost:8080", session: "s_1", noColor: true, help: false,
    });
    expect(ok(["--fast"]).fast).toBe(true);
    expect(ok(["--help"]).help).toBe(true);
  });
  it("accepts `--json -` for stdout", () => {
    expect(ok(["--json", "-"]).json).toBe("-");
    expect(ok(["--json=-"]).json).toBe("-");
  });
  it.each([["0.1", 0.1], ["20", 20], ["1", 1], ["0.25", 0.25]])("accepts --speed %s", (raw, value) => {
    expect(ok(["--speed", raw]).speed).toBe(value);
  });
  it.each(["0", "0.09", "20.1", "100", "-1", "abc", "", "1e1", "NaN", "Infinity", "1,5", "0x10"])("rejects --speed %j", (raw) => {
    const r = parseDemoArgs(["--speed", raw]);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.usage).toBe(DEMO_USAGE); expect(r.error).toContain("--speed"); }
  });
  it("documents the speed range in its error", () => {
    const r = parseDemoArgs(["--speed", "99"]);
    expect(r).toMatchObject({ ok: false, error: `error: --speed must be a number from ${MIN_SPEED} to ${MAX_SPEED}` });
  });
  it("rejects --fast together with --speed", () => {
    expect(parseDemoArgs(["--fast", "--speed", "2"])).toEqual({ ok: false, error: "error: --fast and --speed cannot be combined", usage: DEMO_USAGE });
  });
  it.each(["--fast", "--live", "--no-color", "--help"])("rejects a duplicated %s", (flag) => {
    expect(parseDemoArgs([flag, flag])).toEqual({ ok: false, error: `error: ${flag} was given more than once`, usage: DEMO_USAGE });
  });
  it.each(["--speed", "--json", "--url", "--session"])("rejects a duplicated %s", (flag) => {
    expect(parseDemoArgs([flag, "1", flag, "2"])).toMatchObject({ ok: false, error: `error: ${flag} was given more than once` });
  });
  it.each<[string[], string]>([
    [["--bogus"], "error: Unknown option '--bogus'"],
    [["positional"], "error: Unexpected argument 'positional'"],
    [["--speed"], "error: Option '--speed <value>' argument missing"],
    [["--json"], "error: Option '--json <value>' argument missing"],
  ])("rejects %j with a node-style message and the usage text", (argv, msg) => {
    const r = parseDemoArgs(argv);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error.startsWith(msg)).toBe(true); expect(r.usage).toBe(DEMO_USAGE); }
  });
  describe("--url", () => {
    it.each(["ws://localhost:8080", "wss://example.com", "ws://127.0.0.1:1/", "ws://[::1]:9000", "wss://host.example:443/path"])("accepts %s", (u) => {
      expect(ok(["--url", u]).url).toBe(u);
    });
    it.each([
      "http://localhost:8080", "https://example.com", "nonsense", "", "ftp://x", "ws://", "ws://user@host:1", "ws://user:pw@host:1",
      "ws://host:1?token=abc", "ws://host:1/#frag", "ws://host:1/\u001b[2J", "ws://host:1/a b",
    ])("rejects %j without echoing credentials", (u) => {
      const r = parseDemoArgs(["--url", u]);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("--url");
        expect(r.error).not.toContain("pw@");
        expect(r.error).not.toContain("token=abc");
        expect(r.error).not.toContain("\u001b");
      }
    });
    it("allows --url together with --live", () => {
      expect(ok(["--url", "ws://localhost:1", "--live"])).toMatchObject({ url: "ws://localhost:1", live: true });
    });
  });
  describe("--session", () => {
    it.each(["a", "demo", "A_b-9", "x".repeat(64)])("accepts %s", (s) => expect(ok(["--session", s]).session).toBe(s));
    it.each(["", "x".repeat(65), "has space", "a/b", "..", "a\nb", "é"])("rejects %j", (s) => {
      expect(parseDemoArgs(["--session", s])).toMatchObject({ ok: false });
    });
  });
  it("rejects --json with a control character or an empty value", () => {
    expect(parseDemoArgs(["--json", ""])).toMatchObject({ ok: false });
    expect(parseDemoArgs(["--json", "a\u001bb"])).toMatchObject({ ok: false });
  });
});

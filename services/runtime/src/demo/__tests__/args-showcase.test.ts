import { describe, expect, it } from "vitest";
import { DEMO_USAGE, MAX_FALLBACKS, MAX_LINES, MAX_WATCHDOG_MINUTES, parseDemoArgs } from "../args.js";

const ok = (argv: string[]) => {
  const r = parseDemoArgs(argv);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.opts;
};
const fail = (argv: string[]) => {
  const r = parseDemoArgs(argv);
  if (r.ok) throw new Error("expected a usage error");
  expect(r.usage).toBe(DEMO_USAGE);
  return r.error;
};

describe("parseDemoArgs: the showcase flags", () => {
  it("leaves the showcase options unset by default", () => {
    const o = ok([]);
    expect([o.showcase, o.scenario, o.maxLines, o.maxFallbacks, o.watchdog]).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
  it("parses every showcase flag", () => {
    expect(ok(["--showcase", "--scenario", "scenarios/x", "--max-lines", "2", "--max-fallbacks", "0", "--watchdog", "5", "--live", "--fast"])).toMatchObject({
      showcase: true, scenario: "scenarios/x", maxLines: 2, maxFallbacks: 0, watchdog: 5, live: true, fast: true,
    });
    expect(ok(["--showcase"]).showcase).toBe(true);
    expect(ok(["--showcase", "--json", "-"]).json).toBe("-");
  });
  it("accepts --watchdog on its own (it also bounds the default run)", () => {
    expect(ok(["--watchdog", "9"]).watchdog).toBe(9);
  });
  it("refuses --url with --showcase (usage error)", () => {
    expect(fail(["--showcase", "--url", "ws://localhost:1"])).toBe("error: --showcase cannot be combined with --url (the showcase starts its own in-process server)");
  });
  it.each([["--scenario", "x"], ["--max-lines", "2"]])("refuses %s without --showcase", (flag, value) => {
    expect(fail([flag, value])).toBe(`error: ${flag} needs --showcase`);
  });
  it.each([["1", 1], ["20", MAX_LINES], ["7", 7]])("accepts --max-lines %s", (raw, v) => { expect(ok(["--showcase", "--max-lines", raw]).maxLines).toBe(v); });
  it.each(["0", "21", "-1", "1.5", "abc", "", "1e1", "0x2", " 2"])("rejects --max-lines %j", (raw) => {
    expect(fail(["--showcase", `--max-lines=${raw}`])).toBe(`error: --max-lines must be a whole number from 1 to ${MAX_LINES}`);
  });
  it.each([["0", 0], ["3", 3], [String(MAX_FALLBACKS), MAX_FALLBACKS]])("accepts --max-fallbacks %s", (raw, v) => { expect(ok(["--showcase", "--max-fallbacks", raw]).maxFallbacks).toBe(v); });
  it("US-0023: --max-fallbacks also belongs to the 29-check run (no --showcase needed), live or mock, and may come with --url", () => {
    expect(ok(["--max-fallbacks", "2"]).maxFallbacks).toBe(2);
    expect(ok(["--live", "--max-fallbacks", "0"]).maxFallbacks).toBe(0);
    expect(ok(["--url", "ws://127.0.0.1:1", "--max-fallbacks", "1"]).maxFallbacks).toBe(1);
    expect(ok(["--fast"]).maxFallbacks).toBeUndefined();
    for (const raw of [String(MAX_FALLBACKS + 1), "-1", "1.5", "x", "", "1e1"]) expect(fail([`--max-fallbacks=${raw}`])).toBe(`error: --max-fallbacks must be a whole number from 0 to ${MAX_FALLBACKS}`);
  });
  it.each([String(MAX_FALLBACKS + 1), "-1", "1.5", "x", ""])("rejects --max-fallbacks %j", (raw) => {
    expect(fail(["--showcase", `--max-fallbacks=${raw}`])).toBe(`error: --max-fallbacks must be a whole number from 0 to ${MAX_FALLBACKS}`);
  });
  it.each([["1", 1], ["30", 30], [String(MAX_WATCHDOG_MINUTES), MAX_WATCHDOG_MINUTES]])("accepts --watchdog %s", (raw, v) => { expect(ok(["--watchdog", raw]).watchdog).toBe(v); });
  it.each(["0", String(MAX_WATCHDOG_MINUTES + 1), "-5", "2.5", "soon", ""])("rejects --watchdog %j", (raw) => {
    expect(fail([`--watchdog=${raw}`])).toBe(`error: --watchdog must be a whole number of minutes from 1 to ${MAX_WATCHDOG_MINUTES}`);
  });
  it("rejects an empty or control-character --scenario", () => {
    expect(fail(["--showcase", "--scenario", ""])).toBe("error: --scenario needs a directory path");
    expect(fail(["--showcase", "--scenario", "a\u001bb"])).toBe("error: --scenario needs a directory path");
  });
  it.each(["showcase", "scenario", "max-lines", "max-fallbacks", "watchdog"])("rejects a duplicated --%s", (flag) => {
    const value = ["showcase"].includes(flag) ? [] : ["1"];
    expect(fail(["--showcase", `--${flag}`, ...value, `--${flag}`, ...value])).toBe(`error: --${flag} was given more than once`);
  });
  it("documents the new flags in the usage text", () => {
    for (const f of ["--showcase", "--scenario", "--max-lines", "--max-fallbacks", "--watchdog"]) expect(DEMO_USAGE).toContain(f);
  });
  it("parses --transcript in any mode and rejects an empty or control-character path or a duplicate", () => {
    expect(ok(["--transcript", "out/t.md"]).transcript).toBe("out/t.md");
    expect(ok(["--showcase", "--live", "--transcript=t.md"]).transcript).toBe("t.md");
    expect(ok(["--url", "ws://localhost:1", "--transcript", "t.md"]).transcript).toBe("t.md");
    expect(ok([]).transcript).toBeUndefined();
    expect(fail(["--transcript="])).toBe("error: --transcript needs a file path");
    expect(fail(["--transcript", "a\u001bb"])).toBe("error: --transcript needs a file path");
    expect(fail(["--transcript", "a", "--transcript", "b"])).toBe("error: --transcript was given more than once");
    expect(DEMO_USAGE).toContain("--transcript");
  });
});

describe("parseDemoArgs: --players and --player-model (US-0027)", () => {
  it("leaves players unset by default and for --players scripted", () => {
    expect(ok(["--showcase"]).players).toBeUndefined();
    expect(ok(["--showcase", "--players", "scripted"]).players).toBeUndefined();
    expect(ok(["--showcase", "--players=scripted", "--live"]).players).toBeUndefined();
  });
  it("accepts generated with --showcase and --live, and a model id", () => {
    expect(ok(["--showcase", "--live", "--players", "generated"])).toMatchObject({ players: "generated", playerModel: undefined });
    for (const id of ["qwen3:8b", "anthropic/claude-sonnet-5.5", "mlx-community/Qwen3.8-27B-MXFP8", "a"]) {
      expect(ok(["--showcase", "--live", "--players", "generated", "--player-model", id]).playerModel).toBe(id);
    }
  });
  it("rejects generated without --live or without --showcase with one line", () => {
    expect(fail(["--showcase", "--players", "generated"])).toBe("error: --players generated needs --live (the mock and CI runs stay scripted)");
    expect(fail(["--live", "--players", "generated"])).toBe("error: --players needs --showcase");
    expect(fail(["--players", "scripted"])).toBe("error: --players needs --showcase");
  });
  it("rejects an unknown mode and repeats", () => {
    expect(fail(["--showcase", "--players", "ai"])).toBe("error: --players must be scripted or generated");
    expect(fail(["--showcase", "--players", ""])).toBe("error: --players must be scripted or generated");
    expect(fail(["--showcase", "--live", "--players", "generated", "--players", "generated"])).toBe("error: --players was given more than once");
    expect(fail(["--showcase", "--live", "--players", "generated", "--player-model", "a", "--player-model", "b"])).toBe("error: --player-model was given more than once");
  });
  it("needs --players generated for --player-model and validates the id without echoing it", () => {
    expect(fail(["--showcase", "--live", "--player-model", "x"])).toBe("error: --player-model needs --players generated");
    expect(fail(["--showcase", "--player-model", "x", "--players", "scripted"])).toBe("error: --player-model needs --players generated");
    for (const bad of ["", "has space", "-lead", "x\u0007y", "a".repeat(201), "key=sk-ant-secret value", "http://u:p@h"]) {
      const msg = fail(["--showcase", "--live", "--players", "generated", `--player-model=${bad}`]);
      expect(msg).toMatch(/^error: --player-model must be a model id of 1 to 200 /);
      if (bad.length > 3 && bad.length < 100) expect(msg).not.toContain(bad);
    }
  });
});

describe("parseDemoArgs: --no-intents", () => {
  it("is unset by default and accepted with --players generated", () => {
    expect(ok(["--showcase", "--live", "--players", "generated"]).noIntents).toBeUndefined();
    expect(ok(["--showcase", "--live", "--players", "generated", "--no-intents"]).noIntents).toBe(true);
  });
  it("is refused without --players generated, with one line", () => {
    expect(fail(["--no-intents"])).toBe("error: --no-intents needs --players generated");
    expect(fail(["--showcase", "--live", "--no-intents"])).toBe("error: --no-intents needs --players generated");
    expect(fail(["--showcase", "--players", "scripted", "--no-intents"])).toBe("error: --no-intents needs --players generated");
    expect(fail(["--showcase", "--live", "--players", "generated", "--no-intents", "--no-intents"])).toBe("error: --no-intents was given more than once");
  });
});

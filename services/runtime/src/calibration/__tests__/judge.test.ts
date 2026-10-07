import { describe, expect, it } from "vitest";
import { buildJudge, buildPrimaryJudge, CalibrationInputError, modelFamily, parseJudgeSpec, scopedJudgeEnv } from "../judge.js";
import { isValidModelId, parseEvalConfig } from "../../evaluator/config.js";

describe("parseJudgeSpec", () => {
  it("parses label,model and an optional base URL", () => {
    expect(parseJudgeSpec("second,holo3-35b-a3b")).toEqual({ label: "second", model: "holo3-35b-a3b" });
    expect(parseJudgeSpec("second,holo3-35b-a3b,http://127.0.0.1:1337/v1")).toEqual({ label: "second", model: "holo3-35b-a3b", baseUrl: "http://127.0.0.1:1337/v1" });
  });
  it.each(["", "onlylabel", "../x,m", "a,", "a,m,ftp://x", "a,m,not a url", "a,has space", "a,m://x", "a,m,http://x,extra"])("rejects %j", (raw) => {
    expect(() => parseJudgeSpec(raw)).toThrow(CalibrationInputError);
  });
});

describe("modelFamily", () => {
  it.each([
    ["gemma-4-31b-it-qat-mxfp4", "gemma"], ["Qwen3.8-27b", "qwen"], ["nemotron-3-nano", "nemotron"], ["anthropic/claude-sonnet-5.5", "claude"],
    ["ministral-3-14b", "mistral"], ["mistral-large", "mistral"], ["holo3-35b-a3b", "holo"], ["holo3-35b-a3b-jangtq4", "holo"], ["weird-model-1", "weird"],
  ])("%s -> %s", (m, f) => expect(modelFamily(m)).toBe(f));
});

describe("parseJudgeSpec secrets and URL hygiene", () => {
  const secretCases = ["second,holo3,http://h/v1?a=1,b=2&token=sk-SECRET", "second,holo3,http://user:sk-SECRET@h:1/v1", "second,holo3,http://h/v1?token=sk-SECRET", "second,holo3,http://h/v1#sk-SECRET", "sk-SECRET", "a,b,c,sk-SECRET", "sk-SECRET,m sp,http://h", "a,m,ftp://sk-SECRET"];
  it.each(secretCases)("never echoes the raw spec: %j", (raw) => {
    let msg = "";
    try { parseJudgeSpec(raw); } catch (e) { expect(e).toBeInstanceOf(CalibrationInputError); msg = (e as Error).message; }
    expect(msg).not.toBe("");
    expect(msg).not.toContain("sk-SECRET");
  });
  it("rejects credentials, a query string and a fragment in the base URL", () => {
    for (const u of ["http://user:pw@h:1/v1", "http://user@h:1/v1", "http://h:1/v1?a=1", "http://h:1/v1#f"]) {
      expect(() => parseJudgeSpec(`a,m,${u}`)).toThrow(CalibrationInputError);
    }
  });
  it("trims and normalizes the stored base URL", () => {
    expect(parseJudgeSpec("a,m, http://127.0.0.1:1337/v1/ ").baseUrl).toBe("http://127.0.0.1:1337/v1");
    expect(parseJudgeSpec("a,m,http://[::1]:1337/v1").baseUrl).toBe("http://[::1]:1337/v1");
  });
  it("applies the evaluator model-id rule", () => {
    for (const m of ["m\u0000x", "m\u001bx", "../../etc/passwd", "m@x"]) expect(() => parseJudgeSpec(`a,${m}`)).toThrow(CalibrationInputError);
  });
});

describe("isValidModelId", () => {
  it.each(["OsaurusAI/Holo3-35B-A3B-JANGTQ4", "holo3-35b-a3b-jangtq4", "anthropic/claude-sonnet-5.5", "gemma-4-31b-it-qat-mxfp4"])("accepts %s", (m) => expect(isValidModelId(m)).toBe(true));
  it.each(["", "m\u0000", "m\u001b", "../../etc/passwd", "m@x", "a b", "http://x", "x".repeat(201)])("rejects %j", (m) => expect(isValidModelId(m)).toBe(false));
});

describe("modelFamily edge", () => {
  it.each([
    ["philosopher-7b", "philosopher"], ["gpt4all", "gpt4all"], ["GPT4All-J", "gpt4all"], ["gpt-oss-20b", "gpt"], ["gpt4", "gpt"], ["gpt-4o", "gpt"],
    ["llama3:8b", "llama"], ["meta-llama/Llama-3.1-8B", "llama"], ["mlx-community/Qwen3-8B-4bit", "qwen"], ["OsaurusAI/Holo3-35B-A3B-JANGTQ4", "holo"],
    ["phi-3", "phi"], ["phi4", "phi"], ["phi_3", "phi"], ["phi.3", "phi"], ["phi:3", "phi"], ["phi", "phi"], ["qwerty-1", "qwerty"], ["gemmaX-1", "gemmax"],
  ])("%s -> %s", (m, f) => expect(modelFamily(m)).toBe(f));
  it("is unknown for an empty or slash-only id", () => { expect(modelFamily("")).toBe("unknown"); expect(modelFamily("/")).toBe("unknown"); });
});

describe("judges", () => {
  const cfgOf = (env: NodeJS.ProcessEnv = {}) => { const c = parseEvalConfig(env); if (!c.ok) throw new Error("cfg"); return c; };
  it.each(["mock", "MOCK", " mock", ""])("refuses the mock provider for the primary judge (MODEL_PROVIDER=%j)", (mp) => {
    const env = { MODEL_PROVIDER: mp, NPC_MODEL: "gemma-4" };
    expect(() => buildPrimaryJudge(env, cfgOf())).toThrow(CalibrationInputError);
    expect(() => buildPrimaryJudge(env, cfgOf())).toThrow(/mock/);
  });
  it("refuses an unmocked-but-default env (MODEL_PROVIDER unset)", () => {
    expect(() => buildPrimaryJudge({}, cfgOf())).toThrow(/mock/);
  });
  it("refuses an unknown MODEL_PROVIDER with a CalibrationInputError", () => {
    expect(() => buildPrimaryJudge({ MODEL_PROVIDER: "bogus-sk-SECRET", NPC_MODEL: "m" }, cfgOf())).toThrow(CalibrationInputError);
    try { buildPrimaryJudge({ MODEL_PROVIDER: "bogus-sk-SECRET", NPC_MODEL: "m" }, cfgOf()); } catch (e) { expect((e as Error).message).toContain("MODEL_PROVIDER"); expect((e as Error).message).not.toContain("sk-SECRET"); }
  });
  it.each([
    ["openrouter", "OPENROUTER_BASE_URL"], ["anthropic", "ANTHROPIC_BASE_URL"],
  ])("names the invalid base URL variable for MODEL_PROVIDER=%s, never its value", (mp, variable) => {
    const env = { MODEL_PROVIDER: mp, NPC_MODEL: "m", [variable]: "ftp://sk-SECRET-BASE" };
    let msg = "";
    try { buildPrimaryJudge(env, cfgOf()); } catch (e) { expect(e).toBeInstanceOf(CalibrationInputError); msg = (e as Error).message; }
    expect(msg).toContain(variable);
    expect(msg).not.toMatch(/not a known provider/);
    expect(msg).not.toContain("sk-SECRET-BASE");
  });
  it.each([undefined, "", "   "])("refuses a primary judge with no model id (NPC_MODEL=%j)", (npc) => {
    const env: NodeJS.ProcessEnv = { MODEL_PROVIDER: "local", LOCAL_BASE_URL: "http://127.0.0.1:1/v1", ...(npc === undefined ? {} : { NPC_MODEL: npc }) };
    expect(() => buildPrimaryJudge(env, cfgOf())).toThrow(CalibrationInputError);
    expect(() => buildPrimaryJudge(env, cfgOf())).toThrow(/EVAL_MODEL or NPC_MODEL/);
  });
  it("refuses an invalid NPC_MODEL without echoing it", () => {
    const env = { MODEL_PROVIDER: "local", LOCAL_BASE_URL: "http://127.0.0.1:1/v1", NPC_MODEL: "m@sk-SECRET" };
    expect(() => buildPrimaryJudge(env, cfgOf())).toThrow(CalibrationInputError);
    try { buildPrimaryJudge(env, cfgOf()); } catch (e) { expect((e as Error).message).not.toContain("sk-SECRET"); }
  });
  it("names the primary judge from the configured model", () => {
    const env = { MODEL_PROVIDER: "local", LOCAL_BASE_URL: "http://127.0.0.1:1/v1", NPC_MODEL: " gemma-4-31b-it " };
    const j = buildPrimaryJudge(env, cfgOf());
    expect(j.model).toBe("gemma-4-31b-it"); expect(j.family).toBe("gemma"); expect(j.label).toBe("primary");
    const j2 = buildPrimaryJudge(env, cfgOf({ EVAL_MODEL: "qwen3-8b" }));
    expect(j2.model).toBe("qwen3-8b"); expect(j2.family).toBe("qwen");
  });
  it("wraps provider-selection failures in a CalibrationInputError", () => {
    expect(() => buildPrimaryJudge({ MODEL_PROVIDER: "local", NPC_MODEL: "m" }, cfgOf())).toThrow(CalibrationInputError);
  });
  it("builds a judge on a local OpenAI-compatible endpoint from a spec", () => {
    const spec = { label: "second", model: "holo3-35b-a3b", baseUrl: "http://127.0.0.1:1337/v1" };
    const j = buildJudge(spec, {});
    expect(j.label).toBe("second"); expect(j.family).toBe("holo"); expect(typeof j.provider.stream).toBe("function");
    const scoped = scopedJudgeEnv(spec, { MODEL_PROVIDER: "mock", NPC_MODEL: "other" });
    expect(scoped.MODEL_PROVIDER).toBe("local"); expect(scoped.NPC_MODEL).toBe("holo3-35b-a3b"); expect(scoped.LOCAL_BASE_URL).toBe("http://127.0.0.1:1337/v1");
  });
  it("needs a base URL from the spec or LOCAL_BASE_URL", () => {
    expect(() => buildJudge({ label: "second", model: "m" }, {})).toThrow(CalibrationInputError);
    expect(() => buildJudge({ label: "second", model: "m" }, {})).toThrow(/--judge|LOCAL_BASE_URL/);
    expect(scopedJudgeEnv({ label: "s", model: "m" }, { LOCAL_BASE_URL: "http://127.0.0.1:2/v1" }).LOCAL_BASE_URL).toBe("http://127.0.0.1:2/v1");
  });
  it("wraps a bad LOCAL_BASE_URL in a CalibrationInputError that does not echo it", () => {
    try { buildJudge({ label: "s", model: "m" }, { LOCAL_BASE_URL: "http://u:sk-SECRET@h/v1" }); throw new Error("no throw"); } catch (e) {
      expect(e).toBeInstanceOf(CalibrationInputError); expect((e as Error).message).not.toContain("sk-SECRET");
    }
  });
  it("ignores a junk LOCAL_BASE_URL when the spec has its own base URL (and then never passes LOCAL_API_KEY)", () => {
    const env = { LOCAL_BASE_URL: "not a url sk-SECRET", LOCAL_API_KEY: "sk-PRIMARY" };
    const scoped = scopedJudgeEnv({ label: "s", model: "m", baseUrl: "http://127.0.0.1:1337/v1" }, env);
    expect(scoped.LOCAL_BASE_URL).toBe("http://127.0.0.1:1337/v1");
    expect(scoped.LOCAL_API_KEY).toBeUndefined();
    expect(buildJudge({ label: "s", model: "m", baseUrl: "http://127.0.0.1:1337/v1" }, env).label).toBe("s");
    expect(() => scopedJudgeEnv({ label: "s", model: "m" }, env)).toThrow(/LOCAL_BASE_URL/);
  });
  it("never gives a second judge on another host the caller's LOCAL_API_KEY", () => {
    const env = { LOCAL_BASE_URL: "http://127.0.0.1:1234/v1/", LOCAL_API_KEY: "sk-PRIMARY" };
    expect(scopedJudgeEnv({ label: "s", model: "m", baseUrl: "http://127.0.0.1:1337/v1" }, env).LOCAL_API_KEY).toBeUndefined();
    expect(scopedJudgeEnv({ label: "s", model: "m", baseUrl: "http://127.0.0.1:1234/v1" }, env).LOCAL_API_KEY).toBe("sk-PRIMARY");
    expect(scopedJudgeEnv({ label: "s", model: "m" }, env).LOCAL_API_KEY).toBe("sk-PRIMARY");
  });
});

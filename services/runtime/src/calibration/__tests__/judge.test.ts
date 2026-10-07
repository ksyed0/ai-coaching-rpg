import { describe, expect, it } from "vitest";
import { buildJudge, buildPrimaryJudge, CalibrationInputError, modelFamily, parseJudgeSpec } from "../judge.js";
import { parseEvalConfig } from "../../evaluator/config.js";

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

describe("judges", () => {
  it("refuses the mock provider for the primary judge", () => {
    const cfg = parseEvalConfig({}); if (!cfg.ok) throw new Error("cfg");
    expect(() => buildPrimaryJudge({}, cfg)).toThrow(/mock/);
  });
  it("builds a judge on a local OpenAI-compatible endpoint from a spec", () => {
    const j = buildJudge({ label: "second", model: "holo3-35b-a3b", baseUrl: "http://127.0.0.1:1337/v1" }, {});
    expect(j.label).toBe("second"); expect(j.family).toBe("holo"); expect(typeof j.provider.stream).toBe("function");
  });
  it("needs a base URL from the spec or LOCAL_BASE_URL", () => {
    expect(() => buildJudge({ label: "second", model: "m" }, {})).toThrow();
  });
});

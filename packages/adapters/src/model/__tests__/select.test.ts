import { describe, expect, it } from "vitest";
import { selectModelProvider, describeModelProvider } from "../select.js";
import { OpenAICompatibleModelProvider } from "../openai-compatible.js";

const KEY = "sk-TEST-NEVER-LOG-12345";
const modelOf = (p: unknown) => (p as { model: string }).model;
const errorOf = (env: Record<string, string>, role: "npc" | "gm" = "npc"): string => {
  try { selectModelProvider(env, role); } catch (e) { return (e as Error).message; }
  throw new Error("expected selectModelProvider to throw");
};

describe("selectModelProvider", () => {
  it("defaults to the mock provider", () => {
    expect(selectModelProvider({}, "npc").name).toBe("mock");
  });
  it("selects anthropic when configured with a key", () => {
    expect(selectModelProvider({ MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" }, "gm").name).toBe("anthropic");
  });
  it("throws without a key for anthropic", () => {
    expect(() => selectModelProvider({ MODEL_PROVIDER: "anthropic" }, "npc")).toThrow(/ANTHROPIC_API_KEY/);
  });
  it("throws for an unknown provider and lists the valid values", () => {
    const msg = errorOf({ MODEL_PROVIDER: "nope" });
    expect(msg).toMatch(/unknown MODEL_PROVIDER/);
    for (const v of ["mock", "anthropic", "openrouter", "local"]) expect(msg).toContain(v);
    expect(errorOf({ MODEL_PROVIDER: "" })).toMatch(/unknown MODEL_PROVIDER/);
  });
  it("falls back to the default model when NPC_MODEL / GM_MODEL are blank or unset", () => {
    const model = (env: Record<string, string>, role: "npc" | "gm") => modelOf(selectModelProvider({ MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", ...env }, role));
    expect(model({ NPC_MODEL: "" }, "npc")).toBe("claude-sonnet-5-5");
    expect(model({ GM_MODEL: "" }, "gm")).toBe("claude-sonnet-5-5");
    expect(model({}, "npc")).toBe("claude-sonnet-5-5");
    expect(model({ NPC_MODEL: "custom-model" }, "npc")).toBe("custom-model");
  });
});

describe("selectModelProvider: anthropic base URL", () => {
  const base = { MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: KEY };
  it("accepts https and loopback http, and treats blank as unset", () => {
    expect(selectModelProvider({ ...base, ANTHROPIC_BASE_URL: "https://proxy.example/anthropic/" }, "npc").name).toBe("anthropic");
    expect(selectModelProvider({ ...base, ANTHROPIC_BASE_URL: "http://localhost:4000" }, "npc").name).toBe("anthropic");
    expect(selectModelProvider({ ...base, ANTHROPIC_BASE_URL: "  " }, "npc").name).toBe("anthropic");
  });
  it("rejects plain http to a remote host, userinfo and garbage, naming the variable", () => {
    expect(errorOf({ ...base, ANTHROPIC_BASE_URL: "http://proxy.example" })).toMatch(/ANTHROPIC_BASE_URL must use https/);
    const msg = errorOf({ ...base, ANTHROPIC_BASE_URL: `https://me:${KEY}@proxy.example` });
    expect(msg).toMatch(/ANTHROPIC_BASE_URL.*credentials/);
    expect(msg).not.toContain(KEY);
    expect(errorOf({ ...base, ANTHROPIC_BASE_URL: "nonsense" })).toMatch(/ANTHROPIC_BASE_URL is not a valid/);
  });
});

describe("selectModelProvider: openrouter", () => {
  const env = { MODEL_PROVIDER: "openrouter", OPENROUTER_API_KEY: KEY };
  it("selects openrouter with its default model and endpoint", () => {
    const p = selectModelProvider(env, "npc");
    expect(p).toBeInstanceOf(OpenAICompatibleModelProvider);
    expect(p.name).toBe("openrouter");
    expect(modelOf(p)).toBe("anthropic/claude-sonnet-5.5");
    expect(describeModelProvider(env)).toBe("OpenRouter at openrouter.ai");
  });
  it("requires the key and names the variable only", () => {
    const msg = errorOf({ MODEL_PROVIDER: "openrouter" });
    expect(msg).toMatch(/OPENROUTER_API_KEY/);
  });
  it("honors the model override per role, blank falls back, and the base URL override", () => {
    expect(modelOf(selectModelProvider({ ...env, NPC_MODEL: "x/y" }, "npc"))).toBe("x/y");
    expect(modelOf(selectModelProvider({ ...env, NPC_MODEL: "x/y" }, "gm"))).toBe("anthropic/claude-sonnet-5.5");
    expect(modelOf(selectModelProvider({ ...env, GM_MODEL: "  " }, "gm"))).toBe("anthropic/claude-sonnet-5.5");
    expect(describeModelProvider({ ...env, OPENROUTER_BASE_URL: "https://gw.example:8443/or/v1" })).toBe("OpenRouter at gw.example:8443");
  });
  it("rejects a non-https base URL for a remote host", () => {
    expect(errorOf({ ...env, OPENROUTER_BASE_URL: "http://gw.example/v1" })).toMatch(/OPENROUTER_BASE_URL must use https/);
  });
});

describe("selectModelProvider: local", () => {
  const env = { MODEL_PROVIDER: "local", LOCAL_BASE_URL: "http://localhost:11434/v1", NPC_MODEL: "llama3.1", GM_MODEL: "qwen2.5" };
  it("selects local with per-role models and an optional key", () => {
    const npc = selectModelProvider(env, "npc");
    expect(npc.name).toBe("local");
    expect(modelOf(npc)).toBe("llama3.1");
    expect(modelOf(selectModelProvider({ ...env, LOCAL_API_KEY: KEY }, "gm"))).toBe("qwen2.5");
    expect(describeModelProvider(env)).toBe("local OpenAI-compatible server at localhost:11434");
  });
  it("requires LOCAL_BASE_URL", () => {
    expect(errorOf({ ...env, LOCAL_BASE_URL: "" })).toMatch(/LOCAL_BASE_URL is empty/);
    const { LOCAL_BASE_URL: _drop, ...rest } = env; void _drop;
    expect(errorOf(rest)).toMatch(/LOCAL_BASE_URL/);
  });
  it("requires NPC_MODEL / GM_MODEL and names the missing variable", () => {
    expect(errorOf({ ...env, NPC_MODEL: "" }, "npc")).toMatch(/NPC_MODEL/);
    expect(errorOf({ ...env, GM_MODEL: " " }, "gm")).toMatch(/GM_MODEL/);
    const { NPC_MODEL: _n, ...noNpc } = env; void _n;
    expect(errorOf(noNpc, "npc")).toMatch(/NPC_MODEL/);
    expect(() => selectModelProvider(noNpc, "gm")).not.toThrow();
  });
  it("rejects userinfo and wrong protocols without echoing them", () => {
    const msg = errorOf({ ...env, LOCAL_BASE_URL: `http://u:${KEY}@localhost:1/v1` });
    expect(msg).toMatch(/LOCAL_BASE_URL/);
    expect(msg).not.toContain(KEY);
    expect(errorOf({ ...env, LOCAL_BASE_URL: "ws://localhost:1/v1" })).toMatch(/LOCAL_BASE_URL must use/);
  });
});

describe("describeModelProvider", () => {
  it("returns fixed labels, the endpoint host only, and never a key, path or query", () => {
    expect(describeModelProvider({})).toBe("mock");
    expect(describeModelProvider({ MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: KEY })).toBe("Anthropic");
    const custom = describeModelProvider({ MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: "https://proxy.example/secret-path" });
    expect(custom).toBe("Anthropic at proxy.example");
    expect(describeModelProvider({ MODEL_PROVIDER: "local", LOCAL_BASE_URL: "http://10.0.0.5:8000/v1/deep", LOCAL_API_KEY: KEY })).toBe("local OpenAI-compatible server at 10.0.0.5:8000");
  });
});

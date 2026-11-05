import { AnthropicModelProvider } from "./anthropic.js";
import { parseBaseUrl } from "./endpoint.js";
import { MockModelProvider } from "./mock.js";
import { OpenAICompatibleModelProvider } from "./openai-compatible.js";
import type { ModelProvider } from "./types.js";

const KINDS = ["mock", "anthropic", "openrouter", "local"] as const;
type Kind = (typeof KINDS)[number];

const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-5-5";
const OPENROUTER_DEFAULT_MODEL = "anthropic/claude-sonnet-5.5"; // OpenRouter ids are vendor/model
const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Fixed, literal labels per provider kind. Anything that reaches a log line is built from these constants plus an
 * endpoint HOST, never from a provider object or from key-bearing configuration.
 */
const LABELS: Record<Kind, string> = {
  mock: "mock",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  local: "local OpenAI-compatible server",
};

function kindOf(env: NodeJS.ProcessEnv): Kind {
  const raw = env.MODEL_PROVIDER ?? "mock";
  const kind = KINDS.find((k) => k === raw);
  if (!kind) throw new Error(`unknown MODEL_PROVIDER; valid values: ${KINDS.join(", ")}`);
  return kind;
}

function modelOverride(env: NodeJS.ProcessEnv, role: "npc" | "gm"): { name: string; value: string } {
  const name = role === "npc" ? "NPC_MODEL" : "GM_MODEL";
  return { name, value: (env[name] ?? "").trim() };
}

function required(env: NodeJS.ProcessEnv, kind: Kind, variable: string): string {
  const value = env[variable];
  if (!value || value.trim() === "") throw new Error(`MODEL_PROVIDER=${kind} but ${variable} is empty`);
  return value;
}

/** Validated optional base URL: blank means "not set". */
function optionalAnthropicBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.ANTHROPIC_BASE_URL;
  if (raw === undefined || raw.trim() === "") return undefined;
  return parseBaseUrl(raw, "ANTHROPIC_BASE_URL", "https-or-loopback-http");
}

function openRouterBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.OPENROUTER_BASE_URL;
  return parseBaseUrl(raw === undefined || raw.trim() === "" ? OPENROUTER_DEFAULT_BASE_URL : raw, "OPENROUTER_BASE_URL", "https-or-loopback-http");
}

/**
 * The single entry point: every error names variables, never values. `sdkRetries: false` is for callers that wrap the result
 * in a RetryingModelProvider (see AnthropicModelProvider); other providers have no built-in retries.
 */
export function selectModelProvider(env: NodeJS.ProcessEnv, role: "npc" | "gm", opts: { sdkRetries?: boolean } = {}): ModelProvider {
  const kind = kindOf(env);
  const model = modelOverride(env, role);
  switch (kind) {
    case "mock":
      return new MockModelProvider();
    case "anthropic":
      // Byte-compatible for existing users: the key is passed through untouched; the base URL is only added when set.
      return new AnthropicModelProvider({
        apiKey: required(env, kind, "ANTHROPIC_API_KEY"),
        model: model.value || ANTHROPIC_DEFAULT_MODEL,
        baseUrl: optionalAnthropicBaseUrl(env),
        sdkRetries: opts.sdkRetries,
      });
    case "openrouter":
      return new OpenAICompatibleModelProvider({
        name: "openrouter",
        apiKey: required(env, kind, "OPENROUTER_API_KEY"),
        baseUrl: openRouterBaseUrl(env),
        model: model.value || OPENROUTER_DEFAULT_MODEL,
      });
    case "local":
      // LOCAL_BASE_URL is explicitly a self-hosted endpoint (often on the LAN, without TLS), so any host over http or
      // https is allowed; hosted endpoints (OpenRouter, ANTHROPIC_BASE_URL) must use https except on loopback.
      // Model ids are server-specific, so there is no default model.
      if (!model.value) throw new Error(`MODEL_PROVIDER=local but ${model.name} is empty (model ids are server-specific, so there is no default)`);
      return new OpenAICompatibleModelProvider({
        name: "local",
        baseUrl: required(env, kind, "LOCAL_BASE_URL"),
        apiKey: env.LOCAL_API_KEY, // optional: some servers want a dummy token, most want none
        model: model.value,
      });
  }
}

/**
 * A log-safe description of the configured provider: a fixed label and whether a custom endpoint is configured.
 * The yes/no comes from a comparison feeding a LITERAL ternary, so no env-derived string reaches the log, and the
 * endpoint host is deliberately not included. Call it after selectModelProvider succeeded; it re-validates the URLs.
 */
export function describeModelProvider(env: NodeJS.ProcessEnv): string {
  const kind = kindOf(env);
  if (kind === "mock") return LABELS.mock;
  const custom =
    kind === "anthropic" ? optionalAnthropicBaseUrl(env) !== undefined
    : kind === "openrouter" ? openRouterBaseUrl(env) !== OPENROUTER_DEFAULT_BASE_URL
    : true; // local is always a self-configured endpoint
  return `${LABELS[kind]} (custom endpoint: ${custom ? "yes" : "no"})`;
}

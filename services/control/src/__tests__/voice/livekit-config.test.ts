import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { liveKitStartProblems, parseLiveKitConfig, voiceTokensWanted } from "../../voice/livekit-config.js";

// US-0071 (EPIC-0003 voice A1b, Task 5, K2): control's LiveKit settings. Only control reads them; no child ever gets one.
const KEY = "APIabcdef123";
const SECRET = "s".repeat(31) + "Z"; // 32 characters
const both = { LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET };
const errorsOf = (env: NodeJS.ProcessEnv): string[] => { const r = parseLiveKitConfig(env); return r.ok ? [] : r.errors; };

describe("parseLiveKitConfig (US-0071, A1b Task 5)", () => {
  it("no LiveKit variables gives null (LiveKit off)", () => {
    expect(parseLiveKitConfig({})).toEqual({ ok: true, cfg: null });
    expect(parseLiveKitConfig({ LIVEKIT_API_KEY: "", LIVEKIT_API_SECRET: "", LIVEKIT_HOST: "" })).toEqual({ ok: true, cfg: null });
  });

  it("key and secret give the default loopback host and the worker's ws: URL on the same host and port", () => {
    const r = parseLiveKitConfig(both);
    if (!r.ok || !r.cfg) throw new Error("expected a config");
    expect(r.cfg.apiKey).toBe(KEY);
    expect(r.cfg.apiSecret).toBe(SECRET);
    expect(r.cfg.host.href).toBe("http://127.0.0.1:7880/");
    expect(r.cfg.workerUrl).toBe("ws://127.0.0.1:7880");
  });

  it("LIVEKIT_HOST on 127.0.0.1 or [::1] with a port is used", () => {
    const a = parseLiveKitConfig({ ...both, LIVEKIT_HOST: "http://127.0.0.1:17880" });
    const b = parseLiveKitConfig({ ...both, LIVEKIT_HOST: "http://[::1]:7881/" });
    expect(a.ok && a.cfg?.workerUrl).toBe("ws://127.0.0.1:17880");
    expect(b.ok && b.cfg?.workerUrl).toBe("ws://[::1]:7881");
  });

  it("a key without a secret (or a secret without a key) is an error naming both", () => {
    for (const env of [{ LIVEKIT_API_KEY: KEY }, { LIVEKIT_API_SECRET: SECRET }]) {
      const e = errorsOf(env);
      expect(e.join(" ")).toContain("LIVEKIT_API_KEY");
      expect(e.join(" ")).toContain("LIVEKIT_API_SECRET");
    }
  });

  it("LIVEKIT_HOST alone is an error", () => {
    expect(errorsOf({ LIVEKIT_HOST: "http://127.0.0.1:7880" }).join(" ")).toContain("LIVEKIT_HOST");
  });

  it("a 31-character secret is refused", () => {
    expect(errorsOf({ LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: "s".repeat(31) }).join(" ")).toContain("LIVEKIT_API_SECRET");
  });

  it("a key or secret with whitespace or a control character, or an overlong one, is refused", () => {
    expect(errorsOf({ ...both, LIVEKIT_API_KEY: "API key" })).not.toEqual([]);
    expect(errorsOf({ ...both, LIVEKIT_API_KEY: "API\u0000" })).not.toEqual([]);
    expect(errorsOf({ ...both, LIVEKIT_API_KEY: "k".repeat(257) })).not.toEqual([]);
    expect(errorsOf({ ...both, LIVEKIT_API_SECRET: `${SECRET}\n` })).not.toEqual([]);
    expect(errorsOf({ ...both, LIVEKIT_API_SECRET: "s".repeat(513) })).not.toEqual([]);
  });

  it("LIVEKIT_HOST https, a LAN address, localhost, a path, user info, a query, no port or nonsense are refused", () => {
    for (const host of [
      "https://127.0.0.1:7880", "http://192.168.1.2:7880", "http://localhost:7880", "http://127.0.0.1:7880/twirp", "http://u:p@127.0.0.1:7880",
      "http://127.0.0.1:7880?x=1", "http://127.0.0.1:7880#f", "http://127.0.0.1", "ws://127.0.0.1:7880", "not a url",
    ]) {
      const e = errorsOf({ ...both, LIVEKIT_HOST: host });
      expect(e, host).toHaveLength(1);
      expect(e[0]).toContain("LIVEKIT_HOST");
    }
  });

  it("errors never contain the secret, the key or the host value", () => {
    const secret = "SECRET-VALUE-" + "x".repeat(10);
    const all = [
      ...errorsOf({ LIVEKIT_API_KEY: "KEYVALUE", LIVEKIT_API_SECRET: secret }),
      ...errorsOf({ LIVEKIT_API_SECRET: secret }),
      ...errorsOf({ LIVEKIT_API_KEY: "KEY VALUE", LIVEKIT_API_SECRET: `${secret}${"y".repeat(20)}`, LIVEKIT_HOST: "http://10.1.2.3:7880" }),
    ].join("\n");
    expect(all).not.toContain("SECRET-VALUE");
    expect(all).not.toContain("KEYVALUE");
    expect(all).not.toContain("KEY VALUE");
    expect(all).not.toContain("10.1.2.3");
  });
});

describe("liveKitStartProblems: control refuses SPEECH_INGEST=livekit without LiveKit (US-0071, A1b Task 5)", () => {
  it("SPEECH_INGEST=livekit without the key and secret is refused with a sentence naming SPEECH_INGEST and LIVEKIT_API_KEY", () => {
    const p = liveKitStartProblems({ SPEECH_INGEST: "livekit" });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("SPEECH_INGEST");
    expect(p[0]).toContain("LIVEKIT_API_KEY");
  });

  it("SPEECH_INGEST=livekit with LiveKit, SPEECH_INGEST=file or unset without LiveKit are fine", () => {
    expect(liveKitStartProblems({ SPEECH_INGEST: "livekit", ...both })).toEqual([]);
    expect(liveKitStartProblems({ SPEECH_INGEST: "file" })).toEqual([]);
    expect(liveKitStartProblems({})).toEqual([]);
    expect(liveKitStartProblems({ SPEECH_INGEST: "file", ...both })).toEqual([]);
  });

  it("a bad LiveKit setting is a start problem too", () => {
    expect(liveKitStartProblems({ LIVEKIT_API_KEY: KEY }).join(" ")).toContain("LIVEKIT_API_SECRET");
  });
});

describe("voiceTokensWanted (US-0071, A1b batch 3 review F8)", () => {
  const cfg = { apiKey: KEY, apiSecret: SECRET, host: new URL("http://127.0.0.1:7880"), workerUrl: "ws://127.0.0.1:7880" };
  it("tokens only when LiveKit is configured AND the worker reads LiveKit (SPEECH_INGEST=livekit)", () => {
    expect(voiceTokensWanted({ SPEECH_INGEST: "livekit" }, cfg)).toBe(true);
    expect(voiceTokensWanted({ SPEECH_INGEST: "file" }, cfg)).toBe(false); // nobody would listen to the room: no browser may publish into it
    expect(voiceTokensWanted({}, cfg)).toBe(false);
    expect(voiceTokensWanted({ SPEECH_INGEST: "livekit" }, null)).toBe(false);
  });
});

// US-0072 (EPIC-0003 voice A1c, Task 1, review finding 16u): services/voice-ops repeats the LIVEKIT_HOST rule (it may not import control).
// The shared fixture is read by voice-ops, control and the speech worker; each asserts its own parser agrees with every value.
describe("LIVEKIT_HOST shared rules (US-0072)", () => {
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../voice-ops/src/__tests__/fixtures/shared-rules.json");
  const rules = JSON.parse(readFileSync(fixture, "utf8")) as { livekitHost: { accepted: string[]; refused: string[] } };
  it("control agrees with every shared-rules LIVEKIT_HOST value", () => {
    expect(rules.livekitHost.accepted.length).toBeGreaterThan(0);
    for (const v of rules.livekitHost.accepted) expect(errorsOf({ ...both, LIVEKIT_HOST: v }), v).toEqual([]);
    for (const v of rules.livekitHost.refused) expect(errorsOf({ ...both, LIVEKIT_HOST: v }).some((e) => e.startsWith("LIVEKIT_HOST ")), v).toBe(true);
  });
});

// US-0072 (A1c review A F2): voice-ops repeats control's key and secret rule (`isLiveKitToken` in services/voice-ops/src/text.ts) and is
// intentionally STRICTER (it writes the pair into livekit.env and LiveKit's YAML key map). Characterisation: where the two overlap they
// agree; the cases voice-ops alone refuses are accepted here, so the difference stays deliberate.
describe("LIVEKIT_API_KEY and LIVEKIT_API_SECRET shared rules (US-0072)", () => {
  type Side = { accepted: string[]; refusedByBoth: string[]; refusedByVoiceOpsOnly: string[] };
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../voice-ops/src/__tests__/fixtures/shared-rules.json");
  const rules = JSON.parse(readFileSync(fixture, "utf8")) as { livekitKey: Side; livekitSecret: Side };
  it("control agrees with voice-ops on every shared key and secret, and accepts the ones only voice-ops refuses", () => {
    expect(rules.livekitKey.refusedByVoiceOpsOnly.length).toBeGreaterThan(0);
    for (const k of [...rules.livekitKey.accepted, ...rules.livekitKey.refusedByVoiceOpsOnly]) expect(errorsOf({ LIVEKIT_API_KEY: k, LIVEKIT_API_SECRET: SECRET }), JSON.stringify(k)).toEqual([]);
    for (const k of rules.livekitKey.refusedByBoth) expect(errorsOf({ LIVEKIT_API_KEY: k, LIVEKIT_API_SECRET: SECRET }).some((e) => e.startsWith("LIVEKIT_API_KEY ")), JSON.stringify(k)).toBe(true);
    for (const v of [...rules.livekitSecret.accepted, ...rules.livekitSecret.refusedByVoiceOpsOnly]) expect(errorsOf({ LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: v }), JSON.stringify(v)).toEqual([]);
    for (const v of rules.livekitSecret.refusedByBoth) expect(errorsOf({ LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: v }).some((e) => e.startsWith("LIVEKIT_API_SECRET ")), JSON.stringify(v)).toBe(true);
  });
});

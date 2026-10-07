import { describe, expect, it } from "vitest";
import { parseGmConfig } from "../gm-config.js";

describe("parseGmConfig", () => {
  it("defaults: the timeout stays max(NPC reply timeout, 60 s), one re-ask, every 3 utterances", () => {
    expect(parseGmConfig({}, 20_000)).toEqual({ ok: true, timeoutMs: 60_000, reask: true, everyNUtterances: 3, autoRelease: false, transcriptWindow: 40 });
    expect(parseGmConfig({}, 90_000)).toMatchObject({ ok: true, timeoutMs: 90_000 });
    expect(parseGmConfig({ GM_TIMEOUT_MS: " ", GM_REASK: "", GM_EVERY_N_UTTERANCES: "" }, 20_000)).toMatchObject({ ok: true, timeoutMs: 60_000 });
  });
  it("reads each variable on its own", () => {
    expect(parseGmConfig({ GM_TIMEOUT_MS: "15000", GM_REASK: "0", GM_EVERY_N_UTTERANCES: "1" }, 20_000)).toEqual({ ok: true, timeoutMs: 15_000, reask: false, everyNUtterances: 1, autoRelease: false, transcriptWindow: 40 });
    expect(parseGmConfig({ GM_REASK: "1", GM_EVERY_N_UTTERANCES: "20", GM_TIMEOUT_MS: "600000" }, 20_000)).toMatchObject({ ok: true, reask: true, everyNUtterances: 20, timeoutMs: 600_000 });
  });
  it.each([
    [{ GM_TIMEOUT_MS: "499" }, "GM_TIMEOUT_MS"], [{ GM_TIMEOUT_MS: "600001" }, "GM_TIMEOUT_MS"], [{ GM_TIMEOUT_MS: "5s" }, "GM_TIMEOUT_MS"],
    [{ GM_REASK: "2" }, "GM_REASK"], [{ GM_REASK: "yes" }, "GM_REASK"], [{ GM_REASK: "-1" }, "GM_REASK"],
    [{ GM_AUTO_RELEASE: "2" }, "GM_AUTO_RELEASE"], [{ GM_AUTO_RELEASE: "true" }, "GM_AUTO_RELEASE"], [{ GM_AUTO_RELEASE: "on" }, "GM_AUTO_RELEASE"],
    [{ GM_TRANSCRIPT_WINDOW: "9" }, "GM_TRANSCRIPT_WINDOW"], [{ GM_TRANSCRIPT_WINDOW: "501" }, "GM_TRANSCRIPT_WINDOW"], [{ GM_TRANSCRIPT_WINDOW: "all" }, "GM_TRANSCRIPT_WINDOW"],
    [{ GM_EVERY_N_UTTERANCES: "0" }, "GM_EVERY_N_UTTERANCES"], [{ GM_EVERY_N_UTTERANCES: "21" }, "GM_EVERY_N_UTTERANCES"], [{ GM_EVERY_N_UTTERANCES: "1.5" }, "GM_EVERY_N_UTTERANCES"],
  ])("rejects %j and names the variable", (env, name) => {
    const r = parseGmConfig(env, 20_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain(name);
  });
  it("reports every bad variable at once", () => {
    const r = parseGmConfig({ GM_TIMEOUT_MS: "x", GM_REASK: "9", GM_EVERY_N_UTTERANCES: "0", GM_AUTO_RELEASE: "yes" }, 20_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(4);
  });
  it("GM_AUTO_RELEASE (US-0034) is off unless explicitly 1", () => {
    expect(parseGmConfig({ GM_AUTO_RELEASE: "" }, 20_000)).toMatchObject({ ok: true, autoRelease: false });
    expect(parseGmConfig({ GM_AUTO_RELEASE: "0" }, 20_000)).toMatchObject({ ok: true, autoRelease: false });
    expect(parseGmConfig({ GM_AUTO_RELEASE: " 1 " }, 20_000)).toMatchObject({ ok: true, autoRelease: true });
  });
  it("GM_TRANSCRIPT_WINDOW (US-0019): 40 lines by default, 10 to 500, and never smaller than GM_EVERY_N_UTTERANCES", () => {
    expect(parseGmConfig({ GM_TRANSCRIPT_WINDOW: " 120 " }, 20_000)).toMatchObject({ ok: true, transcriptWindow: 120 });
    expect(parseGmConfig({ GM_TRANSCRIPT_WINDOW: "10", GM_EVERY_N_UTTERANCES: "10" }, 20_000)).toMatchObject({ ok: true, transcriptWindow: 10, everyNUtterances: 10 });
    const r = parseGmConfig({ GM_TRANSCRIPT_WINDOW: "12", GM_EVERY_N_UTTERANCES: "15" }, 20_000);
    expect(r.ok).toBe(false);
    // Both variables are named, and the error is about the pair (a window smaller than the cadence would skip lines between evaluations).
    if (!r.ok) { expect(r.errors).toHaveLength(1); expect(r.errors[0]).toContain("GM_TRANSCRIPT_WINDOW"); expect(r.errors[0]).toContain("GM_EVERY_N_UTTERANCES"); }
  });
});

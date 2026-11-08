import { describe, expect, it } from "vitest";
import { VOICE_NEEDS_MANAGED, VOICE_NEEDS_NOTICE_V3, parseVoiceConfig } from "../voice-config.js";
import { noticeNamesAiPlayers, noticeNamesVoice } from "../limits.js";

const ok = { managed: true, noticeVersion: "v3" };

describe("parseVoiceConfig (US-0070)", () => {
  it("is disabled by default, whatever the notice or the mode", () => {
    expect(parseVoiceConfig({}, ok)).toEqual({ ok: true, enabled: false });
    expect(parseVoiceConfig({}, { managed: false, noticeVersion: "v1" })).toEqual({ ok: true, enabled: false });
    expect(parseVoiceConfig({ VOICE_ENABLED: "0" }, { managed: false, noticeVersion: "v2" })).toEqual({ ok: true, enabled: false });
    expect(parseVoiceConfig({ VOICE_ENABLED: "" }, ok)).toEqual({ ok: true, enabled: false });
  });

  it("VOICE_ENABLED=1 with a managed runtime and notice v3 gives turnEndMs 800 by default", () => {
    expect(parseVoiceConfig({ VOICE_ENABLED: "1" }, ok)).toEqual({ ok: true, enabled: true, turnEndMs: 800 });
    expect(parseVoiceConfig({ VOICE_ENABLED: "1" }, { managed: true, noticeVersion: "v10" })).toEqual({ ok: true, enabled: true, turnEndMs: 800 });
    expect(parseVoiceConfig({ VOICE_ENABLED: "1", TURN_END_MS: "300" }, ok)).toEqual({ ok: true, enabled: true, turnEndMs: 300 });
    expect(parseVoiceConfig({ VOICE_ENABLED: "1", TURN_END_MS: "3000" }, ok)).toEqual({ ok: true, enabled: true, turnEndMs: 3000 });
  });

  it("an out-of-range or non-numeric TURN_END_MS is an error naming the variable only, never its value", () => {
    for (const bad of ["299", "3001", "abc", "8e2", "-800", "800.5"]) {
      const r = parseVoiceConfig({ VOICE_ENABLED: "1", TURN_END_MS: bad }, ok);
      expect(r.ok, bad).toBe(false);
      if (r.ok) continue;
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toMatch(/^TURN_END_MS /);
      expect(r.errors[0]).not.toContain(bad);
    }
    // Checked even while voice is off, like every other setting: a typo is never silently ignored.
    expect(parseVoiceConfig({ TURN_END_MS: "abc" }, ok).ok).toBe(false);
  });

  it("VOICE_ENABLED other than 0 or 1 is an error naming the variable only", () => {
    for (const bad of ["2", "yes", "true", "-1"]) {
      const r = parseVoiceConfig({ VOICE_ENABLED: bad }, ok);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) { expect(r.errors[0]).toMatch(/^VOICE_ENABLED /); expect(r.errors[0]).not.toContain(bad); }
    }
  });

  it("VOICE_ENABLED=1 needs a control-managed runtime, then a notice that names voice", () => {
    expect(parseVoiceConfig({ VOICE_ENABLED: "1" }, { managed: false, noticeVersion: "v3" })).toEqual({ ok: false, errors: [VOICE_NEEDS_MANAGED] });
    expect(parseVoiceConfig({ VOICE_ENABLED: "1" }, { managed: true, noticeVersion: "v2" })).toEqual({ ok: false, errors: [VOICE_NEEDS_NOTICE_V3] });
    expect(VOICE_NEEDS_MANAGED).toBe("VOICE_ENABLED=1 needs a session started by the control service (CONTROL_MANAGED=1)");
    expect(VOICE_NEEDS_NOTICE_V3).toBe("VOICE_ENABLED=1 needs a consent notice that describes voice recording (CONSENT_NOTICE_VERSION v3 or later)");
  });
});

describe("noticeNamesVoice (US-0070)", () => {
  it("accepts v<n> with n >= 3 only", () => {
    for (const v of ["v3", "v4", "v10", "v99"]) expect(noticeNamesVoice(v), v).toBe(true);
    for (const v of ["v2", "v1", "v0", "v3a", "V3", "3", "v", "", "v-3", "v3.1", " v3"]) expect(noticeNamesVoice(v), v).toBe(false);
  });
  it("leaves the AI-player rule unchanged", () => {
    for (const v of ["v2", "v3", "v10"]) expect(noticeNamesAiPlayers(v), v).toBe(true);
    for (const v of ["v1", "V2", "v2a"]) expect(noticeNamesAiPlayers(v), v).toBe(false);
  });
});

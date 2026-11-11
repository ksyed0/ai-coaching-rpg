import { describe, expect, it } from "vitest";
import { loadControlConfig } from "../../config.js";
import { parseAudioSettings } from "../../voice/audio-settings.js";

const DATA = "/srv/acr-data";
const errorsOf = (env: NodeJS.ProcessEnv): string[] => { const r = parseAudioSettings(env, DATA); return r.ok ? [] : r.errors; };

describe("parseAudioSettings (US-0073)", () => {
  it("defaults: <dataDir>/audio, 2048 MB free, 30 days", () => {
    expect(parseAudioSettings({}, DATA)).toEqual({ ok: true, audioDir: "/srv/acr-data/audio", minFreeMb: 2048, maxRetentionDays: 30 });
  });

  it("an empty value counts as unset", () => {
    expect(parseAudioSettings({ AUDIO_DIR: "", AUDIO_MIN_FREE_MB: "", AUDIO_MAX_RETENTION_DAYS: "" }, DATA)).toMatchObject({ ok: true, minFreeMb: 2048, maxRetentionDays: 30 });
  });

  it("AUDIO_MAX_RETENTION_DAYS: 1 and 30 accepted, 0 and 31 and junk refused", () => {
    for (const v of ["1", "30"]) expect(parseAudioSettings({ AUDIO_MAX_RETENTION_DAYS: v }, DATA)).toMatchObject({ ok: true, maxRetentionDays: Number(v) });
    for (const v of ["0", "31", "-1", "1.5", "x", " 7"]) expect(errorsOf({ AUDIO_MAX_RETENTION_DAYS: v }), v).toEqual(["AUDIO_MAX_RETENTION_DAYS must be a whole number from 1 to 30"]);
  });

  it("AUDIO_MIN_FREE_MB: 512 and 1000000 accepted, 511 and 1000001 refused", () => {
    for (const v of ["512", "1000000"]) expect(parseAudioSettings({ AUDIO_MIN_FREE_MB: v }, DATA)).toMatchObject({ ok: true, minFreeMb: Number(v) });
    for (const v of ["511", "1000001", "1", "2e3"]) expect(errorsOf({ AUDIO_MIN_FREE_MB: v }), v).toEqual(["AUDIO_MIN_FREE_MB must be a whole number from 512 to 1000000"]);
  });

  it("AUDIO_DIR: absolute accepted (resolved); relative, NUL refused; errors name the variable only", () => {
    expect(parseAudioSettings({ AUDIO_DIR: "/mnt/a/../audio" }, DATA)).toMatchObject({ ok: true, audioDir: "/mnt/audio" });
    for (const v of ["audio", "./audio", "../x", "/a\0b"]) {
      const e = errorsOf({ AUDIO_DIR: v });
      expect(e, v).toEqual(["AUDIO_DIR must be an absolute path"]);
      expect(JSON.stringify(e)).not.toContain(v === "" ? "\u0001" : v.replace("\0", "\u0001"));
    }
  });

  it("every problem is collected", () => {
    expect(errorsOf({ AUDIO_DIR: "x", AUDIO_MIN_FREE_MB: "1", AUDIO_MAX_RETENTION_DAYS: "0" })).toHaveLength(3);
  });
});

describe("loadControlConfig audio settings (US-0073)", () => {
  const base = (o: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ LAUNCHER_TOKEN: "t".repeat(32), CONTROL_DATA_DIR: DATA, ...o });
  it("sits beside dataDir with the defaults", () => {
    const c = loadControlConfig(base());
    expect([c.audioDir, c.audioMinFreeMb, c.audioMaxRetentionDays]).toEqual(["/srv/acr-data/audio", 2048, 30]);
  });
  it("an invalid value fails the config, naming the variable only", () => {
    expect(() => loadControlConfig(base({ AUDIO_MAX_RETENTION_DAYS: "99" }))).toThrow(/AUDIO_MAX_RETENTION_DAYS must be a whole number from 1 to 30/);
    expect(() => loadControlConfig(base({ AUDIO_DIR: "relative/secret" }))).toThrow(/AUDIO_DIR must be an absolute path/);
    try { loadControlConfig(base({ AUDIO_DIR: "relative/secret" })); } catch (e) { expect((e as Error).message).not.toContain("secret"); }
  });
});

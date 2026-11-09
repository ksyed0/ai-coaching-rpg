import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_STT_COLD_TIMEOUT_MS, DEFAULT_STT_IDLE_COLD_MS } from "@acr/adapters";
import { parseWorkerConfig } from "../config.js";
import { FAKE_SCRIPT_REFUSED, loadFakeScript, parseFakeScript } from "../fake-script.js";
import { DEFAULT_SEGMENTER } from "../segmenter.js";

let dir: string;
let savedTmp: string | undefined;
beforeAll(async () => {
  savedTmp = process.env.TMPDIR;
  dir = await mkdtemp(path.join(os.tmpdir(), "acr-speech-config-"));
  process.env.TMPDIR = dir;
});
afterAll(async () => {
  if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
  await rm(dir, { recursive: true, force: true });
});

const base = (o: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ STT_URL: "http://127.0.0.1:9000", SPEECH_INGEST_DIR: "/srv/in", SPEECH_INGEST_ROLES: "tech_lead,pm", ...o });
const errorsOf = (env: NodeJS.ProcessEnv): string[] => { const r = parseWorkerConfig(env); return r.ok ? [] : r.errors; };

describe("parseWorkerConfig (US-0070)", () => {
  it("defaults: whisper on STT_URL, file ingest, the default segmenter and the limiter's cold-start settings", () => {
    const r = parseWorkerConfig(base());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cfg.segmenter).toEqual(DEFAULT_SEGMENTER);
    expect(r.cfg.stt).toEqual({ kind: "whisper", url: new URL("http://127.0.0.1:9000"), coldTimeoutMs: DEFAULT_STT_COLD_TIMEOUT_MS, idleColdMs: DEFAULT_STT_IDLE_COLD_MS });
    expect(r.cfg.ingest).toEqual({ kind: "file", dir: "/srv/in", roles: ["tech_lead", "pm"] });
  });

  it("ranges: VOICE_HANGOVER_MS 300..600, VOICE_MAX_SEGMENT_MS 2000..6000, cold settings", () => {
    const ok = parseWorkerConfig(base({ VOICE_HANGOVER_MS: "300", VOICE_MAX_SEGMENT_MS: "6000", STT_COLD_TIMEOUT_MS: "1000", STT_IDLE_COLD_MS: "86400000" }));
    expect(ok.ok && [ok.cfg.segmenter.hangoverMs, ok.cfg.segmenter.maxSegmentMs]).toEqual([300, 6000]);
    for (const [k, v] of [["VOICE_HANGOVER_MS", "299"], ["VOICE_HANGOVER_MS", "601"], ["VOICE_HANGOVER_MS", "4e2"], ["VOICE_HANGOVER_MS", " 500"], ["VOICE_MAX_SEGMENT_MS", "1999"], ["VOICE_MAX_SEGMENT_MS", "6001"], ["STT_COLD_TIMEOUT_MS", "999"], ["STT_COLD_TIMEOUT_MS", "300001"], ["STT_IDLE_COLD_MS", "999"], ["STT_IDLE_COLD_MS", "x"]] as const) {
      const errs = errorsOf(base({ [k]: v }));
      expect(errs, `${k}=${v}`).toHaveLength(1);
      expect(errs[0]).toContain(k);
      if (v.length >= 3) expect(errs[0]).not.toContain(v); // a refusal never echoes the value
    }
  });

  it("STT_URL refusals name the variable only", () => {
    for (const bad of [undefined, "", "http://localhost:9000", "http://0.0.0.0:9000", "http://192.168.1.4:9000", "https://127.0.0.1:9000", "http://127.0.0.1:9000/?k=v", "http://u:p@127.0.0.1:9000"]) {
      const errs = errorsOf(base({ STT_URL: bad }));
      expect(errs, String(bad)).toHaveLength(1);
      expect(errs[0]).toContain("STT_URL");
      if (bad) expect(errs[0]).not.toContain(bad);
    }
  });

  it("the fake provider needs an absolute STT_FAKE_SCRIPT and no STT_URL", () => {
    const r = parseWorkerConfig(base({ STT_PROVIDER: "fake", STT_URL: undefined, STT_FAKE_SCRIPT: "/srv/script.json" }));
    expect(r.ok && r.cfg.stt).toEqual({ kind: "fake", scriptFile: "/srv/script.json" });
    expect(errorsOf(base({ STT_PROVIDER: "fake", STT_FAKE_SCRIPT: "script.json" }))[0]).toContain("STT_FAKE_SCRIPT");
    expect(errorsOf(base({ STT_PROVIDER: "fake" }))[0]).toContain("STT_FAKE_SCRIPT");
    expect(errorsOf(base({ STT_PROVIDER: "cloud" }))[0]).toContain("STT_PROVIDER");
  });

  it("unknown SPEECH_INGEST is refused (file or livekit)", () => {
    for (const bad of ["mic", "FILE", "LiveKit", "livekit "]) expect(errorsOf(base({ SPEECH_INGEST: bad }))[0], bad).toContain("SPEECH_INGEST");
    expect(parseWorkerConfig(base({ SPEECH_INGEST: "file" })).ok).toBe(true);
  });

  it("SPEECH_INGEST_DIR must be absolute; SPEECH_INGEST_ROLES must be distinct safe role ids", () => {
    expect(errorsOf(base({ SPEECH_INGEST_DIR: "rel/dir" }))[0]).toContain("SPEECH_INGEST_DIR");
    expect(errorsOf(base({ SPEECH_INGEST_DIR: undefined }))[0]).toContain("SPEECH_INGEST_DIR");
    for (const bad of ["../x", "a,,b", "a,a", "facilitator", "__proto__", "A", " a"]) expect(errorsOf(base({ SPEECH_INGEST_ROLES: bad }))[0], bad).toContain("SPEECH_INGEST_ROLES");
    const none = parseWorkerConfig(base({ SPEECH_INGEST_ROLES: "" }));
    expect(none.ok && none.cfg.ingest.roles).toEqual([]);
  });

  it("reports every problem at once, by name", () => {
    const errs = errorsOf({ VOICE_HANGOVER_MS: "1", STT_PROVIDER: "whisper", SPEECH_INGEST: "x" });
    expect(errs.join("\n")).toMatch(/VOICE_HANGOVER_MS[\s\S]*STT_URL[\s\S]*SPEECH_INGEST/);
  });
});

describe("the fake speech-to-text script (offline demo and tests)", () => {
  it("parses { roleId: [lines] } strictly", () => {
    expect(parseFakeScript({ tech_lead: ["one", "two"], pm: [] })).toEqual(new Map([["tech_lead", ["one", "two"]], ["pm", []]]));
    for (const bad of [null, [], "x", { tech_lead: "one" }, { tech_lead: [1] }, { "../x": ["a"] }, { tech_lead: ["x".repeat(2001)] }, JSON.parse('{"__proto__": ["a"]}')]) {
      expect(parseFakeScript(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("answers by segment ordinal per role, then empty, and logs each call (role and ordinal only) to an owner-only file", async () => {
    const file = path.join(dir, "script.json");
    await writeFile(file, JSON.stringify({ tech_lead: ["We ship in May.", "Then June."], pm: ["Agreed."] }));
    const fake = loadFakeScript(file);
    const seg = (id: string) => ({ id, pcm: new Int16Array(10), sampleRate: 16000 as const, deadline: Number.MAX_SAFE_INTEGER });
    const tl = fake.sttFor("tech_lead");
    expect(fake.sttFor("tech_lead")).toBe(tl);
    expect((await tl.transcribe(seg("s1"))).text).toBe("We ship in May.");
    expect((await fake.sttFor("pm").transcribe(seg("s2"))).text).toBe("Agreed.");
    expect((await tl.transcribe(seg("s3"))).text).toBe("Then June.");
    expect((await tl.transcribe(seg("s4"))).text).toBe("");
    expect((await fake.sttFor("nobody").transcribe(seg("s5"))).text).toBe("");
    const log = await readFile(`${file}.calls.jsonl`, "utf8");
    expect(log.trim().split("\n").map((l) => JSON.parse(l))).toEqual([
      { roleId: "tech_lead", n: 1 }, { roleId: "pm", n: 1 }, { roleId: "tech_lead", n: 2 }, { roleId: "tech_lead", n: 3 }, { roleId: "nobody", n: 1 },
    ]);
    expect(log).not.toContain("May");
    expect((await stat(`${file}.calls.jsonl`)).mode & 0o777).toBe(0o600);
  });

  it("an unreadable, malformed, oversized or symlinked script is refused with one fixed sentence", async () => {
    const bad = path.join(dir, "bad.json");
    await writeFile(bad, "{ not json");
    const big = path.join(dir, "big.json");
    await writeFile(big, JSON.stringify({ a: Array.from({ length: 700 }, () => "x".repeat(1999)) }));
    const target = path.join(dir, "target.json");
    await writeFile(target, JSON.stringify({ a: ["x"] }));
    const link = path.join(dir, "link.json");
    await symlink(target, link);
    for (const f of [path.join(dir, "missing.json"), bad, big, link]) {
      expect(() => loadFakeScript(f), f).toThrow(FAKE_SCRIPT_REFUSED);
    }
  });
});

describe("parseWorkerConfig: LiveKit ingest and STT_MODEL (US-0071, A1b Task 7, R25)", () => {
  it("SPEECH_INGEST=livekit needs no dir and keeps the roles", () => {
    const r = parseWorkerConfig({ STT_URL: "http://127.0.0.1:9000", SPEECH_INGEST: "livekit", SPEECH_INGEST_ROLES: "tech_lead,pm" });
    expect(r.ok && r.cfg.ingest).toEqual({ kind: "livekit", roles: ["tech_lead", "pm"] });
    const bad = errorsOf({ STT_URL: "http://127.0.0.1:9000", SPEECH_INGEST: "livekit", SPEECH_INGEST_ROLES: "../x" });
    expect(bad[0]).toContain("SPEECH_INGEST_ROLES");
  });

  it("STT_MODEL small.en and large-v3-turbo-q5_0 pass; unset or empty passes", () => {
    for (const ok of ["small.en", "large-v3-turbo-q5_0", "base", "a".repeat(64)]) expect(parseWorkerConfig(base({ STT_MODEL: ok })).ok, ok).toBe(true);
    expect(parseWorkerConfig(base({ STT_MODEL: "" })).ok).toBe(true);
    expect(parseWorkerConfig(base()).ok).toBe(true);
  });

  it("STT_MODEL \"a b\", \"../m\", 65 characters, an empty part or a slash fail with an error naming the variable only", () => {
    for (const bad of ["a b", "../m", "a".repeat(65), "small..en", ".en", "small.", "m/x", "m\u0000"]) {
      const e = errorsOf(base({ STT_MODEL: bad }));
      expect(e, JSON.stringify(bad)).toHaveLength(1);
      expect(e[0]).toContain("STT_MODEL");
      expect(e[0]).not.toContain(bad);
    }
  });
});

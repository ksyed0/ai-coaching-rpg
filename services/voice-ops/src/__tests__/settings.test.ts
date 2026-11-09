import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRootEnv, parseVoiceOpsSettings, type VoiceOpsSettings } from "../settings.js";

// US-0072 (EPIC-0003 voice A1c, Task 1): the voice-ops settings. Every error names the variable and its rule, never a value.
const HOME = "/home/pilot";
const REPO = "/work/ai-coaching-rpg";
const o = { home: HOME, repoRoot: REPO };
const ok = (env: NodeJS.ProcessEnv): VoiceOpsSettings => {
  const r = parseVoiceOpsSettings(env, o);
  if (!r.ok) throw new Error(`expected ok, got ${r.errors.join("; ")}`);
  return r.s;
};
const errs = (env: NodeJS.ProcessEnv): string[] => { const r = parseVoiceOpsSettings(env, o); return r.ok ? [] : r.errors; };
const LAN = { VOICE_ACCESS: "lan", VOICE_HOSTNAME: "pilot.example.com", VOICE_TLS_CERT_FILE: "/certs/pilot.crt", VOICE_TLS_KEY_FILE: "/certs/pilot.key" };
const rules = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/shared-rules.json"), "utf8")) as {
  livekitHost: { accepted: string[]; refused: string[] }; sttModel: { accepted: string[]; refused: string[] };
};

let tmp: string;
let savedTmp: string | undefined;
beforeAll(async () => {
  savedTmp = process.env.TMPDIR;
  tmp = await mkdtemp(path.join(os.tmpdir(), "acr-voice-ops-settings-"));
  process.env.TMPDIR = tmp;
});
afterAll(async () => {
  if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
  await rm(tmp, { recursive: true, force: true });
});

describe("parseVoiceOpsSettings (US-0072, A1c Task 1)", () => {
  it("defaults give local mode, small.en and the home paths", () => {
    const s = ok({});
    expect(s.access).toBe("local");
    expect(s.stateDir).toBe(path.join(HOME, ".scenecoach", "voice"));
    expect(s.model).toEqual({ label: "small.en", file: path.join(HOME, ".scenecoach", "models", "ggml-small.en.bin") });
    expect(s.webPort).toBe(3000);
    expect(s.livekitHost.href).toBe("http://127.0.0.1:7880/");
    expect(s.lan).toBeUndefined();
    expect(s.audioMinFreeMb).toBe(2048);
    expect(s.audioDir).toBeUndefined();
  });

  it("an empty value counts as unset", () => {
    expect(ok({ VOICE_ACCESS: "", VOICE_STATE_DIR: "", STT_MODEL: "", STT_MODEL_FILE: "", VOICE_WEB_PORT: "", LIVEKIT_HOST: "", AUDIO_MIN_FREE_MB: "", AUDIO_DIR: "" })).toEqual(ok({}));
  });

  it("the model file default follows STT_MODEL; STT_MODEL_FILE overrides it", () => {
    expect(ok({ STT_MODEL: "large-v3-turbo-q5_0" }).model).toEqual({ label: "large-v3-turbo-q5_0", file: path.join(HOME, ".scenecoach", "models", "ggml-large-v3-turbo-q5_0.bin") });
    expect(ok({ STT_MODEL_FILE: "/models/x.bin" }).model).toEqual({ label: "small.en", file: "/models/x.bin" });
  });

  it("explicit values are read", () => {
    const s = ok({ VOICE_STATE_DIR: "/var/voice", VOICE_WEB_PORT: "3100", AUDIO_MIN_FREE_MB: "512", AUDIO_DIR: "/data/audio", LIVEKIT_HOST: "http://[::1]:7880" });
    expect(s.stateDir).toBe("/var/voice");
    expect(s.webPort).toBe(3100);
    expect(s.audioMinFreeMb).toBe(512);
    expect(s.audioDir).toBe("/data/audio");
    expect(s.livekitHost.hostname).toBe("[::1]");
    expect(ok({ AUDIO_MIN_FREE_MB: "1000000" }).audioMinFreeMb).toBe(1_000_000);
  });

  it("AUDIO_DIR defaults to <CONTROL_DATA_DIR>/audio when CONTROL_DATA_DIR is an absolute path", () => {
    expect(ok({ CONTROL_DATA_DIR: "/data/control" }).audioDir).toBe(path.join("/data/control", "audio"));
    expect(ok({ CONTROL_DATA_DIR: "relative/dir" }).audioDir).toBeUndefined();
    expect(ok({ CONTROL_DATA_DIR: "/data/control", AUDIO_DIR: "/elsewhere" }).audioDir).toBe("/elsewhere");
  });

  it("VOICE_ACCESS is local or lan", () => {
    expect(errs({ VOICE_ACCESS: "remote" })).toEqual(["VOICE_ACCESS must be local or lan"]);
    expect(errs({ VOICE_ACCESS: "LAN" })).toEqual(["VOICE_ACCESS must be local or lan"]);
  });

  it("lan needs VOICE_HOSTNAME and both certificate files", () => {
    expect(errs({ VOICE_ACCESS: "lan" })).toEqual([
      "VOICE_HOSTNAME is required with VOICE_ACCESS=lan (a DNS name of at least two labels, not localhost or an address)",
      "VOICE_TLS_CERT_FILE is required with VOICE_TLS_MODE=files (an absolute path)",
      "VOICE_TLS_KEY_FILE is required with VOICE_TLS_MODE=files (an absolute path)",
    ]);
    expect(errs({ ...LAN, VOICE_TLS_KEY_FILE: undefined })).toEqual(["VOICE_TLS_KEY_FILE is required with VOICE_TLS_MODE=files (an absolute path)"]);
    expect(errs({ ...LAN, VOICE_HOSTNAME: "localhost" })).toEqual(["VOICE_HOSTNAME must be a DNS name of at least two labels, not localhost or an address"]);
    expect(errs({ ...LAN, VOICE_HOSTNAME: "192.168.1.20" })).toEqual(["VOICE_HOSTNAME must be a DNS name of at least two labels, not localhost or an address"]);
  });

  it("lan gives the hostname, the default ports and the certificate files", () => {
    expect(ok(LAN).lan).toEqual({ hostname: "pilot.example.com", httpsPort: 443, livekitTlsPort: 7443, tls: { mode: "files", certFile: "/certs/pilot.crt", keyFile: "/certs/pilot.key" } });
    const s = ok({ ...LAN, VOICE_NODE_IP: "192.168.1.20", VOICE_HTTPS_PORT: "8443", VOICE_LIVEKIT_TLS_PORT: "9443" });
    expect(s.lan).toMatchObject({ nodeIp: "192.168.1.20", httpsPort: 8443, livekitTlsPort: 9443 });
  });

  it("local mode ignores the lan settings", () => {
    expect(ok({ VOICE_HOSTNAME: "bad host", VOICE_TLS_MODE: "nonsense", VOICE_NODE_IP: "8.8.8.8" }).lan).toBeUndefined();
  });

  it("VOICE_NODE_IP must be a private IPv4 address", () => {
    for (const v of ["8.8.8.8", "127.0.0.1", "fd12::1", "192.168.1", "169.254.1.1"]) {
      expect(errs({ ...LAN, VOICE_NODE_IP: v }), v).toEqual(["VOICE_NODE_IP must be a private IPv4 address of this machine (10/8, 172.16/12 or 192.168/16)"]);
    }
  });

  it("the TLS ports are whole numbers from 1 to 65535 and differ", () => {
    expect(errs({ ...LAN, VOICE_HTTPS_PORT: "0" })).toEqual(["VOICE_HTTPS_PORT must be a whole number from 1 to 65535"]);
    expect(errs({ ...LAN, VOICE_LIVEKIT_TLS_PORT: "65536" })).toEqual(["VOICE_LIVEKIT_TLS_PORT must be a whole number from 1 to 65535"]);
    expect(errs({ ...LAN, VOICE_HTTPS_PORT: "7443" })).toEqual(["VOICE_HTTPS_PORT and VOICE_LIVEKIT_TLS_PORT must differ"]);
  });

  it("VOICE_TLS_MODE=dns is accepted only with VOICE_DNS_PROVIDER", () => {
    const dns = { VOICE_ACCESS: "lan", VOICE_HOSTNAME: "pilot.example.com", VOICE_TLS_MODE: "dns" };
    expect(errs(dns)).toEqual(["VOICE_DNS_PROVIDER is required with VOICE_TLS_MODE=dns (1 to 64 lower-case letters, digits or -)"]);
    expect(errs({ ...dns, VOICE_DNS_PROVIDER: "Cloud Flare" })).toEqual(["VOICE_DNS_PROVIDER is required with VOICE_TLS_MODE=dns (1 to 64 lower-case letters, digits or -)"]);
    expect(ok({ ...dns, VOICE_DNS_PROVIDER: "cloudflare" }).lan?.tls).toEqual({ mode: "dns", provider: "cloudflare" });
    expect(errs({ ...LAN, VOICE_TLS_MODE: "acme" })).toEqual(["VOICE_TLS_MODE must be files or dns"]);
  });

  it("VOICE_STATE_DIR inside the repository is refused", () => {
    for (const v of [REPO, `${REPO}/.voice`, `${REPO}/data/x/..`]) {
      expect(errs({ VOICE_STATE_DIR: v }), v).toEqual(["VOICE_STATE_DIR must be outside the repository"]);
    }
    expect(ok({ VOICE_STATE_DIR: `${REPO}-voice` }).stateDir).toBe(`${REPO}-voice`);
    expect(ok({ VOICE_STATE_DIR: `${REPO}/../voice` }).stateDir).toBe("/work/voice");
  });

  it("a home inside the repository makes the default state directory refused too", () => {
    const r = parseVoiceOpsSettings({}, { home: `${REPO}/home`, repoRoot: REPO });
    expect(r.ok ? [] : r.errors).toEqual(["VOICE_STATE_DIR must be outside the repository"]);
  });

  it("relative paths are refused", () => {
    expect(errs({ VOICE_STATE_DIR: "voice" })).toEqual(["VOICE_STATE_DIR must be an absolute path"]);
    expect(errs({ STT_MODEL_FILE: "models/x.bin" })).toEqual(["STT_MODEL_FILE must be an absolute path"]);
    expect(errs({ AUDIO_DIR: "./audio" })).toEqual(["AUDIO_DIR must be an absolute path"]);
    expect(errs({ ...LAN, VOICE_TLS_CERT_FILE: "pilot.crt", VOICE_TLS_KEY_FILE: "pilot.key" })).toEqual([
      "VOICE_TLS_CERT_FILE is required with VOICE_TLS_MODE=files (an absolute path)",
      "VOICE_TLS_KEY_FILE is required with VOICE_TLS_MODE=files (an absolute path)",
    ]);
    const r = parseVoiceOpsSettings({}, { home: "relative-home", repoRoot: REPO });
    expect(r.ok ? [] : r.errors).toEqual(["VOICE_STATE_DIR must be an absolute path", "STT_MODEL_FILE must be an absolute path"]);
  });

  it("STT_MODEL follows the worker's rule", () => {
    expect(ok({ STT_MODEL: "large-v3-turbo-q5_0" }).model.label).toBe("large-v3-turbo-q5_0");
    expect(errs({ STT_MODEL: "../x" })).toEqual(["STT_MODEL must be 1 to 64 characters, dot-separated parts of letters, digits, _ or -"]);
  });

  it("VOICE_WEB_PORT is a whole number from 1024 to 65535", () => {
    for (const v of ["1023", "65536", "3e3", "-1", " 3000", "3000.0", "12345678901"]) {
      expect(errs({ VOICE_WEB_PORT: v }), v).toEqual(["VOICE_WEB_PORT must be a whole number from 1024 to 65535"]);
    }
    expect(ok({ VOICE_WEB_PORT: "1024" }).webPort).toBe(1024);
  });

  it("AUDIO_MIN_FREE_MB 511 and 1000001 are refused", () => {
    expect(errs({ AUDIO_MIN_FREE_MB: "511" })).toEqual(["AUDIO_MIN_FREE_MB must be a whole number from 512 to 1000000"]);
    expect(errs({ AUDIO_MIN_FREE_MB: "1000001" })).toEqual(["AUDIO_MIN_FREE_MB must be a whole number from 512 to 1000000"]);
  });

  it("LIVEKIT_HOST to a LAN address is refused", () => {
    expect(errs({ LIVEKIT_HOST: "http://192.168.1.20:7880" })).toEqual(["LIVEKIT_HOST must be http://127.0.0.1:<port> or http://[::1]:<port> with no path, user, query or fragment"]);
  });

  it("collects every problem at once", () => {
    expect(errs({ VOICE_ACCESS: "x", VOICE_WEB_PORT: "1", STT_MODEL: "a b", AUDIO_MIN_FREE_MB: "1" })).toHaveLength(4);
  });

  it("voice-ops, control and the worker agree on every shared-rules value (this side: voice-ops)", () => {
    for (const v of rules.livekitHost.accepted) expect(errs({ LIVEKIT_HOST: v }), v).toEqual([]);
    for (const v of rules.livekitHost.refused) expect(errs({ LIVEKIT_HOST: v }).some((e) => e.startsWith("LIVEKIT_HOST ")), v).toBe(true);
    for (const v of rules.sttModel.accepted) expect(errs({ STT_MODEL: v }), v).toEqual([]);
    for (const v of rules.sttModel.refused) expect(errs({ STT_MODEL: v }).some((e) => e.startsWith("STT_MODEL ")), v).toBe(true);
  });

  it("no error message contains a value", () => {
    const M = "MARKERq7";
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["VOICE_ACCESS", "VOICE_STATE_DIR", "STT_MODEL", "STT_MODEL_FILE", "VOICE_WEB_PORT", "LIVEKIT_HOST", "AUDIO_MIN_FREE_MB", "AUDIO_DIR"]) env[name] = `${M} ${name}`;
    const all = [...errs(env), ...errs({ ...LAN, VOICE_HOSTNAME: `${M}..x`, VOICE_NODE_IP: `${M}1`, VOICE_HTTPS_PORT: M, VOICE_LIVEKIT_TLS_PORT: M, VOICE_TLS_CERT_FILE: M, VOICE_TLS_KEY_FILE: M }),
      ...errs({ ...LAN, VOICE_TLS_MODE: M }), ...errs({ ...LAN, VOICE_TLS_MODE: "dns", VOICE_DNS_PROVIDER: M }), ...errs({ VOICE_STATE_DIR: `${REPO}/${M}` })];
    expect(all.length).toBeGreaterThanOrEqual(15);
    for (const e of all) { expect(e).not.toContain(M); expect(e).not.toContain(REPO); expect(e).not.toContain(HOME); }
  });
});

describe("loadRootEnv (US-0072, control's rule)", () => {
  it("merges <root>/.env under the real environment, which wins", async () => {
    const root = await mkdtemp(path.join(tmp, "root-"));
    await writeFile(path.join(root, ".env"), "A=from-file\nB=from-file\n# C=comment\n", { mode: 0o600 });
    const env = loadRootEnv(root, { B: "from-env", D: "env-only" });
    expect(env.A).toBe("from-file");
    expect(env.B).toBe("from-env");
    expect(env.C).toBeUndefined();
    expect(env.D).toBe("env-only");
  });

  it("a missing .env is no error", async () => {
    const root = await mkdtemp(path.join(tmp, "root-"));
    expect(loadRootEnv(root, { X: "1" })).toEqual({ X: "1" });
  });

  it("an unreadable one names no path and no content", async () => {
    const root = await mkdtemp(path.join(tmp, "root-"));
    await mkdir(path.join(root, ".env"));
    let message = "";
    try { loadRootEnv(root, {}); } catch (err) { message = (err as Error).message; }
    expect(message).toMatch(/^cannot read \.env \(/);
    expect(message).not.toContain(root);
  });

  it("does not change the environment it was given", async () => {
    const root = await mkdtemp(path.join(tmp, "root-"));
    await writeFile(path.join(root, ".env"), "A=1\n", { mode: 0o600 });
    const given = { B: "2" };
    loadRootEnv(root, given);
    expect(given).toEqual({ B: "2" });
  });
});

import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import type os from "node:os";
import nodeOs from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COMPOSE_FILE, COMPOSE_PROJECT, composeArgs, composeEnv, dockerProblem, LiveKitEnvError, LOCAL_DUMMY_PORTS, MIN_COMPOSE_VERSION, nodeAddress, removeLiveKitEnv, writeLiveKitEnv,
} from "../compose.js";
import type { Run } from "../run.js";
import { loadRootEnv, parseVoiceOpsSettings, type VoiceOpsSettings } from "../settings.js";
import { openStateDir } from "../state.js";

// US-0072 (EPIC-0003 voice A1c, Task 5): compose arguments and environment, the LiveKit env file, the Docker checks and the node
// address. No Docker command runs here: `run` is a fake that answers like the docker CLI. Keys are fabricated placeholders.

let root: string;
let savedTmp: string | undefined;
beforeAll(() => {
  savedTmp = process.env.TMPDIR;
  root = realpathSync(mkdtempSync(path.join(nodeOs.tmpdir(), "acr-voice-ops-compose-")));
  process.env.TMPDIR = root;
});
afterAll(() => {
  if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
  rmSync(root, { recursive: true, force: true });
});
const newDir = (): string => mkdtempSync(path.join(root, "d-"));
const HOME = "/home/placeholder";
const REPO = "/work/repo";

const KEY = "APIplaceholderkey0001";
const SECRET = "placeholder-secret-".padEnd(48, "x");
const SECRETS = { LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET, STT_URL: "http://127.0.0.1:24680/0123456789abcdef0123456789abcdef", VOICE_DNS_API_TOKEN: "dns-token-placeholder" };

function settings(env: NodeJS.ProcessEnv): VoiceOpsSettings {
  const r = parseVoiceOpsSettings(env, { home: HOME, repoRoot: REPO });
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.s;
}
const LAN_ENV = {
  VOICE_ACCESS: "lan", VOICE_HOSTNAME: "pilot.example.com", VOICE_TLS_CERT_FILE: "/certs/pilot.crt", VOICE_TLS_KEY_FILE: "/certs/pilot.key", VOICE_WEB_PORT: "3000",
};

describe("composeArgs (US-0072, A1c Task 5)", () => {
  const file = path.join(REPO, COMPOSE_FILE);
  it("up in local mode: no profile, --wait with its timeout, --quiet-pull, never a build", () => {
    expect(composeArgs(REPO, "local", "up")).toEqual(["compose", "-p", "scenecoach-voice", "-f", file, "up", "-d", "--no-build", "--wait", "--wait-timeout", "60", "--quiet-pull"]);
  });
  it("up in lan mode adds the lan profile; a service list goes last", () => {
    expect(composeArgs(REPO, "lan", "up")).toEqual(["compose", "-p", "scenecoach-voice", "-f", file, "--profile", "lan", "up", "-d", "--no-build", "--wait", "--wait-timeout", "60", "--quiet-pull"]);
    expect(composeArgs(REPO, "lan", "up", ["livekit"])).toEqual(["compose", "-p", "scenecoach-voice", "-f", file, "--profile", "lan", "up", "-d", "--no-build", "--wait", "--wait-timeout", "60", "--quiet-pull", "livekit"]);
  });
  it("down names every profile, whatever the mode, and removes orphans", () => {
    for (const access of ["local", "lan"] as const) {
      expect(composeArgs(REPO, access, "down")).toEqual(["compose", "-p", "scenecoach-voice", "-f", file, "--profile", "lan", "down", "--remove-orphans"]);
    }
  });
  it("refuses a service name that is not one of ours", () => {
    expect(() => composeArgs(REPO, "local", "up", ["--build"])).toThrow();
    expect(() => composeArgs(REPO, "local", "up", ["web"])).toThrow();
  });
  it("the project name is fixed", () => { expect(COMPOSE_PROJECT).toBe("scenecoach-voice"); });
});

describe("composeEnv (US-0072, A1c Task 5)", () => {
  const parent = { PATH: "/usr/bin:/bin", HOME, DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONFIG: "/h/.docker", COMPOSE_PROFILES: "lan", COMPOSE_FILE: "/x.yml", NODE_OPTIONS: "--require x", ...SECRETS };

  it("composeEnv carries no secret; DOCKER_* passes, COMPOSE_* does not", () => {
    for (const s of [settings({}), settings(LAN_ENV)]) {
      const env = composeEnv(parent, s, s.access === "lan" ? "192.168.1.20" : "127.0.0.1");
      expect(env.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
      expect(env.DOCKER_CONFIG).toBe("/h/.docker");
      for (const name of Object.keys(env)) expect(name.startsWith("LIVEKIT_") || name === "STT_URL" || name.startsWith("COMPOSE_") || name === "VOICE_DNS_API_TOKEN" || name === "NODE_OPTIONS", name).toBe(false);
      for (const v of Object.values(env)) for (const secret of Object.values(SECRETS)) expect(v).not.toContain(secret);
    }
  });

  it("local mode gets valid dummy ports 65533 and 65534 and harmless lan values", () => {
    const env = composeEnv(parent, settings({ VOICE_STATE_DIR: "/state/voice" }), "127.0.0.1");
    expect(LOCAL_DUMMY_PORTS).toEqual({ https: 65533, livekitTls: 65534 });
    expect(env).toEqual({
      PATH: "/usr/bin:/bin", HOME, DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONFIG: "/h/.docker",
      VOICE_STATE_DIR: "/state/voice", VOICE_NODE_IP: "127.0.0.1", VOICE_MEDIA_BIND: "127.0.0.1",
      VOICE_HOSTNAME: "voice.invalid", VOICE_HTTPS_PORT: "65533", VOICE_LIVEKIT_TLS_PORT: "65534", VOICE_TLS_CERT_FILE: "/dev/null", VOICE_TLS_KEY_FILE: "/dev/null",
      VOICE_WEB_UPSTREAM: "127.0.0.1:1",
    });
  });

  it("lan mode carries the hostname, the ports, the certificate paths and the web upstream through the engine", () => {
    const env = composeEnv(parent, settings({ ...LAN_ENV, VOICE_STATE_DIR: "/state/voice", VOICE_WEB_PORT: "3100", VOICE_HTTPS_PORT: "8443" }), "192.168.1.20");
    expect(env).toMatchObject({
      VOICE_STATE_DIR: "/state/voice", VOICE_NODE_IP: "192.168.1.20", VOICE_MEDIA_BIND: "192.168.1.20", VOICE_HOSTNAME: "pilot.example.com",
      VOICE_HTTPS_PORT: "8443", VOICE_LIVEKIT_TLS_PORT: "7443", VOICE_TLS_CERT_FILE: "/certs/pilot.crt", VOICE_TLS_KEY_FILE: "/certs/pilot.key",
      VOICE_WEB_UPSTREAM: "host.docker.internal:3100",
    });
  });

  it("sets every variable voice.yml interpolates, in both modes, and no other VOICE_* name", () => {
    const text = readFileSync(path.resolve(import.meta.dirname, "../../../..", COMPOSE_FILE), "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    const used = new Set<string>();
    for (let i = text.indexOf("${"); i >= 0; i = text.indexOf("${", i + 2)) used.add(text.slice(i + 2, text.indexOf(":?", i)));
    expect([...used].sort()).toEqual(["VOICE_HOSTNAME", "VOICE_HTTPS_PORT", "VOICE_LIVEKIT_TLS_PORT", "VOICE_MEDIA_BIND", "VOICE_NODE_IP", "VOICE_STATE_DIR", "VOICE_TLS_CERT_FILE", "VOICE_TLS_KEY_FILE", "VOICE_WEB_UPSTREAM"]);
    for (const [s, ip] of [[settings({}), "127.0.0.1"], [settings(LAN_ENV), "192.168.1.20"]] as const) {
      const env = composeEnv(parent, s, ip);
      expect(Object.keys(env).filter((k) => k.startsWith("VOICE_")).sort()).toEqual([...used].sort());
      for (const name of used) expect(env[name], name).toMatch(/^.+$/);
    }
  });

  it("refuses a node address that is not an IPv4 address", () => {
    expect(() => composeEnv(parent, settings({}), "not-an-ip")).toThrow();
  });
});

describe("writeLiveKitEnv (US-0072, A1c Task 5)", () => {
  const stateDir = (): string => { const d = path.join(newDir(), "voice"); openStateDir(d, { repoRoot: newDir() }); return d; };

  it("writes 0600 and the exact line, leaving no temporary file", () => {
    const d = stateDir();
    writeLiveKitEnv(d, { LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET });
    const f = path.join(d, "livekit.env");
    expect(readFileSync(f, "utf8")).toBe(`LIVEKIT_KEYS=${KEY}: ${SECRET}\n`);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(readdirSync(d)).toEqual(["livekit.env"]);
  });

  it("writes the merged view: a real-environment key that differs from .env is the one written (the view control reads)", () => {
    const repo = newDir();
    writeFileSync(path.join(repo, ".env"), `LIVEKIT_API_KEY=APIfromdotenv0001\nLIVEKIT_API_SECRET=${"d".repeat(40)}\n`, { mode: 0o600 });
    const merged = loadRootEnv(repo, { LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET });
    const d = stateDir();
    writeLiveKitEnv(d, merged);
    expect(readFileSync(path.join(d, "livekit.env"), "utf8")).toBe(`LIVEKIT_KEYS=${KEY}: ${SECRET}\n`);
  });

  it("replaces an older file atomically", () => {
    const d = stateDir();
    writeLiveKitEnv(d, { LIVEKIT_API_KEY: "APIold000000000000001", LIVEKIT_API_SECRET: SECRET });
    writeLiveKitEnv(d, { LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET });
    expect(readFileSync(path.join(d, "livekit.env"), "utf8")).toBe(`LIVEKIT_KEYS=${KEY}: ${SECRET}\n`);
    expect(readdirSync(d)).toEqual(["livekit.env"]);
  });

  it("re-checks the pair with control's and livekit.env's rules, and names the variable only", () => {
    const bad: [Record<string, string | undefined>, string][] = [
      [{ LIVEKIT_API_SECRET: SECRET }, "LIVEKIT_API_KEY"], [{ LIVEKIT_API_KEY: KEY }, "LIVEKIT_API_SECRET"],
      [{ LIVEKIT_API_KEY: "", LIVEKIT_API_SECRET: SECRET }, "LIVEKIT_API_KEY"],
      [{ LIVEKIT_API_KEY: "API key", LIVEKIT_API_SECRET: SECRET }, "LIVEKIT_API_KEY"], [{ LIVEKIT_API_KEY: "API:x", LIVEKIT_API_SECRET: SECRET }, "LIVEKIT_API_KEY"],
      [{ LIVEKIT_API_KEY: "k".repeat(257), LIVEKIT_API_SECRET: SECRET }, "LIVEKIT_API_KEY"],
      [{ LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: "s".repeat(31) }, "LIVEKIT_API_SECRET"], [{ LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: `${SECRET}\nX=1` }, "LIVEKIT_API_SECRET"],
      [{ LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: `${SECRET}#` }, "LIVEKIT_API_SECRET"], [{ LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: "s".repeat(513) }, "LIVEKIT_API_SECRET"],
      [{ LIVEKIT_API_KEY: "devkey", LIVEKIT_API_SECRET: SECRET }, "LIVEKIT_API_KEY"], [{ LIVEKIT_API_KEY: "DEVKEY", LIVEKIT_API_SECRET: SECRET }, "LIVEKIT_API_KEY"],
    ];
    for (const [env, name] of bad) {
      const d = stateDir();
      let err: unknown;
      try { writeLiveKitEnv(d, env); } catch (e) { err = e; }
      expect(err, JSON.stringify(Object.keys(env))).toBeInstanceOf(LiveKitEnvError);
      const msg = (err as Error).message;
      expect(msg).toContain(name);
      for (const v of Object.values(env)) if (v && v.length > 3) expect(msg).not.toContain(v);
      expect(existsSync(path.join(d, "livekit.env"))).toBe(false);
    }
  });

  it("removeLiveKitEnv removes the file and is idempotent", () => {
    const d = stateDir();
    writeLiveKitEnv(d, { LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET });
    removeLiveKitEnv(d);
    expect(existsSync(path.join(d, "livekit.env"))).toBe(false);
    expect(() => removeLiveKitEnv(d)).not.toThrow();
  });
});

describe("dockerProblem (US-0072, A1c Task 5)", () => {
  /** A fake docker CLI: `compose version --short` and `context inspect --format ...` answers. */
  function docker(o: { compose?: string | null; composeCode?: number; endpoint?: string; contextCode?: number | null; missing?: boolean }): Run & { calls: { args: readonly string[]; env?: NodeJS.ProcessEnv }[] } {
    const calls: { args: readonly string[]; env?: NodeJS.ProcessEnv }[] = [];
    const run = (async (cmd, args, ro) => {
      calls.push({ args, ...(ro?.env ? { env: ro.env } : {}) });
      if (cmd !== "docker") throw new Error("unexpected command");
      if (o.missing) throw new Error("could not run docker (ENOENT)");
      if (args[0] === "compose") return { code: o.composeCode ?? 0, stdout: `${o.compose ?? "2.24.0"}\n`, stderr: "" };
      return { code: o.contextCode === undefined ? 0 : o.contextCode, stdout: `${o.endpoint ?? "unix:///var/run/docker.sock"}\n`, stderr: "" };
    }) as Run & { calls: typeof calls };
    run.calls = calls;
    return run;
  }
  const env = { PATH: "/usr/bin:/bin", HOME, ...SECRETS };

  it("accepts Compose 2.24.0, v5.5.0 and a desktop build string, on a local unix socket (OrbStack too)", async () => {
    expect(MIN_COMPOSE_VERSION).toBe("2.24.0");
    for (const compose of ["2.24.0", "v5.5.0", "2.29.2-desktop.2", "v2.40.3"]) expect(await dockerProblem(env, docker({ compose })), compose).toBeNull();
    expect(await dockerProblem(env, docker({ endpoint: "unix:///Users/x/.orbstack/run/docker.sock" }))).toBeNull();
    expect(await dockerProblem(env, docker({ endpoint: "npipe:////./pipe/docker_engine" }))).toBeNull();
    expect(await dockerProblem({ ...env, DOCKER_HOST: "unix:///var/run/docker.sock" }, docker({}))).toBeNull();
  });

  it("refuses Compose 2.23.9 and an unreadable version", async () => {
    expect(await dockerProblem(env, docker({ compose: "2.23.9" }))).toContain("2.24.0");
    expect(await dockerProblem(env, docker({ compose: "1.29.2" }))).toContain("2.24.0");
    expect(await dockerProblem(env, docker({ compose: "garbage" }))).toContain("Compose");
    expect(await dockerProblem(env, docker({ composeCode: 1 }))).toContain("Compose");
  });

  it("refuses a missing docker", async () => {
    expect(await dockerProblem(env, docker({ missing: true }))).toContain("docker");
  });

  it("refuses DOCKER_HOST=tcp://10.0.0.5:2375 and an ssh context endpoint, and a context that cannot be read", async () => {
    const tcp = docker({});
    expect(await dockerProblem({ ...env, DOCKER_HOST: "tcp://10.0.0.5:2375" }, tcp)).toContain("on this machine");
    expect(tcp.calls).toEqual([]); // refused before anything runs
    expect(await dockerProblem(env, docker({ endpoint: "ssh://user@host" }))).toContain("on this machine");
    expect(await dockerProblem(env, docker({ endpoint: "tcp://127.0.0.1:2375" }))).toContain("on this machine");
    expect(await dockerProblem(env, docker({ contextCode: 1 }))).toContain("context");
    expect(await dockerProblem(env, docker({ contextCode: null }))).toContain("context");
  });

  it("runs docker with PATH, HOME and DOCKER_* only, and its sentences name no value", async () => {
    const d = docker({ compose: "2.23.9" });
    const msg = await dockerProblem({ ...env, DOCKER_CONTEXT: "orbstack", COMPOSE_FILE: "/x" }, d);
    for (const c of d.calls) expect(Object.keys(c.env ?? {}).sort()).toEqual(["DOCKER_CONTEXT", "HOME", "PATH"]);
    for (const v of Object.values(SECRETS)) expect(msg).not.toContain(v);
  });
});

describe("nodeAddress (US-0072, A1c Task 5)", () => {
  const iface = (address: string, internal = false, family: "IPv4" | "IPv6" = "IPv4"): os.NetworkInterfaceInfo =>
    ({ address, family, internal, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null }) as os.NetworkInterfaceInfo;
  const lan = settings(LAN_ENV);

  it("local mode is 127.0.0.1 whatever the interfaces", () => {
    expect(nodeAddress(settings({}), {})).toEqual({ ok: true, ip: "127.0.0.1" });
  });

  it("lan mode with one private non-internal IPv4 address takes it", () => {
    const ifaces = { lo0: [iface("127.0.0.1", true)], en0: [iface("192.168.1.20"), iface("fe80::1", false, "IPv6")], utun0: [iface("8.8.4.4")] };
    expect(nodeAddress(lan, ifaces)).toEqual({ ok: true, ip: "192.168.1.20" });
  });

  it("a set VOICE_NODE_IP must be one of the machine's private addresses", () => {
    const ifaces = { en0: [iface("192.168.1.20")], en1: [iface("10.0.0.7")] };
    expect(nodeAddress(settings({ ...LAN_ENV, VOICE_NODE_IP: "10.0.0.7" }), ifaces)).toEqual({ ok: true, ip: "10.0.0.7" });
    const r = nodeAddress(settings({ ...LAN_ENV, VOICE_NODE_IP: "192.168.9.9" }), ifaces);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("VOICE_NODE_IP");
    expect(!r.ok && r.error).not.toContain("192.168.9.9");
  });

  it("two private addresses without VOICE_NODE_IP are refused, naming the interfaces only", () => {
    const r = nodeAddress(lan, { en0: [iface("192.168.1.20")], en5: [iface("10.0.0.7")] });
    expect(r.ok).toBe(false);
    const msg = !r.ok ? r.error : "";
    expect(msg).toContain("en0");
    expect(msg).toContain("en5");
    expect(msg).toContain("VOICE_NODE_IP");
    expect(msg).not.toContain("192.168.1.20");
    expect(msg).not.toContain("10.0.0.7");
  });

  it("the same address on two interfaces counts once; none is refused", () => {
    expect(nodeAddress(lan, { en0: [iface("192.168.1.20")], bridge0: [iface("192.168.1.20")] })).toEqual({ ok: true, ip: "192.168.1.20" });
    const r = nodeAddress(lan, { lo0: [iface("127.0.0.1", true)], en0: [iface("169.254.3.4")] });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("no private IPv4");
  });
});

describe("the test is private", () => {
  it("uses its own temp directory", () => {
    expect(nodeOs.tmpdir()).toBe(root);
    const f = path.join(newDir(), "x");
    writeFileSync(f, "1");
    chmodSync(f, 0o600);
    expect(existsSync(f)).toBe(true);
  });
});

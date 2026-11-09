import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { privateTmp } from "./helpers/ops-harness.js";

// US-0072 (EPIC-0003 voice A1c, Tasks 7 and 9): the REAL root scripts (`pnpm -s voice:up`, `voice:down`, `voice:check`) run as real
// processes against a PRIVATE copy of the repository skeleton (VOICE_OPS_REPO_ROOT): the root package.json and pnpm-workspace.yaml
// copied byte for byte, the voice-ops sources, its node_modules linked, a placeholder 0600 `.env`. `docker` and `whisper-server` are
// stubs on PATH (fixtures/*-stub.mjs, absolute shebang, configured by stub-config.json); no container, model or real server runs.
// The real worktree's package.json, pnpm-lock.yaml and .env are compared byte for byte before and after (the `update` trap, K13).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(HERE, "..", "..");
const REAL_ROOT = path.resolve(PACKAGE_DIR, "..", "..");

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const f = path.join(dir, name);
    try { if (statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
}
const PNPM = findOnPath("pnpm");

function portTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(true));
    s.listen({ host: "127.0.0.1", port, exclusive: true }, () => s.close(() => resolve(false)));
  });
}

const PLACEHOLDER_TOKEN = "placeholder-launcher-token-0123456789abcdef";
const REAL_FILES = ["package.json", "pnpm-lock.yaml", ".env"].map((f) => path.join(REAL_ROOT, f));
const snapshot = (): (string | null)[] => REAL_FILES.map((f) => (existsSync(f) ? readFileSync(f).toString("base64") : null));

let tmp: ReturnType<typeof privateTmp>;
let skip: string | null = null;
let realBefore: (string | null)[];
beforeAll(async () => {
  tmp = privateTmp("acr-voice-ops-cli-");
  realBefore = snapshot();
  if (PNPM === null) skip = "pnpm is not on PATH";
  else if (await portTaken(7880)) skip = "port 7880 is taken on this machine (the LiveKit stand-in needs it)";
});
afterAll(() => {
  expect(snapshot()).toEqual(realBefore);
  tmp.restore();
});

type Setup = { root: string; bin: string; home: string; stateDir: string; env: NodeJS.ProcessEnv };
let n = 0;
function setup(stub: Record<string, unknown> = {}): Setup {
  const base = path.join(tmp.root, `case-${n++}`);
  const root = path.join(base, "repo");
  const bin = path.join(base, "bin");
  const home = path.join(base, "home");
  const stateDir = path.join(base, "state", "voice");
  for (const d of [root, bin, home]) mkdirSync(d, { recursive: true });
  for (const f of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"]) copyFileSync(path.join(REAL_ROOT, f), path.join(root, f));
  const pkg = path.join(root, "services", "voice-ops");
  mkdirSync(pkg, { recursive: true });
  for (const f of ["package.json", "tsconfig.json"]) copyFileSync(path.join(PACKAGE_DIR, f), path.join(pkg, f));
  cpSync(path.join(PACKAGE_DIR, "src"), path.join(pkg, "src"), { recursive: true, filter: (src) => !src.includes(`${path.sep}__tests__`) });
  symlinkSync(path.join(PACKAGE_DIR, "node_modules"), path.join(pkg, "node_modules"));
  copyFileSync(path.join(REAL_ROOT, "tsconfig.base.json"), path.join(root, "tsconfig.base.json"));
  mkdirSync(path.join(root, "deploy", "compose"), { recursive: true });
  copyFileSync(path.join(REAL_ROOT, "deploy", "compose", "voice.yml"), path.join(root, "deploy", "compose", "voice.yml"));
  const model = path.join(base, "models", "ggml-small.en.bin");
  mkdirSync(path.dirname(model), { recursive: true });
  writeFileSync(model, Buffer.alloc(1_000_001));
  const envFile = path.join(root, ".env");
  writeFileSync(envFile, `LAUNCHER_TOKEN=${PLACEHOLDER_TOKEN}\nVOICE_STATE_DIR=${stateDir}\nSTT_MODEL_FILE=${model}\n`, { mode: 0o600 });
  chmodSync(envFile, 0o600);
  for (const [name, file] of [["whisper-server", "whisper-server-stub.mjs"], ["docker", "docker-stub.mjs"]] as const) {
    const text = readFileSync(path.join(HERE, "fixtures", file), "utf8").split("\n");
    text[0] = `#!${process.execPath}`; // one exec: the comm read right after the spawn is final (D16)
    writeFileSync(path.join(bin, name), text.join("\n"));
    chmodSync(path.join(bin, name), 0o755);
  }
  writeFileSync(path.join(bin, "stub-config.json"), JSON.stringify({ loadingPolls: 1, livekitPort: 7880, ...stub }));
  const env: NodeJS.ProcessEnv = {
    PATH: [bin, path.dirname(PNPM!), path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
    HOME: home, VOICE_OPS_REPO_ROOT: root, TMPDIR: tmp.root,
  };
  return { root, bin, home, stateDir, env };
}

type Result = { code: number | null; signal: NodeJS.Signals | null; out: string };
function runRoot(s: Setup, script: string, o: { detached?: boolean; onSpawn?: (pid: number) => void } = {}): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(PNPM!, ["-s", script], { cwd: s.root, env: s.env, detached: o.detached ?? false, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => { out += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { out += c.toString(); });
    o.onSpawn?.(child.pid!);
    child.on("close", (code, signal) => resolve({ code, signal, out }));
  });
}

const dockerRecord = (s: Setup): { argv?: string[]; event?: string; envNames?: string[] }[] =>
  existsSync(path.join(s.bin, "docker-record.jsonl")) ? readFileSync(path.join(s.bin, "docker-record.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv?: string[] }) : [];
const whisperRecord = (s: Setup): { argv: string[]; pid: number; envNames: string[] } => JSON.parse(readFileSync(path.join(s.bin, "stub-record.json"), "utf8")) as { argv: string[]; pid: number; envNames: string[] };
const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
function secrets(s: Setup): string[] {
  const text = readFileSync(path.join(s.root, ".env"), "utf8");
  const get = (k: string): string => text.split("\n").find((l) => l.startsWith(`${k}=`))!.slice(k.length + 1);
  const p = new URL(get("STT_URL")).pathname;
  return [get("LIVEKIT_API_KEY"), get("LIVEKIT_API_SECRET"), p, p.slice(1), PLACEHOLDER_TOKEN];
}

describe("the root voice scripts as real processes (US-0072, A1c Tasks 7 and 9)", () => {
  it("pnpm -s voice:up then pnpm -s voice:down from the repository root", async (ctx) => {
    if (skip) { ctx.skip(); return; }
    const s = setup();
    const up = await runRoot(s, "voice:up");
    expect(up.out).toContain("voice:up: LiveKit ready (media on 127.0.0.1, TCP 7881, UDP 7882)");
    expect(up.code).toBe(0);
    const text = readFileSync(path.join(s.root, ".env"), "utf8");
    for (const k of ["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "STT_URL"]) expect(text.split("\n").filter((l) => l.startsWith(`${k}=`))).toHaveLength(1);
    expect(statSync(path.join(s.root, ".env")).mode & 0o777).toBe(0o600);
    const [, , requestPath] = secrets(s);
    const w = whisperRecord(s);
    const port = new URL(text.split("\n").find((l) => l.startsWith("STT_URL="))!.slice(8)).port;
    expect(w.argv).toEqual(["--host", "127.0.0.1", "--port", port, "--request-path", requestPath, "-m", path.join(path.dirname(s.root), "models", "ggml-small.en.bin"), "-sns", "--public", path.join(s.stateDir, "public"), "--tmp-dir", path.join(s.stateDir, "tmp")]);
    expect(w.envNames.filter((k) => k !== "__CF_USER_TEXT_ENCODING")).toEqual(["HOME", "PATH"]);
    expect(isAlive(w.pid)).toBe(true);
    const standin = Number(readFileSync(path.join(s.bin, "livekit-standin.pid"), "utf8"));

    const down = await runRoot(s, "voice:down");
    expect(down.code).toBe(0);
    const compose = dockerRecord(s).filter((r) => r.argv?.[0] === "compose" && r.argv[1] === "-p").map((r) => r.argv!);
    expect(compose[0]!.slice(0, 3)).toEqual(["compose", "-p", "scenecoach-voice"]);
    expect(compose[0]!.slice(7)).toEqual(["up", "-d", "--no-build", "--wait", "--wait-timeout", "60", "--quiet-pull"]);
    expect(compose[1]!.slice(7)).toEqual(["--profile", "lan", "down", "--remove-orphans"]);
    for (const r of dockerRecord(s)) for (const k of r.envNames ?? []) expect(k.startsWith("LIVEKIT_") || k === "STT_URL").toBe(false);
    await vi.waitFor(() => { expect(isAlive(w.pid)).toBe(false); expect(isAlive(standin)).toBe(false); }, { timeout: 20_000, interval: 100 });
    expect(existsSync(path.join(s.stateDir, "state.json"))).toBe(false);
    expect(existsSync(path.join(s.stateDir, "livekit.env"))).toBe(false);
    for (const v of secrets(s)) { expect(up.out).not.toContain(v); expect(down.out).not.toContain(v); }
    // the private copy's package.json and lockfile are unchanged too (pnpm ran the script, not `update`)
    for (const f of ["package.json", "pnpm-lock.yaml"]) expect(readFileSync(path.join(s.root, f)).equals(readFileSync(path.join(REAL_ROOT, f)))).toBe(true);
  });

  it("SIGINT through pnpm -s voice:up rolls back (an interrupt during compose up)", async (ctx) => {
    if (skip) { ctx.skip(); return; }
    const s = setup({ holdUp: true });
    let pid = 0;
    const done = runRoot(s, "voice:up", { detached: true, onSpawn: (p) => { pid = p; } });
    await vi.waitFor(() => { expect(dockerRecord(s).some((r) => r.event === "up-holding")).toBe(true); }, { timeout: 60_000, interval: 100 });
    const w = whisperRecord(s);
    expect(isAlive(w.pid)).toBe(true);
    process.kill(-pid, "SIGINT"); // the whole group, as a terminal's Ctrl-C reaches pnpm and the CLI together
    const r = await done;
    expect(r.code === 130 || r.signal === "SIGINT").toBe(true);
    await vi.waitFor(() => { expect(isAlive(w.pid)).toBe(false); }, { timeout: 20_000, interval: 100 });
    expect(existsSync(path.join(s.stateDir, "state.json"))).toBe(false);
    expect(existsSync(path.join(s.stateDir, "livekit.env"))).toBe(false);
    expect(dockerRecord(s).some((x) => x.argv?.includes("down"))).toBe(true);
    expect(r.out).toContain("voice:up: interrupted: rolling back what this run started");
    for (const v of secrets(s)) expect(r.out).not.toContain(v);
  });
  it("pnpm -s voice:check from the repository root with nothing running exits 1 and prints no secret", async (ctx) => {
    if (skip) { ctx.skip(); return; }
    const s = setup();
    const marker = { key: "APImarkerprocess000000000001", secret: "marker-process-secret-0123456789abcdef012345", path: "/markerprocesspath0123456789abcd", dns: "marker-process-dns-token-01" };
    const free = await new Promise<number>((resolve) => { const srv = net.createServer(); srv.listen(0, "127.0.0.1", () => { const p = (srv.address() as net.AddressInfo).port; srv.close(() => resolve(p)); }); });
    const envFile = path.join(s.root, ".env");
    writeFileSync(envFile, readFileSync(envFile, "utf8") + `LIVEKIT_API_KEY=${marker.key}\nLIVEKIT_API_SECRET=${marker.secret}\nSTT_URL=http://127.0.0.1:${free}${marker.path}\nVOICE_DNS_API_TOKEN=${marker.dns}\nVOICE_WEB_PORT=${free}\n`, { mode: 0o600 });
    const before = readFileSync(envFile);
    const r = await runRoot(s, "voice:check");
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL whisper-server does not answer on 127.0.0.1: run pnpm voice:up");
    expect(r.out).toContain("FAIL LiveKit does not answer on 127.0.0.1:7880: run pnpm voice:up");
    expect(r.out).toMatch(/voice:check: \d+ ok, \d+ warn, \d+ fail, \d+ skip/);
    for (const v of [...Object.values(marker), marker.path.slice(1), PLACEHOLDER_TOKEN]) expect(r.out).not.toContain(v);
    expect(readFileSync(envFile).equals(before)).toBe(true);
    expect(existsSync(s.stateDir)).toBe(false);
  });
});

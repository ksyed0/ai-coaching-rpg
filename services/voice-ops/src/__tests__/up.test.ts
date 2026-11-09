import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOCK_FILE, readState } from "../state.js";
import { tlsRouteAnswers } from "../tls-route.js";
import { voiceDown } from "../down.js";
import { voiceUp } from "../up.js";
import { makeWorld, privateTmp, secretsOf, type World } from "./helpers/ops-harness.js";

// US-0072 (EPIC-0003 voice A1c, Task 7): `voice:up` orchestration with every seam faked (ops-harness.ts): the step order, the refusals
// before anything is generated, repair mode, "already running", rollback on failure and on interrupt, the lock, stale temp files, and
// the secret scan of every output line, argument list and child environment.

let tmp: ReturnType<typeof privateTmp>;
beforeAll(() => { tmp = privateTmp("acr-voice-ops-up-"); });
afterAll(() => tmp.restore());
const world = (o: Parameters<typeof makeWorld>[1] = {}): World => makeWorld(tmp.root, o);

const composeHead = (w: World): string[] => ["compose", "-p", "scenecoach-voice", "-f", path.join(w.repoRoot, "deploy/compose/voice.yml"), "--env-file", expect.any(String) as unknown as string];

describe("voiceUp refusals before anything is generated", () => {
  it("refuses without the model file before generating anything", async () => {
    const w = world();
    writeFileSync(w.modelFile, "x");
    const before = w.envBytes();
    expect(await voiceUp(w.deps())).toBe(1);
    expect(w.envBytes().equals(before)).toBe(true);
    expect(w.dockerCalls()).toEqual([]);
    expect(w.spawns).toEqual([]);
    expect(existsSync(w.statePath)).toBe(false);
    expect(w.out.join("\n")).toContain("No speech model at STT_MODEL_FILE");
  });

  it.each([
    ["a missing docker", (w: World) => { w.dockerMissing = true; }, "docker was not found"],
    ["an old Compose", (w: World) => { w.composeVersion = "2.23.9"; }, "older than 2.24.0"],
    ["a remote Docker endpoint", (w: World) => { w.contextHost = "tcp://10.0.0.5:2376"; }, "not a local socket"],
    ["a remote DOCKER_HOST", (w: World) => { w.realEnv.DOCKER_HOST = "tcp://10.0.0.5:2376"; }, "DOCKER_HOST must be unset"],
  ])("%s is refused before .env is touched", async (_n, set, said) => {
    const w = world();
    set(w);
    const before = w.envBytes();
    expect(await voiceUp(w.deps())).toBe(1);
    expect(w.envBytes().equals(before)).toBe(true);
    expect(w.spawns).toEqual([]);
    expect(w.out.join("\n")).toContain(said);
  });

  it("lan without certificate files is refused before .env is touched", async () => {
    const w = world({ lan: true });
    const { rmSync } = await import("node:fs");
    rmSync(w.certFile);
    const before = w.envBytes();
    expect(await voiceUp(w.deps())).toBe(1);
    expect(w.envBytes().equals(before)).toBe(true);
    expect(w.out.join("\n")).toContain("VOICE_TLS_CERT_FILE cannot be read");
    expect(w.dockerCalls().some((a) => a.includes("up"))).toBe(false);
  });

  it("a group-readable key file is refused", async () => {
    const w = world({ lan: true });
    chmodSync(w.keyFile, 0o640);
    const before = w.envBytes();
    expect(await voiceUp(w.deps())).toBe(1);
    expect(w.envBytes().equals(before)).toBe(true);
    expect(w.out.join("\n")).toContain("VOICE_TLS_KEY_FILE is readable by other users");
  });

  it("dns mode is refused with the runbook sentence", async () => {
    const w = world({ lan: true, envLines: ["VOICE_TLS_MODE=dns", "VOICE_DNS_PROVIDER=cloudflare"] });
    const before = w.envBytes();
    expect(await voiceUp(w.deps())).toBe(1);
    expect(w.envBytes().equals(before)).toBe(true);
    expect(w.out.join("\n")).toContain("docs/VOICE_RUNBOOK.md");
    expect(w.calls).toEqual([]);
  });

  it("the real environment setting a managed name is refused, naming the variable only", async () => {
    const w = world();
    w.realEnv.LIVEKIT_API_KEY = "APIexportedplaceholder0001";
    const before = w.envBytes();
    expect(await voiceUp(w.deps())).toBe(1);
    expect(w.envBytes().equals(before)).toBe(true);
    expect(w.out).toEqual(["voice:up: unset LIVEKIT_API_KEY in this shell: voice:up and control must read it from .env"]);
    expect(w.calls).toEqual([]);
    expect(w.spawns).toEqual([]);
  });

  it("LIVEKIT_HOST other than 127.0.0.1:7880 is refused", async () => {
    const w = world({ envLines: ["LIVEKIT_HOST=http://127.0.0.1:7999"] });
    expect(await voiceUp(w.deps())).toBe(2);
    expect(w.out.join("\n")).toContain("LIVEKIT_HOST must be http://127.0.0.1:7880");
    expect(w.calls).toEqual([]);
  });

  it("bad settings give exit 2 and name the variable", async () => {
    const w = world({ envLines: ["VOICE_ACCESS=everywhere"] });
    expect(await voiceUp(w.deps())).toBe(2);
    expect(w.out).toEqual(["voice:up: VOICE_ACCESS must be local or lan"]);
  });

  it("a tracked .env is refused", async () => {
    const w = world();
    w.git = () => ({ code: 0, stdout: ".env\0", stderr: "" });
    const before = w.envBytes();
    expect(await voiceUp(w.deps())).toBe(1);
    expect(w.envBytes().equals(before)).toBe(true);
    expect(w.out.join("\n")).toContain("git rm --cached .env");
    expect(w.dockerCalls()).toEqual([]);
  });

  it("git missing skips the tracked check", async () => {
    const w = world();
    w.git = () => { throw new Error("could not run git (ENOENT)"); };
    expect(await voiceUp(w.deps())).toBe(0);
  });

  it("a missing .env is refused with the run.sh sentence", async () => {
    const w = world();
    const { rmSync } = await import("node:fs");
    // the settings come from the real environment then
    w.realEnv.VOICE_STATE_DIR = w.stateDir;
    w.realEnv.STT_MODEL_FILE = w.modelFile;
    rmSync(w.envFile);
    expect(await voiceUp(w.deps())).toBe(1);
    expect(w.out.join("\n")).toContain("run ./run.sh once first");
    expect(existsSync(w.envFile)).toBe(false);
  });

  it("a taken port is refused with the port named and nothing started", async () => {
    const w = world();
    w.ports.set("127.0.0.1:7880/tcp", "taken");
    expect(await voiceUp(w.deps())).toBe(1);
    expect(w.out.join("\n")).toContain("port 7880 (LiveKit API) is taken");
    expect(w.spawns).toEqual([]);
    expect(w.composeVerbs()).toEqual([]);
    expect(existsSync(w.statePath)).toBe(false);
  });

  it("a taken STT port says how to pick a new one", async () => {
    const w = world();
    w.ports.set("127.0.0.1:23456/tcp", "taken");
    expect(await voiceUp(w.deps())).toBe(1);
    expect(w.out.join("\n")).toContain("remove STT_URL from .env to pick a new one");
  });

  it("a denied port probe continues with the privileges sentence", async () => {
    const w = world({ lan: true });
    w.ports.set("192.168.1.20:443/tcp", "denied");
    expect(await voiceUp(w.deps())).toBe(0);
    expect(w.out).toContain("voice:up: cannot test port 443 without privileges; Docker reports it if it is taken");
  });
});

describe("voiceUp fresh start", () => {
  it("a fresh up generates the secrets, starts whisper-server, then compose, and prints the next steps", async () => {
    const w = world();
    const states: string[] = [];
    w.onStep = (step) => { const s = readState(w.stateDir); states.push(`${step}:${s ? Object.keys(s).filter((k) => k === "whisper" || k === "compose").join("+") || "base" : "none"}`); };
    expect(await voiceUp(w.deps())).toBe(0);
    // the order: git (tracked), docker version and context, git again (the writer), whisper spawn, compose up
    const order = w.calls.map((c) => (c.cmd === "docker" ? `docker ${c.args.includes("up") ? "up" : c.args[0] === "context" ? "context" : "version"}` : c.cmd));
    expect(order.filter((x) => x !== "ps")).toEqual(["git", "docker version", "docker context", "git", "docker up"]);
    expect(states[0]).toBe("spawn:base");
    expect(states).toContain("compose-up:whisper+compose");
    const sec = secretsOf(w.envText());
    // whisper-server gets the STT_URL written in this run (the merged view is re-read after ensureVoiceSecrets)
    expect(w.spawns[0]!.args).toContain(sec.requestPath);
    expect(w.spawns[0]!.args.slice(0, 4)).toEqual(["--host", "127.0.0.1", "--port", "23456"]);
    const up = w.dockerCalls().find((a) => a.includes("up"))!;
    expect(up).toEqual([...composeHead(w), "up", "-d", "--no-build", "--wait", "--wait-timeout", "60", "--quiet-pull"]);
    expect(w.calls.find((c) => c.args.includes("up"))!.timeoutMs).toBe(600_000);
    expect(readFileSync(path.join(w.stateDir, "livekit.env"), "utf8")).toBe(`LIVEKIT_KEYS=${sec.key}: ${sec.secret}\n`);
    const st = readState(w.stateDir)!;
    expect(st).toMatchObject({ access: "local", nodeIp: "127.0.0.1", ports: { stt: 23456, livekit: 7880, tcp: 7881, udp: 7882 }, profiles: [], compose: { project: "scenecoach-voice", profiles: [] } });
    expect(st.whisper).toMatchObject({ port: 23456, comm: "whisper-server" });
    expect(w.out).toEqual([
      "voice:up: added to .env: LIVEKIT_API_KEY, LIVEKIT_API_SECRET, STT_URL",
      "voice:up: whisper-server ready on 127.0.0.1 (model small.en)",
      "voice:up: starting LiveKit with Docker Compose (the first start pulls a digest-pinned image; this can take a few minutes)",
      "voice:up: LiveKit ready (media on 127.0.0.1, TCP 7881, UDP 7882)",
      "voice:up: next: set SPEECH_INGEST=livekit in .env for the control service",
      "voice:up: next: start the web app with PUBLIC_ORIGIN=http://localhost:3000 and LIVEKIT_URL=ws://127.0.0.1:7880 (pnpm --filter @acr/web start)",
      "voice:up: Voice stays off until VOICE_ENABLED=1 and CONSENT_NOTICE_VERSION=v3 (pre-production only; docs/VOICE_RUNBOOK.md)",
      "voice:up: local mode serves only this machine; the two-person room test needs lan mode",
    ]);
    expect(existsSync(path.join(w.stateDir, LOCK_FILE))).toBe(false);
  });

  it("never sets VOICE_ENABLED, CONSENT_NOTICE_VERSION or SPEECH_INGEST in .env", async () => {
    const w = world();
    expect(await voiceUp(w.deps())).toBe(0);
    for (const n of ["VOICE_ENABLED", "CONSENT_NOTICE_VERSION", "SPEECH_INGEST"]) expect(w.envText()).not.toContain(`${n}=`);
  });

  it("a second voice:up after the first wrote .env is not refused with env_override (ensureVoiceSecrets gets the real environment)", async () => {
    const w = world();
    expect(await voiceUp(w.deps())).toBe(0);
    const env1 = w.envText();
    // a new world state: everything stopped, then up again
    w.procs.clear();
    w.composeIsUp = false;
    const { rmSync } = await import("node:fs");
    rmSync(w.statePath);
    w.out.length = 0;
    expect(await voiceUp(w.deps())).toBe(0);
    expect(w.out.join("\n")).not.toContain("unset ");
    expect(w.envText()).toBe(env1);
  });

  it("lan: proxy ready is printed only after the TLS route answers, caddy folders are made 0700 first", async () => {
    const w = world({ lan: true });
    let routeAsked = -1;
    w.tls = () => { routeAsked = w.out.length; expect(lstatSync(path.join(w.stateDir, "caddy-data")).mode & 0o777).toBe(0o700); return { authorized: true, status: 404 }; };
    expect(await voiceUp(w.deps())).toBe(0);
    const ready = w.out.indexOf("voice:up: proxy ready for https://voice.pilot.example");
    expect(ready).toBeGreaterThanOrEqual(routeAsked);
    expect(routeAsked).toBeGreaterThan(0);
    expect(w.tlsAsked).toEqual([{ host: "192.168.1.20", port: 7443, servername: "voice.pilot.example" }]);
    expect(lstatSync(path.join(w.stateDir, "caddy-config")).mode & 0o777).toBe(0o700);
    const up = w.dockerCalls().find((a) => a.includes("up"))!;
    expect(up.slice(7, 9)).toEqual(["--profile", "lan"]);
    expect(w.out).toContain("voice:up: next: start the web app with PUBLIC_ORIGIN=https://voice.pilot.example and LIVEKIT_URL=wss://voice.pilot.example:7443 (pnpm --filter @acr/web start)");
    expect(readState(w.stateDir)).toMatchObject({ access: "lan", nodeIp: "192.168.1.20", profiles: ["lan"], ports: { https: 443, livekitTls: 7443 } });
  });

  it("a TLS route that never answers rolls back", async () => {
    const w = world({ lan: true });
    w.tls = () => ({ authorized: false, status: null });
    expect(await voiceUp(w.deps())).toBe(1);
    expect(w.out.join("\n")).not.toContain("proxy ready");
    expect(w.composeVerbs()).toEqual(["up", "down"]);
    expect(w.procs.size).toBe(0);
    expect(existsSync(w.statePath)).toBe(false);
  });
});

describe("voiceUp rollback", () => {
  it("compose failure stops whisper-server and clears the state", async () => {
    const w = world();
    w.composeUp = () => ({ code: 1, stdout: "", stderr: "" });
    expect(await voiceUp(w.deps())).toBe(1);
    expect(w.procs.size).toBe(0);
    expect(existsSync(w.statePath)).toBe(false);
    expect(existsSync(path.join(w.stateDir, "livekit.env"))).toBe(false);
    expect(w.out.join("\n")).toContain("docker compose up failed");
  });

  it("compose up exiting non-zero after --wait rolls back in order: compose down (after dockerProblem), whisper, livekit.env, state", async () => {
    const w = world();
    const events: string[] = [];
    w.composeUp = () => ({ code: 1, stdout: "", stderr: "container exited" });
    w.composeDown = () => { events.push(`down whisper=${w.procs.size} livekitEnv=${existsSync(path.join(w.stateDir, "livekit.env"))} state=${existsSync(w.statePath)}`); return { code: 0, stdout: "", stderr: "" }; };
    expect(await voiceUp(w.deps())).toBe(1);
    expect(events).toEqual(["down whisper=1 livekitEnv=true state=true"]);
    const docker = w.dockerCalls().map((a) => (a.includes("down") ? "down" : a.includes("up") ? "up" : a[0] === "context" ? "context" : "version"));
    expect(docker).toEqual(["version", "context", "up", "version", "context", "down"]);
    expect(w.signals.map((s) => s.sig)).toEqual(["SIGTERM"]);
    expect(existsSync(w.statePath)).toBe(false);
  });

  it("LiveKit never answering rolls back both", async () => {
    const w = world();
    w.livekit = () => false;
    expect(await voiceUp(w.deps())).toBe(1);
    expect(w.composeVerbs()).toEqual(["up", "down"]);
    expect(w.procs.size).toBe(0);
    expect(existsSync(w.statePath)).toBe(false);
    expect(w.out.join("\n")).toContain("LiveKit did not answer");
  });

  it("SIGINT during the health wait rolls back (no compose started)", async () => {
    const w = world();
    let polls = 0;
    w.health = () => { polls += 1; if (polls === 2) w.interrupt!(); return "loading"; };
    expect(await voiceUp(w.deps())).toBe(1);
    expect(w.procs.size).toBe(0);
    expect(w.composeVerbs()).toEqual([]);
    expect(existsSync(w.statePath)).toBe(false);
    expect(existsSync(path.join(w.stateDir, "livekit.env"))).toBe(false);
    expect(w.out.join("\n")).toContain("interrupted");
  });

  it("an interrupt during compose up waits for it, then rolls back once; a second interrupt does not re-enter the rollback", async () => {
    const w = world();
    w.onStep = (step) => { if (step === "compose-up") { w.interrupt!(); w.interrupt?.(); } if (step === "compose-down") w.interrupt?.(); };
    expect(await voiceUp(w.deps())).toBe(1);
    expect(w.composeVerbs()).toEqual(["up", "down"]);
    expect(w.signals.filter((s) => s.sig === "SIGTERM")).toHaveLength(1);
    expect(existsSync(w.statePath)).toBe(false);
  });

  it("a whisper-server that cannot be stopped keeps its record in the state (not_stopped)", async () => {
    const w = world();
    w.composeUp = () => ({ code: 1, stdout: "", stderr: "" });
    w.onStep = (step) => { if (step === "compose-up") for (const pid of w.procs.keys()) w.eperm.add(pid); };
    expect(await voiceUp(w.deps())).toBe(1);
    const st = readState(w.stateDir);
    expect(st?.whisper).toBeDefined();
    expect(st?.compose).toBeUndefined();
    expect(w.out.join("\n")).toContain("could not be stopped");
  });

  it("a whisper-server that never gets ready and cannot be stopped keeps its record (startWhisper not_stopped)", async () => {
    const w = world();
    w.health = () => { for (const pid of w.procs.keys()) w.eperm.add(pid); return "loading"; };
    expect(await voiceUp(w.deps())).toBe(1);
    expect(readState(w.stateDir)?.whisper).toBeDefined();
    expect(w.composeVerbs()).toEqual([]);
    expect(w.out.join("\n")).toContain("the process could not be stopped");
  });

  it("a whisper-server that exits while starting clears its record and leaves nothing", async () => {
    const w = world();
    w.health = () => { w.procs.clear(); return "down"; };
    expect(await voiceUp(w.deps())).toBe(1);
    expect(existsSync(w.statePath)).toBe(false);
    expect(w.composeVerbs()).toEqual([]);
  });
});

describe("voiceUp existing state", () => {
  it("up twice: the second says already running and starts nothing", async () => {
    const w = world();
    expect(await voiceUp(w.deps())).toBe(0);
    const n = w.calls.length;
    w.out.length = 0;
    expect(await voiceUp(w.deps())).toBe(0);
    expect(w.out).toEqual(["voice:up: already running"]);
    expect(w.calls.slice(n).every((c) => c.cmd === "ps")).toBe(true);
    expect(w.spawns).toHaveLength(1);
  });

  it("a changed node address is refused while running (nothing stopped)", async () => {
    const w = world({ lan: true });
    expect(await voiceUp(w.deps())).toBe(0);
    w.ifaces = { en0: [{ address: "192.168.1.77", family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: "192.168.1.77/24" }] };
    w.out.length = 0;
    const n = w.calls.length;
    expect(await voiceUp(w.deps())).toBe(1);
    expect(w.out).toEqual(["voice:up: settings changed: run pnpm voice:down first"]);
    expect(w.calls.slice(n).filter((c) => c.cmd !== "ps")).toEqual([]);
    expect(w.procs.size).toBe(1);
    expect(w.composeIsUp).toBe(true);
  });

  it("repair: a dead whisper-server is started again and compose is not taken down", async () => {
    const w = world();
    expect(await voiceUp(w.deps())).toBe(0);
    w.procs.clear();
    w.out.length = 0;
    expect(await voiceUp(w.deps())).toBe(0);
    expect(w.spawns).toHaveLength(2);
    expect(w.composeVerbs()).toEqual(["up", "up"]);
    expect(w.out[0]).toBe("voice:up: repairing: starting what is not running");
    expect(readState(w.stateDir)!.whisper!.pid).toBe(w.spawns.length + 3999);
  });

  it("repair: a missing LiveKit is started again without stopping a healthy whisper-server", async () => {
    const w = world();
    expect(await voiceUp(w.deps())).toBe(0);
    w.composeIsUp = false;
    expect(await voiceUp(w.deps())).toBe(0);
    expect(w.spawns).toHaveLength(1);
    expect(w.signals).toEqual([]);
    expect(w.composeVerbs()).toEqual(["up", "up"]);
  });

  it("repair failure rolls back only what this run started and never runs compose down", async () => {
    const w = world();
    expect(await voiceUp(w.deps())).toBe(0);
    w.procs.clear();
    w.composeUp = () => ({ code: 1, stdout: "", stderr: "" });
    expect(await voiceUp(w.deps())).toBe(1);
    expect(w.composeVerbs()).toEqual(["up", "up"]);
    const st = readState(w.stateDir)!;
    expect(st.whisper).toBeUndefined();
    expect(st.compose).toBeDefined();
    expect(existsSync(path.join(w.stateDir, "livekit.env"))).toBe(true);
  });

  it("an unreadable state is refused with the voice:down sentence", async () => {
    const w = world();
    mkdirSync(w.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(w.stateDir), 0o700);
    writeFileSync(w.statePath, "{not json", { mode: 0o600 });
    expect(await voiceUp(w.deps())).toBe(1);
    expect(w.out).toEqual(["voice:up: the voice state is unreadable: run pnpm voice:down, then pnpm voice:up"]);
  });
});

// Review B2 F1: a refusal or an interrupt BEFORE this run touched anything must leave the running stack's state as it is (the plan:
// "settings changed ... (nothing is stopped)"; the rollback runs only after this run's first start), so voice:down can still stop it.
describe("voiceUp leaves the state alone when it starts nothing (review B2 F1)", () => {
  const lanIfaces = (address: string): World["ifaces"] => ({ en0: [{ address, family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: `${address}/24` }] });

  it("settings changed: state.json stays byte-identical, and voice:down then stops the whisper-server it names", async () => {
    const w = world({ lan: true });
    expect(await voiceUp(w.deps())).toBe(0);
    const before = readFileSync(w.statePath);
    const livekitEnv = readFileSync(path.join(w.stateDir, "livekit.env"));
    const pid = readState(w.stateDir)!.whisper!.pid;
    w.ifaces = lanIfaces("192.168.1.77");
    w.out.length = 0;
    expect(await voiceUp(w.deps())).toBe(1);
    expect(w.out).toEqual(["voice:up: settings changed: run pnpm voice:down first"]);
    expect(readFileSync(w.statePath).equals(before)).toBe(true);
    expect(readFileSync(path.join(w.stateDir, "livekit.env")).equals(livekitEnv)).toBe(true);
    expect(w.composeVerbs()).toEqual(["up"]);
    w.out.length = 0;
    expect(await voiceDown(w.deps())).toBe(0);
    expect(w.procs.has(pid)).toBe(false);
    expect(w.out).toContain("voice:down: whisper-server stopped");
  });

  it("an unreadable state stays byte-identical", async () => {
    const w = world();
    mkdirSync(w.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(w.stateDir), 0o700);
    writeFileSync(w.statePath, "{not json", { mode: 0o600 });
    expect(await voiceUp(w.deps())).toBe(1);
    expect(readFileSync(w.statePath, "utf8")).toBe("{not json");
  });

  it("an interrupt during the already-running probe leaves state.json byte-identical and the whisper record intact", async () => {
    const w = world();
    expect(await voiceUp(w.deps())).toBe(0);
    const before = readFileSync(w.statePath);
    const pid = readState(w.stateDir)!.whisper!.pid;
    w.onStep = (s) => { if (s === "answers" && w.interrupt) w.interrupt(); };
    w.out.length = 0;
    expect(await voiceUp(w.deps())).toBe(1);
    expect(readFileSync(w.statePath).equals(before)).toBe(true);
    expect(w.procs.has(pid)).toBe(true);
    expect(w.composeVerbs()).toEqual(["up"]);
    expect(w.signals).toEqual([]);
  });

  it("a repair-mode refusal before any start (the model file is gone) leaves state.json byte-identical", async () => {
    const w = world();
    expect(await voiceUp(w.deps())).toBe(0);
    w.procs.clear(); // whisper-server died: repair would start it, but the model file is gone
    writeFileSync(w.modelFile, "x");
    const before = readFileSync(w.statePath);
    expect(await voiceUp(w.deps())).toBe(1);
    expect(w.out.join("\n")).toContain("No speech model at STT_MODEL_FILE");
    expect(readFileSync(w.statePath).equals(before)).toBe(true);
  });

  // Review B2 F4: a ps failure while checking the recorded whisper-server is a refusal, not "not ours" (which would start a second one).
  it("a ps failure during the existing-state check is refused, nothing is started and state.json stays byte-identical", async () => {
    const w = world();
    expect(await voiceUp(w.deps())).toBe(0);
    const before = readFileSync(w.statePath);
    w.psFails = true;
    w.out.length = 0;
    expect(await voiceUp(w.deps())).toBe(1);
    expect(w.out).toEqual(["voice:up: could not identify the recorded whisper-server: run pnpm voice:up again"]);
    expect(w.spawns).toHaveLength(1);
    expect(readFileSync(w.statePath).equals(before)).toBe(true);
  });

  it("a fresh start that fails after its first start still rolls back everything", async () => {
    const w = world();
    w.livekit = () => false;
    expect(await voiceUp(w.deps())).toBe(1);
    expect(w.procs.size).toBe(0);
    expect(w.composeVerbs()).toEqual(["up", "down"]);
    for (const f of ["state.json", "livekit.env"]) expect(existsSync(path.join(w.stateDir, f))).toBe(false);
  });
});

describe("voiceUp lock and leftovers", () => {
  it("a second concurrent run is refused by the lock, and the busy sentence names how to remove it", async () => {
    const w = world();
    mkdirSync(w.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(w.stateDir), 0o700);
    writeFileSync(path.join(w.stateDir, LOCK_FILE), `${process.ppid}\n`, { mode: 0o600 });
    w.procs.set(process.ppid, { comm: "node", startedAt: 0, args: [] });
    expect(await voiceUp(w.deps())).toBe(1);
    expect(w.out).toEqual(["voice:up: another voice:up or voice:down is running; if no voice:up or voice:down is running, remove the file lock in VOICE_STATE_DIR"]);
    expect(w.spawns).toEqual([]);
  });

  it("a lock left by a dead pid is taken over", async () => {
    const w = world();
    mkdirSync(w.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(w.stateDir), 0o700);
    writeFileSync(path.join(w.stateDir, LOCK_FILE), "999999\n", { mode: 0o600 });
    expect(await voiceUp(w.deps())).toBe(0);
    expect(existsSync(path.join(w.stateDir, LOCK_FILE))).toBe(false);
  });

  it("stale temp files are removed at start: regular files of this user only, a symlink or a folder is left alone and named by pattern", async () => {
    const w = world();
    mkdirSync(w.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(w.stateDir), 0o700);
    const stale = [
      path.join(w.repoRoot, ".env.voice-ops.0123456789ab.tmp"),
      path.join(w.stateDir, ".livekit.env.0123456789ab.tmp"),
      path.join(w.stateDir, ".state.json.0123456789ab.tmp"),
      path.join(w.stateDir, ".lock.0123456789ab.tmp"),
    ];
    for (const f of stale) writeFileSync(f, "LIVEKIT_API_SECRET=leftover-placeholder\n", { mode: 0o600 });
    const target = path.join(w.dir, "victim");
    writeFileSync(target, "keep me\n");
    symlinkSync(target, path.join(w.repoRoot, ".env.voice-ops.aaaaaaaaaaaa.tmp"));
    mkdirSync(path.join(w.stateDir, ".state.json.bbbbbbbbbbbb.tmp"));
    const unrelated = path.join(w.repoRoot, ".env.voice-ops.short.tmp");
    writeFileSync(unrelated, "x");
    expect(await voiceUp(w.deps())).toBe(0);
    for (const f of stale) expect(existsSync(f)).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("keep me\n");
    expect(lstatSync(path.join(w.repoRoot, ".env.voice-ops.aaaaaaaaaaaa.tmp")).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(w.stateDir, ".state.json.bbbbbbbbbbbb.tmp"))).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    const said = w.out.join("\n");
    expect(said).toContain("removed a leftover temporary file (.env.voice-ops.*.tmp)");
    expect(said).toContain("left alone a leftover .env.voice-ops.*.tmp that is not a regular file of yours");
    expect(said).not.toContain(w.repoRoot);
  });
});

describe("voiceUp never shows a secret", () => {
  it("no output line, no argument list except whisperArgs, and no child environment contains a secret", async () => {
    for (const lan of [false, true]) {
      const w = world({ lan });
      w.composeUp = () => ({ code: 1, stdout: "", stderr: "" }); // a failure path too
      expect(await voiceUp(w.deps())).toBe(1);
      w.composeUp = () => ({ code: 0, stdout: "", stderr: "" });
      expect(await voiceUp(w.deps())).toBe(0);
      const sec = secretsOf(w.envText());
      const values = [sec.key, sec.secret, sec.requestPath, sec.requestPath.slice(1)];
      const haystacks = [
        ...w.out,
        ...w.calls.flatMap((c) => [...c.args, ...Object.values(c.env ?? {}).map(String)]),
        ...w.spawns.flatMap((s) => Object.values(s.env).map(String)),
        readFileSync(w.statePath, "utf8"),
      ];
      for (const v of values) for (const h of haystacks) expect(h.includes(v)).toBe(false);
      for (const c of w.calls) expect(c.env, `${c.cmd} without an explicit environment`).toBeDefined();
      for (const s of w.spawns) expect(s.args).toContain(sec.requestPath);
      for (const s of w.spawns) expect(Object.keys(s.env).sort()).toEqual(["HOME", "PATH"]);
    }
  });
});

describe("tlsRouteAnswers", () => {
  it("is true only for a trusted handshake with an HTTP answer, and never throws", async () => {
    const at = { hostname: "voice.pilot.example", port: 7443 };
    expect(await tlsRouteAnswers({ ...at, connect: async () => ({ authorized: true, status: 404 }) })).toBe(true);
    expect(await tlsRouteAnswers({ ...at, connect: async () => ({ authorized: false, status: 200 }) })).toBe(false);
    expect(await tlsRouteAnswers({ ...at, connect: async () => ({ authorized: true, status: null }) })).toBe(false);
    expect(await tlsRouteAnswers({ ...at, connect: async () => { throw new Error("ECONNREFUSED"); } })).toBe(false);
    const asked: string[] = [];
    await tlsRouteAnswers({ ...at, address: "192.168.1.20", connect: async (h, p, sn) => { asked.push(`${h}:${p}:${sn}`); return { authorized: true, status: 200 }; } });
    expect(asked).toEqual(["192.168.1.20:7443:voice.pilot.example"]);
  });
});

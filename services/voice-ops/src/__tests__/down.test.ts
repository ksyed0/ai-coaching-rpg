import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { voiceDown } from "../down.js";
import { LOCK_FILE, readState, writeState } from "../state.js";
import { voiceUp } from "../up.js";
import { makeWorld, privateTmp, type World } from "./helpers/ops-harness.js";

// US-0072 (EPIC-0003 voice A1c, Task 7): `voice:down` with every seam faked: what it stops, what it leaves alone (a reused pid), what it
// removes, and that every compose call is preceded by the Docker check.

let tmp: ReturnType<typeof privateTmp>;
beforeAll(() => { tmp = privateTmp("acr-voice-ops-down-"); });
afterAll(() => tmp.restore());
const world = (o: Parameters<typeof makeWorld>[1] = {}): World => makeWorld(tmp.root, o);

async function upped(o: Parameters<typeof makeWorld>[1] = {}): Promise<World> {
  const w = world(o);
  expect(await voiceUp(w.deps())).toBe(0);
  w.out.length = 0;
  w.calls.length = 0;
  return w;
}

describe("voiceDown", () => {
  it("down stops compose and whisper-server and clears the state", async () => {
    const w = await upped({ lan: true });
    const pid = readState(w.stateDir)!.whisper!.pid;
    expect(await voiceDown(w.deps())).toBe(0);
    expect(w.composeVerbs()).toEqual(["down"]);
    const down = w.dockerCalls().find((a) => a.includes("down"))!;
    expect(down.slice(7)).toEqual(["--profile", "lan", "down", "--remove-orphans"]);
    // the Docker check right before the compose call
    expect(w.dockerCalls().map((a) => (a.includes("down") ? "down" : a[0] === "context" ? "context" : "version"))).toEqual(["version", "context", "down"]);
    expect(w.procs.has(pid)).toBe(false);
    for (const f of ["state.json", "livekit.env", "whisper.log", "public", "tmp", LOCK_FILE]) expect(existsSync(path.join(w.stateDir, f))).toBe(false);
    expect(w.out).toEqual(["voice:down: LiveKit and the proxy stopped", "voice:down: whisper-server stopped", "voice:down: done"]);
  });

  it("down leaves a foreign process alone (a pid now owned by another program: reported, not signalled)", async () => {
    const w = await upped();
    const pid = readState(w.stateDir)!.whisper!.pid;
    w.procs.set(pid, { comm: "Safari", startedAt: w.clock + 3_600_000, args: ["Safari"] });
    expect(await voiceDown(w.deps())).toBe(0);
    expect(w.signals).toEqual([]);
    expect(w.procs.has(pid)).toBe(true);
    expect(w.out).toContain("voice:down: the recorded whisper-server is gone and its process id now belongs to another program: left alone");
    expect(existsSync(w.statePath)).toBe(false);
  });

  it("down with nothing running exits 0 (and with no state folder at all creates nothing)", async () => {
    const w = world();
    expect(await voiceDown(w.deps())).toBe(0);
    expect(existsSync(w.stateDir)).toBe(false);
    expect(w.out).toEqual(["voice:down: nothing to stop"]);
    mkdirSync(w.stateDir, { recursive: true, mode: 0o700 });
    w.out.length = 0;
    expect(await voiceDown(w.deps())).toBe(0);
    expect(w.composeVerbs()).toEqual(["down"]);
  });

  it("down after a crash that removed livekit.env still runs compose down", async () => {
    const w = await upped();
    rmSync(path.join(w.stateDir, "livekit.env"));
    expect(await voiceDown(w.deps())).toBe(0);
    expect(w.composeVerbs()).toEqual(["down"]);
    expect(existsSync(w.statePath)).toBe(false);
  });

  it("a Docker problem skips compose down with the sentence and keeps the compose record (exit 1); whisper-server is still stopped", async () => {
    const w = await upped();
    w.realEnv.DOCKER_HOST = "tcp://10.0.0.5:2376";
    expect(await voiceDown(w.deps())).toBe(1);
    expect(w.composeVerbs()).toEqual([]);
    expect(w.out.join("\n")).toContain("DOCKER_HOST must be unset");
    const st = readState(w.stateDir)!;
    expect(st.compose).toBeDefined();
    expect(st.whisper).toBeUndefined();
    expect(w.procs.size).toBe(0);
  });

  it("a failing compose down keeps the state for a later voice:down (exit 1)", async () => {
    const w = await upped();
    w.composeDown = () => ({ code: 1, stdout: "", stderr: "" });
    expect(await voiceDown(w.deps())).toBe(1);
    expect(readState(w.stateDir)?.compose).toBeDefined();
    expect(w.out.join("\n")).toContain("docker compose down failed");
  });

  it("a settings error still uses the default state folder", async () => {
    const w = await upped();
    // the settings now fail, but VOICE_STATE_DIR is still the one in .env... use the default under HOME instead
    const def = path.join(w.home, ".scenecoach", "voice");
    mkdirSync(def, { recursive: true, mode: 0o700 });
    for (const p of [path.join(w.home, ".scenecoach"), def]) (await import("node:fs")).chmodSync(p, 0o700);
    writeState(def, { v: 1, access: "local", nodeIp: "127.0.0.1", ports: { stt: 23456, livekit: 7880, tcp: 7881, udp: 7882 }, profiles: [], compose: { project: "scenecoach-voice", profiles: [] } });
    writeFileSync(w.envFile, "VOICE_ACCESS=everywhere\n", { mode: 0o600 });
    expect(await voiceDown(w.deps())).toBe(0);
    expect(w.out[0]).toBe("voice:down: VOICE_ACCESS must be local or lan");
    expect(w.out).toContain("voice:down: settings have errors: using the default VOICE_STATE_DIR");
    expect(existsSync(path.join(def, "state.json"))).toBe(false);
  });

  it("an unreadable state: compose down runs, whisper-server is left and the sentence says so (exit 1)", async () => {
    const w = await upped();
    writeFileSync(w.statePath, "{broken", { mode: 0o600 });
    expect(await voiceDown(w.deps())).toBe(1);
    expect(w.composeVerbs()).toEqual(["down"]);
    expect(w.signals).toEqual([]);
    expect(w.out.join("\n")).toContain("the voice state is unreadable");
  });

  // Review B2 F4: a ps that cannot answer is not "another program": the record stays, exit 1, nothing signalled.
  it("a ps failure keeps the whisper record and exits 1 with the voice:down-again sentence", async () => {
    const w = await upped();
    const rec = readState(w.stateDir)!.whisper!;
    w.psFails = true;
    expect(await voiceDown(w.deps())).toBe(1);
    expect(w.signals).toEqual([]);
    expect(w.procs.has(rec.pid)).toBe(true);
    expect(w.out).toContain("voice:down: could not identify whisper-server: run pnpm voice:down again");
    expect(w.out.join("\n")).not.toContain("belongs to another program");
    expect(readState(w.stateDir)?.whisper).toEqual(rec);
    w.psFails = false;
    w.out.length = 0;
    expect(await voiceDown(w.deps())).toBe(0);
    expect(w.procs.has(rec.pid)).toBe(false);
    expect(existsSync(w.statePath)).toBe(false);
  });

  it("a busy lock is refused with the remove-the-lock sentence", async () => {
    const w = await upped();
    writeFileSync(path.join(w.stateDir, LOCK_FILE), `${process.ppid}\n`, { mode: 0o600 });
    w.procs.set(process.ppid, { comm: "node", startedAt: 0, args: [] });
    expect(await voiceDown(w.deps())).toBe(1);
    expect(w.out).toEqual(["voice:down: another voice:up or voice:down is running; if no voice:up or voice:down is running, remove the file lock in VOICE_STATE_DIR"]);
  });
});

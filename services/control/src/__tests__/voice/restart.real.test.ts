import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlConfig } from "../../config.js";
import type { ParentMessage } from "../../protocol.js";
import type { SetTimer } from "../../supervisor.js";
import { speechSpawn } from "../../voice/speech-spawn.js";
import { VoiceHost } from "../../voice/voice-host.js";
import { AI_CONFIG } from "../fake-child.js";

/**
 * US-0071 (EPIC-0003 voice A1b, Task 8, AC-0410): the restart path with the REAL speech worker process. A SIGKILLed worker is followed
 * by a new process that says worker_ready and gets the seats; shutdown leaves no child behind. Real timers (the 500 ms backoff), every
 * wait a poll on an effect, no elapsed-time assertion, a private temp dir. Run in the Linux container before pushing (AGENTS.md 8).
 */
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const WAIT_MS = 60_000;
const ID = "c".repeat(32);
const realTimer: SetTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return () => clearTimeout(t); };
const gone = (pid: number): boolean => { try { process.kill(pid, 0); return false; } catch { return true; } };

let root = "";
let host: VoiceHost | undefined;
const pids: number[] = [];
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "acr-voice-restart-")); });
afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
  host = undefined;
  await vi.waitFor(() => { if (!pids.every(gone)) throw new Error("a worker is still running"); }, { timeout: WAIT_MS, interval: 25 });
  rmSync(root, { recursive: true, force: true });
});

describe("the speech worker restart with real processes (US-0071, A1b Task 8)", () => {
  it("a SIGKILLed worker is replaced by a new process that says worker_ready and gets the current seats", async () => {
    const script = path.join(root, "script.json");
    writeFileSync(script, JSON.stringify({ tech_lead: [] }), { mode: 0o600 });
    const toRuntime: ParentMessage[] = [];
    const logs: string[] = [];
    const config = { ...AI_CONFIG, graceMs: 2000, logDir: root } as ControlConfig;
    host = new VoiceHost({
      spawn: speechSpawn(), config, setTimer: realTimer, log: (m) => logs.push(m),
      parentEnv: { PATH: process.env.PATH, STT_PROVIDER: "fake", STT_FAKE_SCRIPT: script, SPEECH_INGEST: "file", SPEECH_INGEST_DIR: root },
      toRuntime: (_id, m) => { toRuntime.push(m); return true; },
    });
    const v = host;
    v.attach(ID, { voice: true, roles: ["tech_lead"] });
    v.fromRuntime(ID, { type: "voice_seats", paused: true, ended: false, holders: [{ roleId: "tech_lead", participantId: "p1", recording: false, voiceChosen: true }], open: [] });
    const first = await vi.waitFor(() => { const p = v.workerPid(ID); if (p === undefined) throw new Error("no worker yet"); return p; }, { timeout: WAIT_MS, interval: 25 });
    pids.push(first);
    process.kill(first, "SIGKILL");
    await vi.waitFor(() => expect(toRuntime).toContainEqual({ type: "voice_alert", code: "worker_restarting" }), { timeout: WAIT_MS, interval: 25 });
    const second = await vi.waitFor(() => { const p = v.workerPid(ID); if (p === undefined || p === first) throw new Error("no new worker yet"); return p; }, { timeout: WAIT_MS, interval: 25 });
    pids.push(second);
    expect(gone(first)).toBe(true);
    expect(logs).toContain(`session ${ID} speech worker stopped unexpectedly`);
    expect(logs.filter((l) => l === `session ${ID} speech worker started`)).toHaveLength(2);
    expect(toRuntime.filter((m) => m.type === "voice_alert" && m.code === "voice_off")).toEqual([]);
    expect(logs.join("\n")).not.toContain(root);
  });
});

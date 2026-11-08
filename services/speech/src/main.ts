import { pathToFileURL } from "node:url";
import { LimitedSpeechToText, WhisperHttpSpeechToText, type SpeechToText } from "@acr/adapters";
import { parseWorkerConfig } from "./config.js";
import { loadFakeScript } from "./fake-script.js";
import { ControlToWorkerSchema, WorkerMessageSchema, type WorkerMessage } from "./protocol.js";
import { startWorker } from "./worker.js";

/** After the parent's IPC channel closes: exit this long later whatever happens (a hung stop must not leave an orphan). */
export const HARD_EXIT_MS = 5_000;

const realSetTimer = (fn: () => void, ms: number): (() => void) => { const t = setTimeout(fn, ms); t.unref(); return () => clearTimeout(t); };
const realSleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new Error("aborted")); return; }
  const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = (): void => { clearTimeout(t); reject(new Error("aborted")); };
  signal?.addEventListener("abort", onAbort, { once: true });
});

/** Real-time pacing for file ingest: each frame time is waited against a fixed schedule, so timer drift does not accumulate. */
function realtimePace(now: () => number): (ms: number) => Promise<void> {
  let next: number | null = null;
  return (ms) => {
    next = (next ?? now()) + ms;
    const wait = next - now();
    return wait <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, wait));
  };
}

/**
 * US-0070 (EPIC-0003 voice A1a): the speech worker process. It runs only as a child of the control service (fork() with IPC): it has no
 * network listener and never talks to the runtime. Settings come from control's allowlisted environment; a bad one exits 2 with fixed
 * sentences naming the variable only. Every message from the parent is validated (`ControlToWorkerSchema`) and anything else is dropped;
 * every message to it is validated too. The process exits 0 when the parent's channel closes (hard backstop HARD_EXIT_MS). It never logs
 * an environment value, a path or a transcript.
 */
async function main(): Promise<void> {
  if (typeof process.send !== "function") { console.error("error: the speech worker runs only as a child of the control service"); process.exit(2); }
  const parsed = parseWorkerConfig(process.env);
  if (!parsed.ok) { for (const e of parsed.errors) console.error(`error: ${e}`); process.exit(2); }
  const { cfg } = parsed;
  let stt: SpeechToText | ((roleId: string) => SpeechToText);
  if (cfg.stt.kind === "whisper") {
    stt = new LimitedSpeechToText(new WhisperHttpSpeechToText({ url: cfg.stt.url }), {
      now: Date.now, sleep: realSleep, setTimer: realSetTimer, coldTimeoutMs: cfg.stt.coldTimeoutMs, idleColdMs: cfg.stt.idleColdMs,
      onQueueAlert: () => console.error("warning: the speech-to-text queue is long; transcription is falling behind"),
    });
  } else {
    try { const fake = loadFakeScript(cfg.stt.scriptFile); stt = (roleId) => fake.sttFor(roleId); }
    catch (err) { console.error(`error: ${err instanceof Error ? err.message : "STT_FAKE_SCRIPT is not readable"}`); process.exit(2); }
  }
  const send = (m: WorkerMessage): boolean => {
    if (!process.connected || !WorkerMessageSchema.safeParse(m).success) return false;
    try { return process.send!(m, () => {}) !== false; } catch { return false; }
  };
  const worker = startWorker({ cfg, send, now: Date.now, stt, pace: realtimePace(Date.now), log: (m) => console.error(m) });
  process.on("message", (raw: unknown) => {
    const m = ControlToWorkerSchema.safeParse(raw);
    if (m.success) worker.onControl(m.data);
  });
  let leaving = false;
  process.on("disconnect", () => {
    if (leaving) return;
    leaving = true;
    setTimeout(() => process.exit(0), HARD_EXIT_MS).unref();
    void worker.stop().catch(() => undefined).finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => { void worker.stop().catch(() => undefined).finally(() => process.exit(0)); });
}

// Only run when executed directly (tsx src/main.ts), never on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();

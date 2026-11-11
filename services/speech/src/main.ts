import { pathToFileURL } from "node:url";
import { LimitedSpeechToText, WhisperHttpSpeechToText, type SpeechToText } from "@acr/adapters";
import { parseWorkerConfig } from "./config.js";
import { loadFakeScript } from "./fake-script.js";
import { ControlToWorkerSchema, EXIT_LIVEKIT_LOST, WorkerMessageSchema, type WorkerMessage } from "./protocol.js";
import type { AudioIngest } from "./ingest/audio-ingest.js";
import { LiveKitIngest, type LiveKitJoinInfo } from "./ingest/livekit-ingest.js";
import type { RoomPort } from "./ingest/room-port.js";
import { SlotSpeechToText, newSlotId } from "./slot-stt.js";
import { afterStoreWait, openStore } from "./store/store-setup.js";
import { startWorker, type RunningWorker } from "./worker.js";

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
 *
 * US-0071 (A1b Task 7): with SPEECH_INGEST=livekit the real room port is loaded here, dynamically (a file-ingest run never loads the
 * native `@livekit/rtc-node`), its logger silenced first; a failed or lost seat room is reported as `livekit_status` and the worker exits
 * EXIT_LIVEKIT_LOST. It never logs a room, an identity or a token.
 */
async function main(): Promise<void> {
  if (typeof process.send !== "function") { console.error("error: the speech worker runs only as a child of the control service"); process.exit(2); }
  const parsed = parseWorkerConfig(process.env);
  if (!parsed.ok) { for (const e of parsed.errors) console.error(`error: ${e}`); process.exit(2); }
  const { cfg } = parsed;
  const send = (m: WorkerMessage): boolean => {
    if (!process.connected || !WorkerMessageSchema.safeParse(m).success) return false;
    try { return process.send!(m, () => {}) !== false; } catch { return false; }
  };
  let stt: SpeechToText | ((roleId: string) => SpeechToText);
  let slots: SlotSpeechToText | undefined;
  if (cfg.stt.kind === "whisper") {
    // US-0071 (A1b Task 6): every Whisper call runs inside one of control's global slots; the limiter keeps its own cap and deadlines
    // (the slot wait counts against the segment's deadline). The fake takes no slot.
    slots = new SlotSpeechToText(new WhisperHttpSpeechToText({ url: cfg.stt.url }), {
      request: (slot) => { send({ type: "stt_slot_request", slot }); }, release: (slot) => { send({ type: "stt_slot_release", slot }); }, newSlot: newSlotId,
    });
    stt = new LimitedSpeechToText(slots, {
      now: Date.now, sleep: realSleep, setTimer: realSetTimer, coldTimeoutMs: cfg.stt.coldTimeoutMs, idleColdMs: cfg.stt.idleColdMs,
      onQueueAlert: () => console.error("warning: the speech-to-text queue is long; transcription is falling behind"),
    });
  } else {
    try { const fake = loadFakeScript(cfg.stt.scriptFile); stt = (roleId) => fake.sttFor(roleId); }
    catch (err) { console.error(`error: ${err instanceof Error ? err.message : "STT_FAKE_SCRIPT is not readable"}`); process.exit(2); }
  }
  // US-0073 (A2a Task 7c): the audio store, behind its lock. Awaited BEFORE startWorker: after a control restart the old worker may hold
  // the lock for up to ~35 s, and only then is readiness (sent by startWorker after the STT warm-up) delayed; a failed acquire never
  // blocks the worker (it becomes transcript-only and `store_stopped` is sent). The lock is released only after the worker's last write.
  // During the wait no worker exists yet, so an ended `voice_state` sent then is dropped; harmless, nothing was written. If the parent
  // goes away during the wait (`disconnect` is not re-emitted later) the wait is aborted and the process exits before the worker starts.
  const parentGone = new AbortController();
  const onParentGone = (): void => parentGone.abort();
  process.once("disconnect", onParentGone); process.once("SIGTERM", onParentGone);
  const opened = cfg.store ? await openStore({ cfg: cfg.store, now: Date.now, send, sleep: realSleep, signal: parentGone.signal }) : undefined;
  const releaseStore = (): void => { opened?.release(); };
  const parentWasLost = (): boolean => afterStoreWait({ connected: process.connected, aborted: parentGone.signal.aborted, release: releaseStore, exit: (c) => process.exit(c) });
  if (parentWasLost()) return;
  let makeIngest: ((deps: { join: (roleId: string) => Promise<LiveKitJoinInfo> }) => AudioIngest) | undefined;
  let worker: RunningWorker | undefined;
  if (cfg.ingest.kind === "livekit") {
    let port: RoomPort;
    try { port = (await import("./ingest/livekit-room-native.js")).createRtcRoomPort(); }
    catch (err) { console.error(`error: the LiveKit client could not be loaded (${err instanceof Error ? err.name : "error"})`); process.exit(2); }
    const lost = (): void => {
      console.error("speech LiveKit ingest stopped; exiting for a restart");
      void (worker?.stop() ?? Promise.resolve()).catch(() => undefined).finally(() => { releaseStore(); process.exit(EXIT_LIVEKIT_LOST); });
    };
    makeIngest = ({ join }) => new LiveKitIngest({
      room: port, join, setTimer: realSetTimer,
      onStatus: (state) => { send({ type: "livekit_status", state }); if (state !== "connected") lost(); },
    });
  }
  // The once-handlers stay until the real ones are attached below; nothing awaits between this check and that swap, so a `disconnect`
  // (never re-emitted) cannot slip through the livekit import above.
  if (parentWasLost()) return;
  worker = startWorker({ cfg, send, now: Date.now, stt, pace: realtimePace(Date.now), log: (m) => console.error(m), setTimer: realSetTimer, ...(makeIngest ? { makeIngest } : {}), ...(opened ? { store: opened.store } : {}), ...(slots ? { onSlotGrant: slots.granted.bind(slots), healthPoll: true } : {}) });
  const running = worker;
  process.removeListener("disconnect", onParentGone); process.removeListener("SIGTERM", onParentGone);
  void running.done.then(releaseStore, releaseStore); // the end was handled: the last write and markEnded have happened
  process.on("message", (raw: unknown) => {
    const m = ControlToWorkerSchema.safeParse(raw);
    if (m.success) running.onControl(m.data);
  });
  let leaving = false;
  process.on("disconnect", () => {
    if (leaving) return;
    leaving = true;
    setTimeout(() => process.exit(0), HARD_EXIT_MS).unref();
    void running.stop().catch(() => undefined).finally(() => { releaseStore(); process.exit(0); });
  });
  process.on("SIGTERM", () => { void running.stop().catch(() => undefined).finally(() => { releaseStore(); process.exit(0); }); });
}

// Only run when executed directly (tsx src/main.ts), never on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();

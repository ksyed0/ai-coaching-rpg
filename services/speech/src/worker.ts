import type { SpeechToText } from "@acr/adapters";
import { ActivityReporter } from "./activity.js";
import type { WorkerConfig } from "./config.js";
import type { AudioIngest } from "./ingest/audio-ingest.js";
import { FileIngest } from "./ingest/file-ingest.js";
import type { ControlToWorker, WorkerMessage } from "./protocol.js";
import { Segmenter } from "./segmenter.js";
import { STT_DEADLINE_MS, TrackPipeline, newSegmentId } from "./track-pipeline.js";
import { VoiceGate } from "./voice-gate.js";

export type RunningWorker = {
  /** One validated message from control. Never throws. */
  onControl(m: ControlToWorker): void;
  /** Stops the ingest (no flush); resolves once no frame will come. */
  stop(): Promise<void>;
  /** Resolves after the session end was handled (flushed, edges closed) or after `stop`. */
  done: Promise<void>;
};

/**
 * US-0070 (EPIC-0003 voice A1a): the speech worker's wiring, in-process and testable (main.ts only adds the IPC channel).
 *  - Warms speech-to-text up (each distinct instance once, under the limiter's cold deadline) and then sends `worker_ready`; a failed
 *    warm-up reports `stt: "unavailable"` and the worker keeps running (its segments fail as `stt_failed`).
 *  - Starts the ingest only after the FIRST `voice_state` (overview C6), and builds one TrackPipeline per role on its first frame.
 *  - Every `voice_state` updates the gate; each role that stopped recording has its open segment discarded at once.
 *  - `ended`: stops the ingest, flushes every track's open segment (audio recorded before the end), delivers what is pending, then applies
 *    the ended state (nothing records after it).
 * `voice_line_result` is not used in A1a (A2 writes the seq into the audio index). Logs fixed sentences and error names only.
 */
export function startWorker(o: {
  cfg: WorkerConfig; send: (m: WorkerMessage) => boolean; now: () => number;
  /** One shared SpeechToText (the limited Whisper client) or one per role (the fake script). */
  stt: SpeechToText | ((roleId: string) => SpeechToText);
  ingest?: AudioIngest; pace?: (ms: number) => Promise<void>; log?: (m: string) => void;
}): RunningWorker {
  const log = o.log ?? (() => {});
  const send = (m: WorkerMessage): void => { try { o.send(m); } catch { /* a closed channel: the parent is gone */ } };
  const sttFor = typeof o.stt === "function" ? o.stt : (() => o.stt as SpeechToText);
  const gate = new VoiceGate();
  const activity = new ActivityReporter(send, o.now);
  const pipelines = new Map<string, TrackPipeline>();
  const ingest = o.ingest ?? new FileIngest({ dir: o.cfg.ingest.dir, roles: o.cfg.ingest.roles, frameMs: 20, pace: o.pace ?? (async () => {}) });
  let ingestStarted = false;
  let ending = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => { resolveDone = r; });

  const pipelineFor = (roleId: string): TrackPipeline => {
    let p = pipelines.get(roleId);
    if (!p) {
      p = new TrackPipeline({ roleId, segmenter: new Segmenter(o.cfg.segmenter), stt: sttFor(roleId), gate, activity, send, now: o.now, newSegmentId, deadlineMs: STT_DEADLINE_MS });
      pipelines.set(roleId, p);
    }
    return p;
  };

  const instances = [...new Set(typeof o.stt === "function" ? o.cfg.ingest.roles.map((r) => sttFor(r)) : [o.stt])];
  void Promise.all(instances.map((s) => s.warmUp())).then(
    () => send({ type: "worker_ready", stt: "ok" }),
    () => send({ type: "worker_ready", stt: "unavailable" }),
  );

  const startIngest = (): void => {
    ingestStarted = true;
    ingest.start((roleId, frame) => { if (!ending) pipelineFor(roleId).push(frame); })
      .catch((err: unknown) => log(`speech ingest stopped (${err instanceof Error ? err.name : "error"})`));
  };

  const end = async (m: Extract<ControlToWorker, { type: "voice_state" }>): Promise<void> => {
    try {
      await ingest.stop();
      await Promise.all([...pipelines.values()].map((p) => p.flush()));
    } catch (err) { log(`speech flush failed (${err instanceof Error ? err.name : "error"})`); }
    gate.update(m);
    for (const p of pipelines.values()) p.stop();
    resolveDone();
  };

  return {
    onControl(m) {
      try {
        if (m.type !== "voice_state" || ending) return;
        if (m.ended) { ending = true; void end(m); return; }
        const { stopped } = gate.update(m);
        for (const roleId of stopped) pipelines.get(roleId)?.stop();
        if (!ingestStarted) startIngest();
      } catch (err) { log(`speech control message failed (${err instanceof Error ? err.name : "error"})`); }
    },
    async stop() {
      ending = true;
      await ingest.stop().catch(() => undefined);
      resolveDone();
    },
    done,
  };
}

import { forkSpawn } from "../spawn.js";
import { speechCommand, speechCwd } from "./speech-command.js";
import type { SpeechSpawnFn, WorkerHandle } from "./voice-host.js";

/**
 * US-0070: the real SpeechSpawnFn. The worker is forked exactly like a runtime (forkSpawn: EXACTLY the given environment, stdout and stderr
 * appended to a 0600 log opened without following a symlink, one IPC channel), from the speech package's directory. The handle passes
 * messages through untouched: VoiceHost validates every message it receives with WorkerMessageSchema, and sends only ControlToWorker.
 */
export function speechSpawn(command: ReturnType<typeof speechCommand> = speechCommand()): SpeechSpawnFn {
  const spawn = forkSpawn(command, speechCwd());
  return (o) => spawn(o) as unknown as WorkerHandle;
}

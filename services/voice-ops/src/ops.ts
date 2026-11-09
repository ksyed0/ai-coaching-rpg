import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import type os from "node:os";
import path from "node:path";
import type { Run, SetTimer, SpawnDetached } from "./run.js";
import { StateDirError } from "./state.js";
import { EnvFileError } from "./env-file.js";
import { isHex } from "./text.js";
import type { TlsConnect } from "./tls-route.js";
import type { HealthAnswer } from "./whisper.js";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 7): what `voice:up`, `voice:down` and `voice:check` share: the injected seams (`OpsDeps`, built from
 * real built-ins only in `cli.ts`), the lock's busy sentence, the clean-up of temp files a killed run left behind, and the abortable wait.
 *
 * `OpsDeps` differs from the plan's sketch in one way (batch 3 note D21): there is no `fetchFn`. `fetch` follows NODE_USE_ENV_PROXY +
 * HTTP_PROXY (batch 1 review A F10) and would hand the STT URL with its secret path to a proxy, so the three HTTP questions are seams of
 * their own: `health` / `warm` (whisper.ts `whisperHealth` / `whisperWarm`, node:http on 127.0.0.1) and `answers` (`httpAnswers`).
 */

/** EADDRINUSE = taken; EACCES = denied (an unprivileged probe of a low port: not counted as taken). */
export type PortProbe = "free" | "taken" | "denied";

export type OpsDeps = {
  /** The REAL environment (process.env): `ensureVoiceSecrets` and the managed-name refusal need it, never the merged view. */
  env: NodeJS.ProcessEnv; home: string; repoRoot: string; out: (line: string) => void;
  run: Run; spawnDetached: SpawnDetached; kill: (pid: number, sig: NodeJS.Signals | 0) => void; pid: number;
  freePort: () => Promise<number>; portFree: (host: string, port: number, proto: "tcp" | "udp") => Promise<PortProbe>;
  random: (n: number) => Buffer; now: () => number; setTimer: SetTimer;
  interfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>; onInterrupt: (fn: () => void) => () => void;
  tlsConnect: TlsConnect;
  health: (sttUrl: URL) => Promise<HealthAnswer>; warm: (sttUrl: URL) => Promise<void>; answers: (url: string) => Promise<boolean>;
};

export const LOCK_BUSY_SENTENCE = "another voice:up or voice:down is running; if no voice:up or voice:down is running, remove the file lock in VOICE_STATE_DIR";

/** Whether a pid exists (EPERM: it does, under another user). */
export function alive(kill: OpsDeps["kill"], pid: number): boolean {
  try { kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The message of an error voice-ops made (fixed sentences); anything else becomes a fixed sentence, never Node's text (it names paths). */
export function sentenceOf(err: unknown, fallback: string): string {
  if (err instanceof StateDirError || err instanceof EnvFileError) return err.message;
  return fallback;
}

/**
 * Temp files a killed run can leave (batch 1 review A F9, batch 2 notes): `.env.voice-ops.<12 hex>.tmp` beside `.env` (it may hold the
 * new secrets) and `.livekit.env.<12 hex>.tmp`, `.state.json.<12 hex>.tmp`, `.lock.<12 hex>.tmp` in the state directory. Called with the
 * lock held. Only a regular file owned by this user is removed (lstat: never through a link); anything else of that name is left alone
 * and reported by its pattern, never its path.
 */
const STALE = [
  { where: "repo", prefix: ".env.voice-ops.", pattern: ".env.voice-ops.*.tmp" },
  { where: "state", prefix: ".livekit.env.", pattern: ".livekit.env.*.tmp" },
  { where: "state", prefix: ".state.json.", pattern: ".state.json.*.tmp" },
  { where: "state", prefix: ".lock.", pattern: ".lock.*.tmp" },
] as const;

export function cleanStaleTemps(o: { repoRoot: string; stateDir: string; say: (l: string) => void; uid?: number }): void {
  const uid = o.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  const removed = new Set<string>();
  const left = new Set<string>();
  for (const dir of [o.repoRoot, o.stateDir]) {
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const rule = STALE.find((r) => (r.where === "repo" ? dir === o.repoRoot : dir === o.stateDir) && name.startsWith(r.prefix) && name.endsWith(".tmp")
        && isHex(name.slice(r.prefix.length, name.length - ".tmp".length), 12));
      if (!rule) continue;
      const file = path.join(dir, name);
      let st: ReturnType<typeof lstatSync>;
      try { st = lstatSync(file); } catch { continue; }
      if (!st.isFile() || (uid !== undefined && st.uid !== uid)) { left.add(rule.pattern); continue; }
      try { unlinkSync(file); removed.add(rule.pattern); } catch { left.add(rule.pattern); }
    }
  }
  for (const p of removed) o.say(`removed a leftover temporary file (${p})`);
  for (const p of left) o.say(`left alone a leftover ${p} that is not a regular file of yours: check it by hand`);
}

/** A wait on the injected timer that an abort ends early. */
export function wait(setTimer: SetTimer, ms: number, signal?: AbortSignal): Promise<"slept" | "aborted"> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve("aborted"); return; }
    const onAbort = (): void => { cancel(); resolve("aborted"); };
    const cancel = setTimer(() => { signal?.removeEventListener("abort", onAbort); resolve("slept"); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

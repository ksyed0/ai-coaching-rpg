import { lstatSync, rmSync } from "node:fs";
import path from "node:path";
import { composeArgs, composeEnv, dockerProblem, removeLiveKitEnv } from "./compose.js";
import { alive, cleanStaleTemps, LOCK_BUSY_SENTENCE, sentenceOf, type OpsDeps } from "./ops.js";
import { loadRootEnv, parseVoiceOpsSettings, DEFAULT_LIVEKIT_HOST, DEFAULT_STT_MODEL, type VoiceOpsSettings } from "./settings.js";
import { acquireLock, clearState, loadState, openStateDir, releaseLock, removePrivateFile, writeState } from "./state.js";
import { COMPOSE_DOWN_TIMEOUT_MS } from "./up.js";
import { stopWhisper, WHISPER_STOP_GRACE_MS } from "./whisper.js";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 7): `pnpm voice:down` stops what `voice:up` started and removes its files; idempotent (nothing to
 * stop is exit 0). Order: settings (on an error the default state directory is still tried), the lock, the state, `docker compose ...
 * down` with every profile after `dockerProblem` (it works without `livekit.env`: `required: false`), whisper-server by its recorded pid
 * only when `isOurWhisper` says it is still ours (a reused pid is reported and left alone), then `livekit.env`, `whisper.log`, `public/`,
 * `tmp/` and the state. `caddy-data/` and `caddy-config/` stay (Caddy's own data). A Docker problem or a failing `down` keeps the
 * compose record so a later voice:down can try again (exit 1).
 */

/** Settings good enough for `compose down` (it interpolates every service): local-mode values, the given state directory. */
function downSettings(stateDir: string): VoiceOpsSettings {
  return { access: "local", stateDir, model: { label: DEFAULT_STT_MODEL, file: "/dev/null" }, webPort: 3000, livekitHost: new URL(DEFAULT_LIVEKIT_HOST), audioMinFreeMb: 2048 };
}

export async function voiceDown(d: OpsDeps): Promise<0 | 1> {
  const say = (l: string): void => d.out(`voice:down: ${l}`);
  let merged: NodeJS.ProcessEnv;
  try { merged = loadRootEnv(d.repoRoot, d.env); } catch (err) { say((err as Error).message); merged = { ...d.env }; }
  const parsed = parseVoiceOpsSettings(merged, { home: d.home, repoRoot: d.repoRoot });
  let stateDir: string;
  if (parsed.ok) stateDir = parsed.s.stateDir;
  else {
    for (const e of parsed.errors) say(e);
    say("settings have errors: using the default VOICE_STATE_DIR");
    stateDir = path.join(d.home, ".scenecoach", "voice");
  }
  try { lstatSync(stateDir); } catch { say("nothing to stop"); return 0; }
  try { openStateDir(stateDir, { repoRoot: d.repoRoot }); } catch (err) { say(sentenceOf(err, "VOICE_STATE_DIR cannot be used")); return 1; }
  if (acquireLock(stateDir, d.pid, (p) => alive(d.kill, p)) === "busy") { say(LOCK_BUSY_SENTENCE); return 1; }
  try {
    cleanStaleTemps({ repoRoot: d.repoRoot, stateDir, say });
    return await downLocked(d, stateDir, say);
  } finally { releaseLock(stateDir, d.pid); }
}

async function downLocked(d: OpsDeps, stateDir: string, say: (l: string) => void): Promise<0 | 1> {
  const loaded = loadState(stateDir);
  const state = loaded.status === "ok" ? { ...loaded.state } : null;
  let code: 0 | 1 = 0;

  // compose first, always tried (a leftover stack without a state is stopped too), after the Docker check
  const problem = await dockerProblem(d.env, d.run);
  let composeDown = false;
  if (problem) {
    say(problem);
    if (state?.compose || loaded.status === "unreadable") { say("LiveKit and the proxy were not stopped: fix Docker, then pnpm voice:down again"); code = 1; }
  } else {
    const r = await d.run("docker", composeArgs(d.repoRoot, "local", "down"), { env: composeEnv(d.env, downSettings(stateDir), state?.nodeIp ?? "127.0.0.1"), timeoutMs: COMPOSE_DOWN_TIMEOUT_MS }).catch(() => null);
    if (r === null || r.code !== 0) { say(`docker compose down failed${r?.code != null ? ` (exit ${r.code})` : ""}: run pnpm voice:down again, or docker compose -p scenecoach-voice down`); code = 1; }
    else { composeDown = true; say("LiveKit and the proxy stopped"); }
  }
  if (composeDown && state) delete state.compose;

  if (loaded.status === "unreadable") {
    say("the voice state is unreadable: a whisper-server it names was not stopped; stop whisper-server by hand if it runs, then remove state.json in VOICE_STATE_DIR");
    return 1;
  }

  if (state?.whisper) {
    const r = await stopWhisper(state.whisper, { run: d.run, kill: d.kill, setTimer: d.setTimer, graceMs: WHISPER_STOP_GRACE_MS });
    if (r === "not_ours") say("the recorded whisper-server is gone and its process id now belongs to another program: left alone");
    else if (r === "stopped") say("whisper-server stopped");
    else say("whisper-server was not running");
    delete state.whisper;
  }

  try {
    if (code === 0) {
      removeLiveKitEnv(stateDir);
      removePrivateFile(path.join(stateDir, "whisper.log"));
      for (const sub of ["public", "tmp"]) rmSync(path.join(stateDir, sub), { recursive: true, force: true });
      clearState(stateDir);
    } else if (state) writeState(stateDir, state);
  } catch (err) { say(sentenceOf(err, "a file in VOICE_STATE_DIR could not be removed")); return 1; }
  if (code === 0) say("done");
  return code;
}

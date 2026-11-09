import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { encodeWav } from "@acr/adapters";
import { logFormatFor } from "@acr/events";
import { startControl, type RunningControl } from "../main.js";
import type { VoiceHost } from "../voice/voice-host.js";
import { RuntimeClient, waitQuiet, waitUntil } from "./voice-client.js";

/**
 * US-0070 (EPIC-0003 voice A1a, AC-0404): `pnpm demo --voice`, the offline voice pipeline end to end. In a private temp tree it writes two
 * WAV files of synthetic tone bursts (no recorded voice) and a fake speech-to-text script with DIFFERENT, labelled lines per person, starts
 * the control service in-process (port 0, mock models, VOICE_ENABLED=1, notice v3, STT_PROVIDER=fake, SPEECH_INGEST=file), creates a
 * session of scenarios/friday-escalation, seats its three players by code, gives consent, starts, moves to the scene with the AI character
 * and lets ONE player opt in to voice (the other's file plays at the same time and must never be transcribed). Then it runs checks V-01 to
 * V-08 and removes the tree. Deterministic: turns are separated by long silences and a multi-segment turn comes from forced splits (no
 * gap the turn timer could race), every wait polls an effect under one watchdog, and "nothing more happens" is a quiet log (waitQuiet), never a
 * fixed sleep. Prints counts and check results only (no transcript,
 * path or secret).
 */
export const VOICE_CHECKS = [
  { id: "V-01", title: "every scripted line of the voice seat is in the log as a voice utterance under its role, in order" },
  { id: "V-02", title: "no scripted line of the text-only seat appears in the log" },
  { id: "V-03", title: "the AI character answered once per voice turn, not once per segment" },
  { id: "V-04", title: "the seat that did not opt in was never sent to speech-to-text" },
  { id: "V-05", title: "the Game Master evaluated per voice turn, not per segment" },
  { id: "V-06", title: "no player frame carries a segment id or another seat's participant id" },
  { id: "V-07", title: "killing the speech worker mid-speech leaves the session running: one worker_down alert, the voice turn closes, typed lines still recorded" },
  { id: "V-08", title: "the session log format is the one a session without voice gets (no format change)" },
] as const;

const SCENARIO = "friday-escalation";
const VOICE_ROLE = "account_manager";
const TEXT_ROLE = "delivery_lead";
const ROLES = ["account_manager", "delivery_lead", "tech_lead"] as const;
const SCENE = "s2_client_call";
const NPC = "client_sponsor";
const TURNS = 3;
/** V-07: after the three turns the voice seat speaks once more, for longer than the demo can take, so the worker is killed MID-speech. */
const LAST_BURST_MS = 75_000;
/** VOICE_MAX_SEGMENT_MS for the demo: a 4.4 s burst is split into three segments (2000, 2000, 400 ms of speech). */
const MAX_SEGMENT_MS = 2000;
const SEGMENTS_PER_TURN = 3;
const GM_EVERY_N = 3;
const WATCHDOG_MS = 90_000;
const STEP_MS = 60_000;
const WORKER_DOWN = "Voice input stopped: the speech worker is not running. Participants can continue by text.";
const RATE = 16_000;
/** "Nothing more happens": the log unchanged across this many consecutive 250 ms observations (the ticker runs about once a second). */
const QUIET_OBSERVATIONS = 12;
/** At most this many observations before a log that never settles fails the demo. */
const QUIET_MAX_STEPS = 240;

const AM_LINES = Array.from({ length: TURNS * SEGMENTS_PER_TURN }, (_, i) => `[AM-${i + 1}] ${["We can do the reconciliation in May.", "Finance gets a daily tie-out.", "I will confirm the scope today."][i % 3]}`);
const DL_LINES = ["[DL-1] This must never be transcribed.", "[DL-2] Nor this."];

type Out = { write(s: string): unknown };
type Event = { seq: number; type: string; roleId?: string; channel?: string; text?: string; message?: string; sceneId?: string; logFormat?: number; aiRoles?: string[] };

function tone(ms: number): Int16Array {
  const out = new Int16Array(Math.round((ms * RATE) / 1000));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(4600 * Math.sin((2 * Math.PI * 500 * i) / RATE));
  return out;
}
const silence = (ms: number): Int16Array => new Int16Array(Math.round((ms * RATE) / 1000));
const concat = (...p: Int16Array[]): Int16Array => { const o = new Int16Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

export async function runVoiceDemo(o: { root?: string; stdout: Out; stderr: Out; env: NodeJS.ProcessEnv }): Promise<number> {
  const tree = mkdtempSync(path.join(o.root ?? os.tmpdir(), "acr-voice-demo-"));
  const clients: RuntimeClient[] = [];
  let control: RunningControl | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  const results = new Map<string, { pass: boolean; detail: string }>();
  const check = (id: string, pass: boolean, detail: string): void => { results.set(id, { pass, detail }); };
  try {
    const run = async (): Promise<void> => {
      const ingest = path.join(tree, "ingest");
      mkdirSync(ingest, { mode: 0o700 });
      // The voice seat: three bursts of 4.4 s (each one turn of three segments) with 2.5 s of silence between them, then one long burst
      // (its segments get "" from the script: no line, nothing logged) that is still playing when V-07 kills the worker. The text-only
      // seat: two bursts, the first overlapping the voice seat's first turn.
      const turn = (): Int16Array => tone(4400);
      writeFileSync(path.join(ingest, `${VOICE_ROLE}.wav`), encodeWav(concat(silence(300), turn(), silence(2500), turn(), silence(2500), turn(), silence(1500), tone(LAST_BURST_MS)), RATE));
      writeFileSync(path.join(ingest, `${TEXT_ROLE}.wav`), encodeWav(concat(silence(1300), tone(1500), silence(4000), tone(1200), silence(1000)), RATE));
      const script = path.join(tree, "script.json");
      writeFileSync(script, JSON.stringify({ [VOICE_ROLE]: AM_LINES, [TEXT_ROLE]: DL_LINES }), { mode: 0o600 });
      const token = randomBytes(24).toString("hex");
      const env: NodeJS.ProcessEnv = {
        PATH: o.env.PATH, CONTROL_DATA_DIR: path.join(tree, "data"), LAUNCHER_TOKEN: token, MODEL_PROVIDER: "mock", CONTROL_READY_TIMEOUT_MS: "40000",
        VOICE_ENABLED: "1", CONSENT_NOTICE_VERSION: "v3", TURN_END_MS: "300", GM_EVERY_N_UTTERANCES: String(GM_EVERY_N), VOICE_MAX_SEGMENT_MS: String(MAX_SEGMENT_MS),
        STT_PROVIDER: "fake", STT_FAKE_SCRIPT: script, SPEECH_INGEST: "file", SPEECH_INGEST_DIR: ingest,
      };
      let voice: VoiceHost | undefined;
      control = await startControl(env, { port: 0, onVoiceHost: (v) => { voice = v; } });
      const api = async (method: string, url: string, body?: unknown): Promise<any> => {
        const res = await fetch(`http://127.0.0.1:${control!.port}${url}`, { method, headers: { "x-service-token": token, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        if (!res.ok) throw new Error(`the control service answered ${res.status}`);
        return res.json();
      };
      const unwrap = (r: any): any => (r && typeof r === "object" && "data" in r ? r.data : r);
      const created = unwrap(await api("POST", "/sessions", { scenarioId: SCENARIO })) as { sessionId: string; port: number; codes: { roleId: string; code: string }[] };
      const id = created.sessionId;
      const fac = unwrap(await api("GET", `/sessions/${id}/facilitator`)) as { port: number; token: string };
      const f = await RuntimeClient.facilitator({ port: fac.port, sessionId: id, token: fac.token, ms: STEP_MS });
      clients.push(f);
      const players: Record<string, RuntimeClient> = {};
      for (const roleId of ROLES) {
        const code = created.codes.find((c) => c.roleId === roleId)!.code;
        const c = await RuntimeClient.player({ port: created.port, sessionId: id, roleId, participantId: `pid-${roleId}`, code, displayName: roleId.replace("_", " "), ms: STEP_MS });
        clients.push(c);
        c.send({ type: "consent", noticeVersion: "v3" });
        players[roleId] = c;
      }
      await waitUntil("every seat to be ready", () => {
        const r = [...f.msgs].reverse().find((m) => m.type === "roster" && m.audience === "facilitator");
        return r?.entries?.length === ROLES.length && r.entries.every((e: { joined: boolean; consented: boolean }) => e.joined && e.consented);
      }, STEP_MS);
      f.send({ type: "start" });
      await waitUntil("the start", () => f.events("session.started").length > 0, STEP_MS);
      f.send({ type: "command", command: { command: "advance" } });
      await waitUntil("the scene with the AI character", () => f.events("scene.entered").some((e) => e.sceneId === SCENE), STEP_MS);

      const logFile = path.join(env.CONTROL_DATA_DIR!, "sessions", `${id}.jsonl`);
      const events = (): Event[] => readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Event);
      const sceneFrom = events().filter((e) => e.type === "scene.entered" && e.sceneId === SCENE).at(-1)!.seq;
      // Only the voice seat opts in; the file of the text-only seat plays at the same time.
      players[VOICE_ROLE]!.send({ type: "voice_opt_in", noticeVersion: "v3" });
      await players[VOICE_ROLE]!.answer("the opt-in", "voice", STEP_MS);
      const voiceLines = (): Event[] => events().filter((e) => e.type === "utterance" && e.channel === "voice");
      const npcLines = (): Event[] => events().filter((e) => e.type === "utterance" && e.roleId === NPC && e.seq > sceneFrom);
      const evaluations = (): Event[] => events().filter((e) => (e.type === "gm.decision" || e.type === "gm.no_verdict") && e.seq > sceneFrom);
      await waitUntil("every voice line", () => voiceLines().length >= AM_LINES.length, STEP_MS);
      await waitUntil("the AI character's answer to the last turn", () => npcLines().some((e) => e.seq > voiceLines().at(-1)!.seq), STEP_MS);
      await waitUntil("a Game Master evaluation", () => evaluations().length >= 1, STEP_MS);
      await waitQuiet("the session log", () => events().length, { stable: QUIET_OBSERVATIONS, maxSteps: QUIET_MAX_STEPS });
      const before = events();

      const vl = voiceLines();
      check("V-01", vl.length === AM_LINES.length && vl.every((e, i) => e.roleId === VOICE_ROLE && e.text === AM_LINES[i]), `${vl.length} voice lines of ${AM_LINES.length} scripted`);
      const leaked = before.filter((e) => DL_LINES.some((l) => JSON.stringify(e).includes(l.slice(0, 6))));
      check("V-02", leaked.length === 0 && vl.every((e) => e.roleId !== TEXT_ROLE), `${leaked.length} lines of the text-only seat in the log`);
      // One answer per closed turn: each answer comes after a turn's last segment and before the next turn's first.
      const npc = npcLines();
      const groups = vl.reduce<number[][]>((g, e, i) => { const prev = vl[i - 1]; if (prev && npc.some((n) => n.seq > prev.seq && n.seq < e.seq)) g.push([]); g.at(-1)!.push(e.seq); return g; }, [[]]);
      check("V-03", npc.length === TURNS && groups.length === TURNS && groups.every((g) => g.length === SEGMENTS_PER_TURN), `${npc.length} answers for ${TURNS} turns of ${SEGMENTS_PER_TURN} segments (${vl.length} segments)`);
      const calls = readFileSync(`${script}.calls.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { roleId: string });
      // The long last burst may already be sending its (empty) segments: at least one call per scripted line, every one for the voice seat.
      check("V-04", calls.length >= AM_LINES.length && calls.every((c) => c.roleId === VOICE_ROLE), `${calls.filter((c) => c.roleId === TEXT_ROLE).length} calls for the text-only seat, ${calls.length} in all`);
      // Units by turn: each closed turn is one, each AI line one. Counting segments would have allowed floor((segments + AI lines) / N).
      const byTurn = Math.floor((TURNS + npc.length) / GM_EVERY_N);
      const bySegment = Math.floor((vl.length + npc.length) / GM_EVERY_N);
      const evals = evaluations().filter((e) => e.seq <= before.at(-1)!.seq).length;
      check("V-05", evals >= 1 && evals <= byTurn && byTurn < bySegment, `${evals} evaluations (at most ${byTurn} by turn; counting segments would allow ${bySegment})`);
      const frames = Object.entries(players).map(([roleId, c]) => ({ roleId, text: c.raws.join("\n") }));
      const bad = frames.filter((p) => p.text.includes("segmentId") || ROLES.some((r) => r !== p.roleId && p.text.includes(`pid-${r}`)));
      check("V-06", bad.length === 0, `${bad.length} player streams with a segment id or another seat's participant id`);

      // Mid-speech: the long last burst has opened a voice turn (the runtime said voice_turn open). A worker killed now sends no "speech
      // stopped" edge; the worker_down alert must close the turn, or the Game Master and the AI players would stay held for the session.
      await waitUntil("the voice seat speaking again", () => voice?.voiceTurnOpen(id) === true, STEP_MS);
      const pid = voice?.workerPid(id);
      if (pid === undefined) throw new Error("the speech worker is not running");
      process.kill(pid, "SIGKILL");
      await waitUntil("the worker_down alert", () => events().some((e) => e.type === "facilitator.alert" && e.message === WORKER_DOWN), STEP_MS);
      await waitUntil("the voice turn to close", () => voice?.voiceTurnOpen(id) === false, STEP_MS);
      const linesAfterKill = voiceLines().length;
      players[TEXT_ROLE]!.send({ type: "say", text: "[DL-TYPED] I will send Priya the summary." });
      await waitUntil("the typed line", () => events().some((e) => e.type === "utterance" && e.roleId === TEXT_ROLE && e.channel === "text"), STEP_MS);
      await waitQuiet("the session log", () => events().length, { stable: QUIET_OBSERVATIONS, maxSteps: QUIET_MAX_STEPS });
      const status = (unwrap(await api("GET", `/sessions/${id}`)) as { status: string }).status;
      const downs = events().filter((e) => e.type === "facilitator.alert" && e.message === WORKER_DOWN).length;
      check("V-07", status === "running" && downs === 1 && voice?.workerPid(id) === undefined && voice?.voiceTurnOpen(id) === false && linesAfterKill === AM_LINES.length,
        `session ${status}, ${downs} worker_down alert(s), voice turn ${voice?.voiceTurnOpen(id) ? "open" : "closed"}, ${linesAfterKill} voice lines`);
      const started = events().find((e) => e.type === "session.started")!;
      const expected = logFormatFor(started.aiRoles ?? []);
      check("V-08", started.logFormat === expected, `format ${String(started.logFormat)}, a session without voice: ${expected}`);
    };
    await Promise.race([run(), new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error("the voice demo did not finish within its watchdog")), WATCHDOG_MS); })]);
  } catch (err) {
    o.stderr.write(`error: ${err instanceof Error ? err.message : "the voice demo failed"}\n`);
  } finally {
    clearTimeout(watchdog);
    for (const c of clients) c.close();
    await control?.close().catch(() => undefined);
    rmSync(tree, { recursive: true, force: true });
  }
  o.stdout.write("Voice pipeline demo (US-0070): file ingest, scripted speech-to-text, mock models\n");
  let passed = 0;
  for (const c of VOICE_CHECKS) {
    const r = results.get(c.id);
    if (r?.pass) passed++;
    o.stdout.write(`${r?.pass ? "PASS" : "FAIL"}  ${c.id}  ${c.title}${r ? ` (${r.detail})` : " (not run)"}\n`);
  }
  o.stdout.write(`${passed} of ${VOICE_CHECKS.length} checks passed\n`);
  return passed === VOICE_CHECKS.length ? 0 : 1;
}

// Only run when executed directly (tsx src/demo/voice-demo.ts), never on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runVoiceDemo({ stdout: process.stdout, stderr: process.stderr, env: process.env }).then((code) => process.exit(code), () => process.exit(1));
}

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { GmNoVerdictReason, SessionEvent } from "@acr/events";
import type { NpcRole, Scenario } from "@acr/script";
import { isEvent, type Inbound } from "./bots.js";
import { UNSAFE_CHARS, buildMarkers, ensure, findInjectLeaks, findMarkers, logShapeProblems, type CheckDef, type Markers } from "./checks.js";
import {
  PARTICIPANT_NAMES, ROLE_PLAYERS, connectBot, errCode, isJoinedMsg, settle, withTimeout, type Ctx, type PlayerId, type Story,
} from "./ctx.js";
import { MIN, type System } from "./harness.js";
import { gmDeadlineMs } from "../agents/timeouts.js";
import { MAX_CONSECUTIVE_SILENT_TURNS, type SilentTurn } from "../agents/npc-agent.js";
import { SHARE_SECTION, npcIntro } from "../agents/npc-prompt.js";
import { releaseNote } from "./release-note.js";
import { fallbackReason, isFallbackReply } from "./provenance.js";
import { scrubText } from "./report.js";
import { buildShowcaseReport, clip, formatAiSummary, type ShowcaseReport } from "./showcase-report.js";
import type { PlayerBotGenerator } from "./player-bot.js";
import { playerSource, type PlayerLineRecord, type PlayerLines } from "./player-lines.js";
import { buildShowcaseCases, lastNegativeLine, loadCases, type GmCase } from "../gm-eval/cases.js";
import { expectedGmEvaluations, type ShowcaseScript } from "./showcase-script.js";
import type { EvaluationResult } from "../evaluator/evaluate.js";
import { readSessionLog } from "../evaluator/log-reader.js";
import { summaryLines } from "../evaluator/summary.js";
import type { WrittenReports } from "../evaluator/report-write.js";
import { verifyReportFiles } from "../evaluator/verify.js";

/** The showcase's own checks (ids S-01..). `scripted` ones need the scripted models and are an intended skip in a live run. */
export const SHOWCASE_CHECKS: readonly CheckDef[] = [
  { id: "S-01", title: "The session completed (script_complete) and every scene was played", kind: "any" },
  { id: "S-02", title: "Every AI character answered in each scene it is in", kind: "any" },
  { id: "S-03", title: "No AI character spoke in a scene where it is absent", kind: "any" },
  { id: "S-04", title: "The Game Master evaluated the scenes and its gm.decision events are present", kind: "any" },
  { id: "S-05", title: "Canned fallback lines stay within --max-fallbacks (a warning without it)", kind: "any" },
  { id: "S-06", title: "Model prompts never contain the rubric, other roles' secrets, hidden facts or names", kind: "scripted" },
  { id: "S-07", title: "Players never receive facilitator-only events, other roles' secrets or participant identities", kind: "any" },
  { id: "S-08", title: "No raw control characters reached the narration or the report", kind: "any" },
  { id: "S-09", title: "The on-disk event log is monotonic from seq 1 and matches what the facilitator saw", kind: "any" },
  { id: "S-10", title: "No API key or environment value reached the log, any client or the output", kind: "any" },
  { id: "S-11", title: "No background failure was swallowed", kind: "any" },
  { id: "S-12", title: "The whole run finished within the watchdog", kind: "any" },
  { id: "S-13", title: "No scene was skipped: each had a scripted line, or ended by time box or Game Master before its first", kind: "any" },
  { id: "S-14", title: "The mock scripts were never exhausted and no scene needed the facilitator advance (unless --max-lines)", kind: "scripted" },
] as const;

/** Extra checks, only in a `--players generated` run (the default run keeps exactly S-01 to S-14). */
export const SHOWCASE_PLAYER_CHECKS: readonly CheckDef[] = [
  { id: "S-15", title: "Generated player prompts held only what that role may see, and every player line is tagged by what produced it", kind: "any" },
] as const;

/** Only with `--evaluate`: S-16 (the default run keeps exactly S-01 to S-14). */
export const SHOWCASE_EVAL_CHECKS: readonly CheckDef[] = [
  { id: "S-16", title: "The evaluator wrote a report for every player: each quote is a verbatim line of the session, the method is stated, scores are 1 to 4 or Not observed", kind: "any" },
] as const;

/** Only in a `--live` run: S-18 reports how reliably the real Game Master ended the scenes (it fails only below `--min-gm-exits`). */
export const SHOWCASE_LIVE_CHECKS: readonly CheckDef[] = [
  { id: "S-18", title: "The Game Master's reliability is reported: scenes it ended and its no-verdict rate by reason (fails only below --min-gm-exits)", kind: "any" },
] as const;

/** What `--evaluate` hands the showcase: runs the evaluator on the run's own session log (scripted offline in a mock run). */
export type ShowcaseEvaluate = { mock: boolean; run: (logFile: string, signal: AbortSignal) => Promise<{ result: EvaluationResult; written: WrittenReports }> };

export type ShowcaseHolder = {
  /** Set once the evaluator has run (`--evaluate`): what the --json report lists. */
  evaluation?: { result: EvaluationResult; written: WrittenReports };
  /** Builds the report from what the facilitator has seen so far (also usable after a failure or an abort). */
  snapshot?: () => ShowcaseReport;
  report?: ShowcaseReport;
};

export type ShowcaseOptions = {
  script: ShowcaseScript;
  mode: "mock" | "live";
  maxLines: number | null;
  maxFallbacks: number | null;
  /** `--min-gm-exits <n>` (live only): S-18 fails when the Game Master ended fewer scenes than this. */
  minGmExits?: number | null;
  /** S-18 fails when more scenes without AI characters than this ended early (before the scripted agreement); null (the default): only reported. */
  maxFalseExits?: number | null;
  watchdogMinutes: number;
  watchdogMs: number;
  provider?: string;
  /** The AI characters' reply deadline: bounds every wait for a model in a live run. */
  replyTimeoutMs: number;
  startedMs: number;
  holder: ShowcaseHolder;
  /** `--players generated`: the model that speaks the player roles, and the record of how each line was produced. */
  players?: { generator: PlayerBotGenerator; lines: PlayerLines; /** Log each private intent (default; `--no-intents` turns it off). */ showIntents: boolean };
  /** `--evaluate`: run the post-session evaluator after the checks and add check S-16. */
  evaluate?: ShowcaseEvaluate;
  /** Test hooks: run just before a scripted line is sent, and just before the safety-net advance (to force races). */
  hooks?: ShowcaseHooks;
};
export type ShowcaseHooks = {
  beforeLine?: (a: { sceneId: string; index: number; sys?: System; players?: Story["players"]; /** `--players generated` only: the generator and the line registry (tests tamper with them to prove the S-15 audit can fail). */ generated?: { generator: PlayerBotGenerator; lines: PlayerLines; showIntents: boolean } }) => Promise<void>;
  beforeAdvance?: (a: { sceneId: string; index: number; sys?: System }) => Promise<void>;
};

const EXIT_LABEL: Record<string, string> = {
  gm_detects: "the Game Master judged the exit condition true (gm_detects)",
  time_box_elapsed: "the time box elapsed",
  facilitator_advance: "facilitator advance",
};
export const describeExit = (reason: string): string => EXIT_LABEL[reason] ?? reason;

/** The scripted lines that will be spoken in each scene, after the --max-lines cap. */
export function linesFor(script: ShowcaseScript, sceneId: string, maxLines: number | null) {
  const entry = script.scenes.find((s) => s.scene === sceneId)!;
  return entry.lines.slice(0, maxLines ?? entry.lines.length);
}

/** An upper bound of the model calls a run makes: one reply per AI character per line, plus the Game Master's evaluations (`player`: the calls for the player lines, made only with --players generated). */
export function expectedModelCalls(scenario: Scenario, script: ShowcaseScript, maxLines: number | null, everyN?: number): { npc: number; gm: number; player: number } {
  let npc = 0; let gm = 0; let player = 0;
  for (const scene of scenario.script.scenes) {
    const n = scene.participants.filter((p) => scenario.roles[p]?.type === "npc").length;
    const lines = linesFor(script, scene.id, maxLines).length;
    npc += n * lines; player += lines;
    gm += expectedGmEvaluations(scene, lines, n, everyN);
  }
  return { npc, gm, player };
}

/**
 * The strings that must stay out of places they do not belong in this scenario. The short fragments the 29-check demo adds for
 * Friday Escalation are dropped: a role's secrets here are matched as WHOLE briefs and facts (a real model can legitimately say
 * "the ingestion layer"), while the rubric and hidden-fact fragments that really exist in the scenario are kept.
 */
export function showcaseMarkers(scenario: Scenario): Markers {
  const m = buildMarkers(scenario);
  const hay = JSON.stringify(scenario);
  const present = (x: string) => hay.includes(JSON.stringify(x).slice(1, -1));
  const players = Object.values(scenario.roles).filter((r) => r.type === "player") as { id: string; brief: string; private_facts: string[] }[];
  return {
    rubric: m.rubric.filter(present), hidden: m.hidden.filter(present), npcInternals: m.npcInternals.filter(present),
    secretsByRole: Object.fromEntries(players.map((p) => [p.id, [p.brief, ...p.private_facts]])),
  };
}

/** Each AI character's released hidden facts at the end of the stream (the last `released` list of its npc.updated events). */
export function releasedFacts(events: SessionEvent[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of events) if (e.type === "npc.updated" && e.released !== undefined) out.set(e.roleId, [...e.released]);
  return out;
}

/** Every release in the stream: the command's seq and its fact number, with the fact text taken from the facilitator-only npc.updated that follows it. */
export function releaseEvents(events: SessionEvent[]): { seq: number; roleId: string; fact: number; text: string }[] {
  const out: { seq: number; roleId: string; fact: number; text: string }[] = [];
  events.forEach((e, i) => {
    if (e.type !== "facilitator.command" || e.command !== "release_hidden") return;
    const upd = events.slice(i + 1).find((x): x is Extract<SessionEvent, { type: "npc.updated" }> => x.type === "npc.updated" && x.roleId === e.roleId);
    const text = upd?.released?.at(-1);
    if (text !== undefined) out.push({ seq: e.seq, roleId: e.roleId, fact: e.fact, text });
  });
  return out;
}

/**
 * Lines of the stream that contain scenario text which looks like hidden material, counted per speaker as whole hidden facts and as shorter phrases
 * (rubric text and the fragment the player script itself uses). Not counted: a fact released to a character (it is meant to be said), and a string a
 * player already said earlier in the same scene (an echo of that player, not a recital: an unreleased hidden fact never enters any prompt).
 */
export function hiddenFactMatches(events: SessionEvent[], scenario: Scenario, markers: Markers): Map<string, { facts: number; phrases: number }> {
  const wholeFacts = new Set(Object.values(scenario.roles).filter((r): r is NpcRole => r.type === "npc").flatMap((r) => r.hidden));
  const phrases = [...markers.hidden, ...markers.rubric].filter((x) => x && !wholeFacts.has(x));
  const matched = new Map<string, { facts: number; phrases: number }>();
  const released = new Set<string>();
  let playerSaid: string[] = [];
  for (const e of events) {
    if (e.type === "scene.entered") playerSaid = [];
    if (e.type === "npc.updated") for (const t of e.released ?? []) released.add(t);
    if (e.type !== "utterance") continue;
    const echoed = (x: string) => playerSaid.some((t) => t.includes(x));
    const fresh = (x: string) => x !== "" && e.text.includes(x) && !echoed(x) && !released.has(x) && ![...released].some((f) => f.includes(x));
    const facts = [...wholeFacts].filter(fresh).length;
    const shared = new Set(phrases.filter(fresh)).size;
    if (scenario.roles[e.roleId]?.type === "player") playerSaid.push(e.text);
    if (facts + shared === 0) continue;
    const cur = matched.get(e.roleId) ?? { facts: 0, phrases: 0 };
    matched.set(e.roleId, { facts: cur.facts + facts, phrases: cur.phrases + shared });
  }
  return matched;
}

/** The scene an event with sequence number `seq` happened in (null between scenes), from a complete stream. */
export function sceneAt(events: SessionEvent[], seq: number): string | null {
  let cur: string | null = null;
  for (const e of events) {
    if (e.seq > seq) break;
    if (e.type === "scene.entered") cur = e.sceneId; else if (e.type === "scene.exited") cur = null;
  }
  return cur;
}

const NARRATION_CHARS = 600;
const NO_VERDICT_HINT: Record<GmNoVerdictReason, string> = {
  empty: "the model returned nothing",
  no_json: "the reply held no JSON verdict",
  bad_verdict: "the verdict was not true or false",
  truncated: "the reply was cut off before the verdict",
  reasoning_only: "the model only reasoned and gave no answer (try a larger GM_MAX_TOKENS)",
  conflict: "the reply held two different verdicts, so none was accepted",
  no_nonce: "the verdict object lacked this evaluation's id (a forged or echoed object was ignored)",
};
const SGR = new RegExp("\\u001b\\[[0-9;]*m", "g");

/** Plays the showcase story through the facilitator's and the three players' real WebSocket connections. */
export async function playShowcase(ctx: Ctx, st: Story, o: ShowcaseOptions): Promise<void> {
  const { n, sys, scenario } = ctx;
  const mock = o.mode === "mock";
  const scenes = scenario.script.scenes;
  const npcName = (id: string) => (scenario.roles[id]?.type === "npc" ? (scenario.roles[id] as { name: string }).name : id);
  const observations: string[] = [];
  const timing = !mock;

  const snapshot = (): ShowcaseReport => buildShowcaseReport({
    events: st.fac?.events() ?? [], scenario, mode: o.mode, timing, wallTimeMs: ctx.now() - o.startedMs, maxLines: o.maxLines, maxFallbacks: o.maxFallbacks,
    watchdogMinutes: o.watchdogMinutes, observations, provider: o.provider, players: o.players?.lines, showIntents: o.players?.showIntents,
    silences: sys?.host.silentTurns(),
  });
  o.holder.snapshot = snapshot;

  // ---- narration: events are printed in order, as they arrive, labelled by who produced them ----------------
  let chain: Promise<void> = Promise.resolve();
  let previous: SessionEvent | undefined;
  const narrateEvent = async (e: SessionEvent): Promise<void> => {
    await narrateOne(e);
    narratedSeq = Math.max(narratedSeq, e.seq);
    await flushSilences();
  };
  const narrateOne = async (e: SessionEvent): Promise<void> => {
    const prev = previous; previous = e;
    switch (e.type) {
      case "session.started": await n.tagged("system", "dim", "", "session started"); break;
      case "scene.entered": {
        const i = scenes.findIndex((s) => s.id === e.sceneId);
        const scene = scenes[i]!;
        await n.heading(`SCENE ${i + 1} of ${scenes.length}: ${scene.title}`, { record: false });
        await n.note(`goal: ${clip(scene.goal, 300)}`, false);
        const ai = e.participants.filter((p) => scenario.roles[p]?.type === "npc").map(npcName);
        await n.note(`in the room: ${e.participants.filter((p) => scenario.roles[p]?.type === "player").join(", ")}${ai.length ? `; AI characters: ${ai.join(", ")}` : "; no AI characters"}`, false);
        break;
      }
      case "scene.exited": await n.tagged("system", "yellow", "", `scene ended: ${describeExit(e.reason)}`); break;
      case "inject.fired": await n.tagged("system", "dim", "", `inject ${e.injectId} to ${e.to.join(", ")}: ${clip(e.content, 200)}`); break;
      // Counts only: a released fact's text never goes into the narration (a demo transcript is a file people share).
      case "npc.updated": await n.tagged("system", "dim", "", `${e.roleId} updated: ${e.goals.length} goals, ${e.knowledge.length} knowledge items${(e.released?.length ?? 0) > 0 ? `, ${e.released!.length} released hidden fact(s)` : ""}`); break;
      case "utterance": {
        const role = scenario.roles[e.roleId];
        if (role?.type === "npc") {
          const canned = isFallbackReply(role, e, prev, { legacy: false });
          await n.tagged("AI character", "cyan", `${role.name} (${role.id}${canned ? ", canned fallback line" : ""})`, clip(e.text, NARRATION_CHARS));
        } else await n.tagged(narratePlayer && playerSource(narratePlayer(e.roleId, e.text)) === "generated" ? "player bot, generated" : "player bot", "green", e.roleId, clip(e.text, NARRATION_CHARS));
        break;
      }
      case "gm.decision":
        await n.tagged("Game Master", "yellow", `${e.verdict ? "TRUE" : "FALSE"} for "${clip(e.condition, 160)}"${e.via === "tolerant" ? " (reply read tolerantly)" : e.via === "reask" ? " (after a re-ask)" : ""}`, clip(e.reasoning, 300));
        break;
      case "gm.no_verdict":
        await n.tagged("Game Master", "red", `no verdict for "${clip(e.condition, 160)}"`, `${e.reason}${e.attempts > 1 ? " after the re-ask" : ""}: ${NO_VERDICT_HINT[e.reason]}`);
        break;
      case "facilitator.alert": {
        const why = fallbackReason(e.message);
        await n.tagged("alert", e.level === "warning" ? "red" : "yellow", "", why !== null ? `${e.message.split(":")[0]!.replace(/^NPC /, "AI character ")} fell back to its canned line: ${why}` : clip(e.message, 300));
        break;
      }
      case "facilitator.command": await n.tagged("system", "dim", "", e.command === "release_hidden" ? `${releaseNote(e.roleId, e.fact)} (its text is facilitator-only and is not shown here)` : `facilitator: ${e.command}`); break;
      case "session.ended": await n.tagged("system", "yellow", "", `session ended (${e.reason})`); break;
      default: break;
    }
  };
  // A silent turn leaves no event. Its note is narrated (and added to the transcript) only after the utterance it follows (`afterSeq`) has been narrated,
  // so it never appears before the line it comes after. The marker itself is never recorded anywhere.
  const pendingSilences: SilentTurn[] = [];
  let narratedSeq = 0;
  const flushSilences = async (all = false): Promise<void> => {
    while (pendingSilences.length > 0 && (all || pendingSilences[0]!.afterSeq <= narratedSeq)) {
      const t = pendingSilences.shift()!;
      const msg = `${npcName(t.roleId)} (${t.roleId}) had nothing new to add and stayed silent`;
      ctx.tr?.add({ kind: "log", source: "system", text: msg, scene: t.sceneId });
      await n.tagged("system", "dim", "", msg);
    }
  };
  const stopSilence = sys?.host.onSilentTurn((t) => {
    pendingSilences.push(t);
    chain = chain.then(() => flushSilences()).catch(() => undefined);
  });
  const narratePlayer = o.players?.lines.reader();
  const flush = async (): Promise<void> => { await chain; };

  // ---- the lobby ---------------------------------------------------------------------------------------
  await n.heading("LOBBY: the facilitator and the three player bots join");
  const fac = await connectBot(ctx, "facilitator");
  st.fac = fac;
  const fj = await fac.call({ type: "join_facilitator", sessionId: ctx.sessionId }, isJoinedMsg, { what: "the facilitator to join" });
  ensure(isJoinedMsg(fj), `the facilitator could not join: ${errCode(fj)}`);
  ensure(fj.state.status === "idle", "the server's session has already started");
  st.facJoined = fj;
  await n.tagged("system", "dim", "", "the facilitator joins (full view of the session)");
  for (const [role, who] of ROLE_PLAYERS) {
    const bot = await connectBot(ctx, role);
    const j = await bot.call({ type: "join", sessionId: ctx.sessionId, roleId: role, participantId: who }, isJoinedMsg, { what: `${role} to join` });
    ensure(isJoinedMsg(j), `${role} could not join: ${errCode(j)}`);
    st.players[role] = bot; st.joined[role] = j;
    await n.tagged("system", "dim", "", `${role} joins as a player bot with ${j.privateFacts?.length ?? 0} private facts`);
  }
  ctx.tr?.attach(fac, { scenario, provider: o.mode, sceneHeadings: true, players: o.players?.lines });
  const narrate = (m: Inbound) => { if (m.type === "event") { const e = m.event; chain = chain.then(() => narrateEvent(e)).catch(() => undefined); } };
  const prior = fac.onMessage;
  fac.onMessage = (m) => { prior?.(m); narrate(m); };

  const waitSettled = async (npcCount: number, gmConditions: number): Promise<void> => {
    const bound = mock ? 20_000 : npcCount * o.replyTimeoutMs + gmConditions * gmDeadlineMs(o.replyTimeoutMs) + 10_000;
    await withTimeout(settle(ctx, st), bound, "the AI characters and the Game Master to finish");
    await flush();
  };
  const exited = (sceneId: string) => fac.events().some((e) => e.type === "scene.exited" && e.sceneId === sceneId);
  /** The scene the session is in right now (from the facilitator's complete stream), or null between scenes and after the end. */
  const currentScene = (): string | null => sceneAt(fac.events(), Infinity);
  const exitReasonOf = (sceneId: string) => (fac.events().find((e) => e.type === "scene.exited" && e.sceneId === sceneId) as Extract<SessionEvent, { type: "scene.exited" }> | undefined)?.reason;

  /** Waits until the player's own connection has received the last utterance and the last inject addressed to it that the facilitator saw (so its prompt is complete). */
  const playerCaughtUp = async (bot: (typeof st.players)[PlayerId] & object, role: string): Promise<void> => {
    const all = fac.events();
    const ev = [...all].reverse();
    // The server sends a player only the utterances of scenes it takes part in (viewFor): mirror that, or a role absent from the previous scene would wait for an event that never comes.
    const participants = new Map(all.flatMap((e) => (e.type === "scene.entered" ? [[e.sceneId, e.participants] as const] : [])));
    const lastUtter = ev.find((e) => { if (e.type !== "utterance") return false; const sc = sceneAt(all, e.seq); return sc !== null && (participants.get(sc)?.includes(role) ?? false); })?.seq;
    const lastInject = ev.find((e) => e.type === "inject.fired" && e.to.includes(role))?.seq;
    for (const seq of [lastUtter, lastInject]) {
      if (seq !== undefined) await bot.waitFor((m) => m.type === "event" && m.event.seq === seq, { timeoutMs: 15_000, what: `${role} to receive event ${seq}` });
    }
  };

  fac.send({ type: "start" });
  await fac.waitFor(isEvent("session.started"), { what: "session.started" });

  // ---- the scenes --------------------------------------------------------------------------------------
  for (const scene of scenes) {
    if (ctx.signal.aborted) throw new Error("run aborted");
    if (ctx.beforeAct) {
      const aborted = new Promise<never>((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("run aborted")), { once: true }));
      await Promise.race([ctx.beforeAct(scene.title), aborted]);
    }
    await fac.waitFor(isEvent("scene.entered", (e) => e.sceneId === scene.id), { timeoutMs: 15_000, what: `scene ${scene.id} to start` });
    // The opening inject is the last thing a scene's start appends: waiting for it means the start has fully finished.
    if (scene.opening_inject) await fac.waitFor(isEvent("inject.fired", (e) => e.injectId === scene.opening_inject), { timeoutMs: 15_000, what: `the opening inject of ${scene.id}` });
    await flush();
    const npcCount = scene.participants.filter((p) => scenario.roles[p]?.type === "npc").length;
    const gmConditions = scene.exit_when.any_of.filter((c) => typeof c === "object").length;
    const timedAt = Math.max(0, ...(scene.injects ?? []).filter((i) => i.at_minute !== undefined && i.at_minute < scene.time_box_minutes).map((i) => i.at_minute!));
    const lines = linesFor(o.script, scene.id, o.maxLines);
    let spoken = 0;

    for (const [i, line] of lines.entries()) {
      if (exited(scene.id)) break; // the Game Master (or the time box) ended the scene early: the rest of its lines stay unspoken
      if (mock && sys?.fakeClock && i === 1 && timedAt > 0) {
        const entered = fac.events().find((e) => e.type === "scene.entered" && e.sceneId === scene.id)!;
        const delta = entered.ts + timedAt * MIN - sys.clock.now();
        if (delta > 0) { sys.fakeClock.advance(delta); await n.note(`the fake clock moves to minute ${timedAt} of the scene, so its timed injects fire`); }
      }
      await o.hooks?.beforeLine?.({ sceneId: scene.id, index: i, sys, players: st.players, generated: o.players });
      const bot = st.players[line.role as PlayerId]!;
      let text = line.text;
      let record: PlayerLineRecord | undefined;
      if (o.players) {
        // The model speaks this slot; the scripted line is only its private intent. The player's own stream must have caught up first.
        await playerCaughtUp(bot, line.role);
        if (o.players.showIntents) {
          // Technical logging only: the intent never goes to the server, a client or the Game Master.
          const msg = `intent for ${line.role} (private to the player bot; the server and the other players never see it): ${line.text}`;
          ctx.tr?.add({ kind: "log", source: "system", text: msg, scene: scene.id });
          chain = chain.then(() => n.note(clip(msg, 900), false)).catch(() => undefined);
        }
        const said = await o.players.generator.speak({ roleId: line.role, scene, scripted: line.text, joined: st.joined[line.role as PlayerId]!, events: bot.events() });
        if (ctx.signal.aborted) throw new Error("run aborted");
        text = said.text;
        record = o.players.lines.add({ role: line.role, text, source: said.source, verbatim: said.verbatim, cut: said.cut, intent: line.text, scene: scene.id, ...(said.reason !== undefined ? { reason: said.reason } : {}) });
        if (said.reason !== undefined) {
          const msg = `player ${line.role}: generation failed (${said.reason}); used the scripted line`;
          chain = chain.then(() => n.tagged("alert", "yellow", "", clip(msg, 300))).catch(() => undefined);
          ctx.tr?.add({ kind: "log", source: "system", text: msg, scene: scene.id });
        }
      }
      const from = bot.mark();
      const lastSeqBefore = fac.events().at(-1)?.seq ?? 0;
      // Every line names the scene it belongs to: if the scene ended in between (a time box, the Game Master), the server refuses it.
      bot.send({ type: "say", text, expectSceneId: scene.id });
      const r = await bot.waitFor((m) => m.type === "error" || isEvent("utterance", (e) => e.roleId === line.role && e.text === text)(m), { from, timeoutMs: 15_000, what: `${line.role}'s line to be accepted` });
      if (r.type === "error") {
        if (record) o.players!.lines.drop(record);
        if (r.code === "stale_scene" || r.code === "not_in_scene") {
          observations.push(`scene changed under us: ${line.role}'s line ${i + 1} of ${scene.id} was refused (${r.code}); the session is now ${currentScene() ? `in ${currentScene()}` : "between scenes or ended"}`);
          break;
        }
        throw new Error(`${line.role}'s line was refused: ${errCode(r)}`);
      }
      spoken++;
      await waitSettled(npcCount, gmConditions);
      const echo = fac.events().find((e) => e.type === "utterance" && e.roleId === line.role && e.text === text && e.seq > lastSeqBefore);
      ensure(!echo || sceneAt(fac.events(), echo.seq) === scene.id, `${line.role}'s line ${i + 1} landed in a different scene than ${scene.id}`);
      // The scripted facilitator steps of this scene that come after this line (a hidden-fact release).
      for (const step of o.script.scenes.find((x) => x.scene === scene.id)!.facilitator.filter((x) => x.afterLine === i + 1)) {
        const what = `hidden fact #${step.fact} of ${step.role}`;
        if (exited(scene.id)) { observations.push(`facilitator step skipped: ${scene.id} had already ended, so ${what} was not released`); continue; }
        const fromStep = fac.mark();
        fac.send({ type: "command", command: { command: "release_hidden", roleId: step.role, fact: step.fact }, expectSceneId: scene.id });
        const sent = await fac.waitFor((m) => m.type === "error" || isEvent("npc.updated", (e) => e.roleId === step.role && (e.released?.length ?? 0) > 0)(m), { from: fromStep, timeoutMs: 15_000, what: `the release of ${what}` });
        if (sent.type === "error") {
          if (sent.code === "stale_scene") { observations.push(`scene changed under us: the release of ${what} was refused (stale_scene); it was not released`); continue; }
          throw new Error(`the release of ${what} was refused: ${errCode(sent)}`);
        }
        await waitSettled(npcCount, gmConditions);
      }
    }
    if (spoken < lines.length && exited(scene.id)) {
      const reason = exitReasonOf(scene.id) ?? "an exit";
      observations.push(`${scene.id} ended by ${reason} after ${spoken} of ${lines.length} scripted lines; ${lines.length - spoken} line(s) left unspoken`);
    }

    // A live run's ticker can judge while a line is being recorded, before the characters answer; judge once more on the full turn.
    if (!mock && !exited(scene.id) && sys) {
      const bound = (npcCount + 1) * o.replyTimeoutMs + gmConditions * gmDeadlineMs(o.replyTimeoutMs);
      if (await withTimeout(sys.host.evaluateFinal(scene.id), bound, "the final Game Master evaluation")) await n.note("the Game Master judges the scene once more after the last reply");
      await flush();
    }

    if (!exited(scene.id)) {
      // The safety net: the scripted lines are used up and the scene is still open.
      await o.hooks?.beforeAdvance?.({ sceneId: scene.id, index: lines.length, sys });
      const from = fac.mark();
      fac.send({ type: "command", command: { command: "advance" }, expectSceneId: scene.id });
      const r = await fac.waitFor((m) => m.type === "error" || isEvent("facilitator.command", (e) => e.command === "advance")(m), { from, timeoutMs: 15_000, what: "advance to be accepted" });
      if (r.type === "error" && r.code === "stale_scene") {
        observations.push(`scene changed under us: the facilitator advance for ${scene.id} was refused (stale_scene): it had already ended (${exitReasonOf(scene.id) ?? "unknown"}); nothing was skipped`);
      } else {
        ensure(r.type === "event", `facilitator advance was refused: ${errCode(r)}`);
        observations.push(`GM did not exit; facilitator advanced (${scene.id})`);
        await n.note("the scripted lines are used up and the Game Master has not ended the scene: the facilitator advanced");
        await waitSettled(npcCount, gmConditions);
      }
    }
  }
  await fac.waitFor(isEvent("session.ended"), { timeoutMs: 15_000, what: "the session to end" });
  await flush();
  stopSilence?.();
  chain = chain.then(() => flushSilences(true)).catch(() => undefined);
  await flush();
  await settle(ctx, st);
  await flush();

  // ---- the summary ---------------------------------------------------------------------------------------
  if (o.players) {
    const p = snapshot().players;
    if (p) observations.push(`--players generated: ${p.generated} player line(s) were generated, ${p.scriptedFallbacks} fell back to the scripted line, ${p.verbatimRepeats} generated line(s) repeated the scripted line verbatim`);
  }
  const summary = snapshot();
  await n.heading("SUMMARY");
  const [title, ...rest] = formatAiSummary(summary);
  n.styled(title!, "bold");
  for (const l of rest) n.line(l, false);
  o.holder.report = summary;
  await playShowcaseAudit(ctx, st, o, summary, observations);
  o.holder.report = snapshot(); // the audit may add observations
}

/** The showcase's checks, run after the story: they need the whole run to be over. */
async function playShowcaseAudit(ctx: Ctx, st: Story, o: ShowcaseOptions, summary: ShowcaseReport, observations: string[]): Promise<void> {
  const { rec, sys, scenario } = ctx;
  const mock = o.mode === "mock";
  const fac = st.fac!;
  const markers = ctx.markers;
  await ctx.n.heading("AUDIT: what the whole run proves");
  if (sys) { await sys.host.idle(); }
  const events = (): SessionEvent[] => fac.events();
  const npcIds = Object.values(scenario.roles).filter((r) => r.type === "npc").map((r) => r.id);
  /** The AI characters whose own goals, knowledge or hidden facts include `marker` (they may say it aloud). */
  const npcOwnersOf = (marker: string): string[] => Object.values(scenario.roles).filter((r): r is NpcRole => r.type === "npc" && [...r.goals, ...r.knowledge, ...r.hidden].includes(marker)).map((r) => r.id);

  await rec.run("S-01", async () => {
    const ev = events();
    const ended = ev.find((e): e is Extract<SessionEvent, { type: "session.ended" }> => e.type === "session.ended");
    ensure(ended && ended.reason === "script_complete" && ev.at(-1)!.type === "session.ended", `the session ended with ${ended?.reason ?? "no session.ended"}`);
    const entered = ev.filter((e) => e.type === "scene.entered").map((e) => (e as Extract<SessionEvent, { type: "scene.entered" }>).sceneId);
    ensure(JSON.stringify(entered) === JSON.stringify(scenario.script.scenes.map((s) => s.id)), `scenes entered: ${entered.join(", ") || "none"}`);
    for (const [role] of ROLE_PLAYERS) await st.players[role]!.waitFor(isEvent("session.ended"), { what: `${role} to see the end` });
    await st.players.delivery_lead!.expectError({ type: "say", text: "Is anyone still there?" }, "ended");
    return `session.ended (script_complete) after ${ev.length} events; all ${entered.length} scenes were played; speech afterwards is refused (ended)`;
  });

  await rec.run("S-02", () => {
    const parts: string[] = [];
    for (const scene of scenario.script.scenes) {
      const here = scene.participants.filter((p) => npcIds.includes(p));
      for (const id of here) {
        const said = summary.lines.filter((l) => l.source === "ai-character" && l.role === id && l.sceneId === scene.id);
        const silent = summary.voices.silentTurns.byScene.find((x) => x.sceneId === scene.id && x.roleId === id)?.count ?? 0;
        const playerLines = summary.scenes.find((x) => x.id === scene.id)?.playerLines ?? 0;
        // A character may stay silent at most MAX_CONSECUTIVE_SILENT_TURNS turns in a row: with more player lines than that it must have spoken.
        ensure(said.length > 0 || (silent > 0 && playerLines <= MAX_CONSECUTIVE_SILENT_TURNS), `${id} never spoke in ${scene.id}${silent > 0 ? ` (silent:${silent} of ${playerLines} player line(s), more than the ${MAX_CONSECUTIVE_SILENT_TURNS} turns in a row a character may stay silent)` : ""}`);
        ensure(said.every((l) => l.text.trim().length > 0), `${id} produced an empty utterance in ${scene.id}`);
        parts.push(`${id}@${scene.id}:${said.length}${silent > 0 ? ` silent:${silent}` : ""}`);
      }
    }
    ensure(parts.length > 0, "the scenario has no scene with an AI character (the check would be vacuous)");
    return `${summary.npcReplies} AI replies; every character spoke in every scene it is in, or chose silence (${parts.join(", ")})`;
  }, ["S-01"]);

  await rec.run("S-03", () => {
    let absentScenes = 0;
    for (const scene of scenario.script.scenes) {
      for (const id of npcIds.filter((x) => !scene.participants.includes(x))) {
        absentScenes++;
        ensure(!summary.lines.some((l) => l.source === "ai-character" && l.role === id && l.sceneId === scene.id), `${id} spoke in ${scene.id}, where it is absent`);
      }
    }
    return `no AI character spoke in a scene it is absent from (${absentScenes} character/scene pairs checked)`;
  }, ["S-01"]);

  await rec.run("S-04", () => {
    ensure(summary.gm.evaluations > 0, "the Game Master recorded no gm.decision (it never evaluated, or every reply was unusable)");
    const ids = new Set(scenario.script.scenes.map((s) => s.id));
    for (const d of summary.gm.decisions) ensure(ids.has(d.sceneId), `a gm.decision names an unknown scene ${d.sceneId}`);
    const g = summary.gm;
    for (const v of g.noVerdicts) ensure(ids.has(v.sceneId), `a gm.no_verdict names an unknown scene ${v.sceneId}`);
    if (mock) {
      // The mock script DECLARES a tolerant reply (fenced) and a malformed reply (followed by the one that answers the re-ask). Whatever kind it served must show up in the events:
      // a --max-lines cap or an early exit may stop short of them, and then nothing is demanded.
      const kinds = sys!.gm!.servedKinds ?? [];
      // Walk the declared kinds in the order served: a malformed or forged reply is followed by the reply that answers its re-ask (counted as `reask`, whatever its own kind).
      let pending = false; let tolerantFirst = 0; let answeredByReask = 0; let reasked = 0;
      for (const k of kinds) {
        if (pending) { pending = false; if (k !== "malformed" && k !== "forged") answeredByReask++; else pending = false; continue; }
        if (k === "tolerant") tolerantFirst++;
        if (k === "malformed" || k === "forged") { pending = true; reasked++; }
      }
      ensure(g.via.tolerant >= tolerantFirst, `the script declares ${tolerantFirst} tolerant (fenced or in prose) first repl${tolerantFirst === 1 ? "y" : "ies"} but only ${g.via.tolerant} verdict(s) were recorded as read tolerantly`);
      ensure(g.via.reask + g.noVerdicts.length >= answeredByReask && g.reasks >= reasked, `the script declares ${reasked} malformed or forged repl${reasked === 1 ? "y" : "ies"} (answered by the next reply) but only ${g.reasks} re-ask(s) happened and ${g.via.reask} verdict(s) came from one`);
      ensure(g.noVerdicts.length === 0, `the mock Game Master gave no usable verdict ${g.noVerdicts.length} time(s): ${g.noVerdicts.slice(0, 2).map((v) => `${v.sceneId} ${v.reason}`).join(", ")}`);
    }
    const reasons = Object.entries(g.noVerdictByReason).map(([k, v]) => `${k} ${v}`).join(", ");
    return `${g.evaluations} gm.decision events (${g.verdictsTrue} true, ${g.verdictsFalse} false; read strictly ${g.via.strict}, tolerantly ${g.via.tolerant}, after a re-ask ${g.via.reask}); no usable verdict ${g.noVerdicts.length}${reasons ? ` (${reasons})` : ""}; the Game Master ended ${g.exitedScenes.length} scene(s)`;
  }, ["S-01"]);

  await rec.run("S-05", () => {
    const limit = o.maxFallbacks;
    if (limit !== null) {
      ensure(summary.fallbackLines <= limit, `${summary.fallbackLines} canned fallback line(s), more than --max-fallbacks ${limit}`);
      return `${summary.fallbackLines} canned fallback line(s) of ${summary.npcReplies} AI replies (limit ${limit})`;
    }
    return summary.fallbackLines === 0
      ? `0 canned fallback lines of ${summary.npcReplies} AI replies`
      : `WARNING: ${summary.fallbackLines} canned fallback line(s) of ${summary.npcReplies} AI replies (no --max-fallbacks limit given)`;
  }, ["S-01"]);

  await rec.run("S-06", () => {
    const calls = [...sys!.npc!.calls, ...sys!.gm!.calls];
    ensure(sys!.npc!.calls.length > 0 && sys!.gm!.calls.length > 0, "no model call was captured (the audit would be vacuous)");
    const banned = [...markers.rubric, ...markers.hidden, ...Object.values(markers.secretsByRole).flat(), ...PARTICIPANT_NAMES];
    const npcRoles = Object.values(scenario.roles).filter((r): r is NpcRole => r.type === "npc");
    // A hidden fact is allowed in exactly one place: the "## What you may now share" section of the prompt of the character it was released to.
    const released = releasedFacts(events());
    let shared = 0;
    for (const req of calls) {
      const owner = npcRoles.find((r) => req.system.includes(npcIntro(r)));
      const cut = owner ? req.system.indexOf(SHARE_SECTION) : -1;
      const head = cut >= 0 ? req.system.slice(0, cut) : req.system;
      const tail = cut >= 0 ? req.system.slice(cut) : "";
      const mine = [...(owner ? released.get(owner.id) ?? [] : [])];
      const found = findMarkers(`${head}\n${JSON.stringify(req.messages)}`, banned);
      ensure(found.length === 0, `a model prompt contained: ${found.join(" | ")}`);
      const foundShared = findMarkers(tail, banned.filter((b) => !mine.some((f) => f.includes(b))));
      ensure(foundShared.length === 0, `${owner?.id}'s "What you may now share" section contained: ${foundShared.join(" | ")}`);
      if (mine.some((f) => tail.includes(f))) shared++;
    }
    // Positive control: a fact that was released and whose character spoke afterwards must have reached that character's own prompt.
    for (const rel of releaseEvents(events())) {
      const spokeAfter = events().some((e) => e.type === "utterance" && e.roleId === rel.roleId && e.seq > rel.seq);
      const role = npcRoles.find((x) => x.id === rel.roleId)!;
      const reached = sys!.npc!.calls.some((c) => { const at = c.system.indexOf(SHARE_SECTION); return c.system.includes(npcIntro(role)) && at >= 0 && c.system.slice(at).includes(rel.text); });
      ensure(!spokeAfter || reached, `hidden fact #${rel.fact} of ${rel.roleId} was released but never reached that character's prompt (vacuous audit)`);
    }
    // Another AI character's persona, goals, knowledge, hidden facts, guardrails and voice lists must not be in a character's system prompt (only name, title and seniority are public). Text both characters hold is exempt.
    const privateOf = (r: NpcRole): string[] => [r.persona, ...r.goals, ...r.knowledge, ...r.hidden, ...r.guardrails, ...r.responds_with, ...r.only_you_say].map((x) => x.trim()).filter((x) => x.length >= 12);
    let crossChecked = 0;
    for (const req of sys!.npc!.calls) {
      const owner = npcRoles.find((r) => req.system.includes(npcIntro(r)));
      if (!owner) continue;
      const own = new Set(privateOf(owner));
      const foreign = npcRoles.filter((r) => r !== owner).flatMap(privateOf).filter((x) => !own.has(x));
      const leaked = foreign.filter((x) => req.system.includes(x));
      ensure(leaked.length === 0, `${owner.id}'s prompt contained another AI character's private text: ${leaked.map((x) => x.slice(0, 60)).join(" | ")}`);
      crossChecked++;
    }
    const npcs = npcRoles as { persona: string }[];
    ensure(npcs.every((p) => sys!.npc!.calls.some((c) => c.system.includes(p.persona.slice(0, 20)))), "an AI character's own persona is missing from its prompts (vacuous audit)");
    const conditions = scenario.script.scenes.flatMap((s) => s.exit_when.any_of).filter((c): c is { gm_detects: string } => typeof c === "object").map((c) => c.gm_detects);
    ensure(sys!.gm!.calls.every((c) => conditions.some((cond) => c.system.includes(cond))), "a Game Master prompt lacks the scene's condition (vacuous audit)");
    const nReleased = [...released.values()].reduce((a, v) => a + v.length, 0);
    return `all ${calls.length} captured prompts (${sys!.npc!.calls.length} AI character, ${sys!.gm!.calls.length} Game Master) were checked against ${banned.length} strings (and ${crossChecked} AI character prompts against the other characters' private text); none appeared, and the positive controls did${nReleased > 0 ? `; ${nReleased} released hidden fact(s) appeared only in the "What you may now share" section of their own character's prompt (${shared} prompt(s)), never in another character's, a player's or the Game Master's` : "; no hidden fact was released, so none appeared in any prompt"}`;
  }, ["S-01"]);

  await rec.run("S-07", () => {
    const by = new Map<string, string[]>();
    let audited = 0;
    for (const [role] of ROLE_PLAYERS) {
      const bot = st.players[role as PlayerId]!;
      const text = JSON.stringify(bot.inbox);
      audited += bot.inbox.length;
      for (const e of bot.events()) ensure(!["npc.updated", "gm.decision", "gm.no_verdict", "facilitator.alert"].includes(e.type), `${role} received a ${e.type} event`);
      ensure(!bot.events().some((e) => e.type === "facilitator.command" && e.command === "release_hidden"), `${role} received a hidden-fact release command`);
      ensure(!text.includes("participantId"), `${role} received a participantId`);
      const names = findMarkers(text, PARTICIPANT_NAMES);
      ensure(names.length === 0, `${role} saw participant names: ${names.join(", ")}`);
      const others = Object.entries(markers.secretsByRole).filter(([r]) => r !== role).flatMap(([, v]) => v);
      let leaked: string[];
      if (mock) leaked = findMarkers(text, [...others, ...markers.npcInternals, ...markers.hidden, ...markers.rubric]);
      else {
        // A live model (an AI character or a generated player) may recite its OWN material aloud: that is its behaviour, not a server leak. So everything the server
        // sends apart from utterances is checked in full, and an utterance is checked for a string only when its speaker does not own that string.
        // Hidden-fact and rubric strings said aloud are not failures here; they are counted and reported as an observation once, below.
        const msgs = bot.inbox.filter((m) => !(m.type === "event" && m.event.type === "utterance"));
        const said = bot.inbox.filter((m): m is Extract<Inbound, { type: "event" }> => m.type === "event" && m.event.type === "utterance");
        const speaker = (m: Extract<Inbound, { type: "event" }>) => (m.event as Extract<SessionEvent, { type: "utterance" }>).roleId;
        const notBy = (owners: string[]) => JSON.stringify([...msgs, ...said.filter((m) => !owners.includes(speaker(m)))]);
        const hiddenOrRubric = new Set([...markers.hidden, ...markers.rubric]);
        leaked = findMarkers(JSON.stringify(msgs), [...hiddenOrRubric]);
        for (const m of markers.npcInternals.filter((x) => !hiddenOrRubric.has(x))) leaked.push(...findMarkers(notBy(npcOwnersOf(m)), [m]));
        for (const [owner, facts] of Object.entries(markers.secretsByRole).filter(([r]) => r !== role)) leaked.push(...findMarkers(notBy([owner]), facts));
      }
      ensure(leaked.length === 0, `${role} received text it must not see: ${leaked.join(" | ")}`);
      const injectLeaks = findInjectLeaks(text, role, scenario.script.scenes);
      ensure(injectLeaks.length === 0, `${role} saw inject ${injectLeaks.join(", ")}, which is not addressed to them`);
      ensure(JSON.stringify(st.joined[role as PlayerId]).includes(markers.secretsByRole[role]![0]!.slice(0, 20)), `${role}'s own brief is missing (vacuous audit)`);
      by.set(role, others);
    }
    if (!mock) {
      // Observation only. A match is NOT a recital: an unreleased hidden fact never enters any prompt, a released one is meant to be said, and a string a player said earlier in the
      // same scene is an echo of that player. See hiddenFactMatches for what is counted.
      const matched = hiddenFactMatches(events(), scenario, markers);
      for (const [r, c] of matched) {
        const parts = [
          ...(c.phrases > 0 ? [`${c.phrases} phrase(s) shared with the scenario's hidden-fact or rubric text`] : []),
          ...(c.facts > 0 ? [`${c.facts} whole hidden fact(s) word for word`] : []),
        ].join(" and ");
        const msg = scenario.roles[r]?.type === "npc"
          ? `AI character ${r}: ${parts} appear in its lines (an echo of an earlier line or common wording, not a recital: an unreleased hidden fact is never in a prompt)`
          : `${r}: ${parts} appear in its lines (a generated player or a scripted line; not counted as a leak, the server only delivered what was said)`;
        observations.push(msg); ctx.n.line(`Observation: ${msg}`);
      }
    }
    ensure(JSON.stringify(fac.inbox).includes("ZedAlphaParticipant"), "the facilitator never saw participant names (the control)");
    ensure(events().some((e) => e.type === "gm.decision"), "the facilitator saw no gm.decision (the control)");
    const count = [...by.values()].reduce((a, v) => a + v.length, 0) + markers.npcInternals.length + markers.rubric.length;
    return `${audited} messages in 3 players' whole inboxes audited against ${count} real scenario strings, ${PARTICIPANT_NAMES.length} names and inject scopes: nothing leaked`;
  }, ["S-01"]);

  await rec.run("S-08", () => {
    for (const line of ctx.outputTap) ensure(!UNSAFE_CHARS.test(line.replace(SGR, "")), "the narration contains a control or bidi character");
    let strings = 0;
    const walk = (v: unknown): void => {
      if (typeof v === "string") { strings++; ensure(!UNSAFE_CHARS.test(v), "the report contains a control or bidi character"); }
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(summary);
    return `${ctx.outputTap.length} narration lines and ${strings} report strings hold no control or bidi characters (colour codes aside)`;
  });

  await rec.run("S-09", async () => {
    const text = await readFile(sys!.logFile, "utf8");
    const disk = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as SessionEvent);
    const problems = logShapeProblems(disk, ctx.sessionId);
    ensure(problems.length === 0, `the log is malformed: ${problems.join("; ")}`);
    ensure(disk.length > 0 && disk[0]!.seq === 1, "the log does not start at seq 1");
    const seen = events();
    ensure(seen.length === disk.length, `the facilitator saw ${seen.length} events but the log holds ${disk.length}`);
    ensure(disk.every((e, i) => JSON.stringify(e) === JSON.stringify(seen[i])), "an event on disk differs from what the facilitator received");
    return `${disk.length} events on disk: seq 1..${disk.length} without gaps, identical to the facilitator's stream`;
  }, ["S-01"]);

  await rec.run("S-10", async () => {
    const names = await readdir(ctx.tmp!.dataDir).catch(() => [] as string[]);
    const files = names.filter((x) => x.endsWith(".jsonl")).map((x) => path.join(ctx.tmp!.dataDir, x));
    const haystacks: [string, string][] = [
      ...(await Promise.all(files.map(async (f) => [`log ${path.basename(f)}`, await readFile(f, "utf8").catch(() => "")] as [string, string]))),
      ...ctx.bots.map((b) => [`inbox of ${b.label}`, JSON.stringify(b.inbox)] as [string, string]),
      ["narration", ctx.outputTap.join("\n")],
      ["host log", [...sys!.hostLog, ...sys!.serverLog].join("\n")],
      ["report", JSON.stringify(summary)],
    ];
    for (const [what, hay] of haystacks) ensure(findMarkers(hay, ctx.secretValues).length === 0, `a secret value appeared in the ${what}`);
    return `${ctx.secretValues.length} secret value(s) are absent from ${haystacks.length} places: the session log, every client's inbox, the narration, the server logs and the report`;
  }, ["S-01"]);

  await rec.run("S-11", () => {
    ensure(sys!.hostLog.length === 0, `background failures were reported: ${sys!.hostLog.slice(0, 2).join(" | ")}`);
    const bad = sys!.serverLog.filter((l) => /^(error:|handler failed|send failed|ping failed|server error)/.test(l));
    ensure(bad.length === 0, `the server logged: ${bad.slice(0, 2).join(" | ")}`);
    return `the host reported no background failure and the server logged no handler, send or internal error (${sys!.serverLog.length} routine lines)`;
  });

  await rec.run("S-13", () => {
    const notes: string[] = [];
    for (const sc of summary.scenes) {
      if (sc.playerLines > 0) continue;
      ensure(sc.exitReason === "gm_detects" || sc.exitReason === "time_box_elapsed", `scene ${sc.id} was entered and left by ${sc.exitReason ?? "nothing"} without a single scripted line (it was skipped)`);
      const note = `${sc.id} ended by ${sc.exitReason} before its first scripted line`;
      observations.push(note); notes.push(note);
    }
    ensure(summary.scenes.length === scenario.script.scenes.length, `only ${summary.scenes.length} of ${scenario.script.scenes.length} scenes were played`);
    return notes.length ? `no scene was skipped; ${notes.join("; ")}` : `all ${summary.scenes.length} scenes had at least one scripted line spoken in them`;
  }, ["S-01"]);

  await rec.run("S-14", () => {
    const dry = [...(sys!.npc!.exhausted ?? []), ...(sys!.gm!.exhausted ?? [])];
    ensure(dry.length === 0, `a scripted queue ran dry (${dry.slice(0, 3).join(", ")}): the default reply was served`);
    if (o.maxLines === null) {
      const advanced = summary.scenes.filter((s) => s.exitReason === "facilitator_advance").map((s) => s.id);
      ensure(advanced.length === 0, `scene(s) ${advanced.join(", ")} ended by facilitator advance (the mock script should end each by verdict or time box; --max-lines allows it)`);
    }
    return "every scripted reply and verdict came from the script and no scene needed the facilitator advance";
  }, ["S-01"]);

  if (o.players) {
    const { generator, lines: playerLines } = o.players;
    await rec.run("S-15", () => {
      ensure(generator.calls.length > 0, "no player prompt was captured (the audit would be vacuous)");
      const base = [...markers.rubric, ...markers.hidden, ...markers.npcInternals, ...PARTICIPANT_NAMES];
      const spokenAloud = events().filter((e): e is Extract<SessionEvent, { type: "utterance" }> => e.type === "utterance").map((e) => e.text).join("\n");
      generator.calls.forEach((req, i) => {
        const role = generator.callRoles[i]!;
        const others = Object.entries(markers.secretsByRole).filter(([r]) => r !== role).flatMap(([, v]) => v);
        // The system prompt holds only the role's own material; the conversation turns are other people's speech (not secrets) but never carry NPC or rubric text.
        // The system prompt lists the role's OWN last lines: a string it said itself is not a leak.
        const ownSaid = events().filter((e): e is Extract<SessionEvent, { type: "utterance" }> => e.type === "utterance" && e.roleId === role).map((e) => e.text).join("\n");
        const inSystem = findMarkers(req.system, [...base, ...others].filter((m) => !ownSaid.includes(m)));
        ensure(inSystem.length === 0, `a ${role} prompt contained: ${inSystem.join(" | ")}`);
        // Turns are other people's speech plus the scripted intent: a string a participant SAID aloud (a hidden-fact fragment from a player's own words) is not a prompt leak.
        const inTurns = findMarkers(JSON.stringify(req.messages), base.filter((m) => !spokenAloud.includes(m)));
        ensure(inTurns.length === 0, `a ${role} conversation turn contained: ${inTurns.join(" | ")}`);
        ensure(req.system.includes(markers.secretsByRole[role]![0]!.slice(0, 20)), `${role}'s own brief is missing from its prompt (vacuous audit)`);
      });
      const spoken = summary.lines.filter((l) => l.source === "player-bot");
      ensure(spoken.length === playerLines.records.length, `${spoken.length} player lines were spoken but ${playerLines.records.length} were recorded`);
      const generated = spoken.filter((l) => l.tag === "generated").length;
      const claimed = playerLines.records.filter((r) => r.source === "generated").length;
      ensure(generated === claimed, `${generated} lines are tagged generated but the runner recorded ${claimed} generated lines`);
      ensure(spoken.every((l) => l.tag === "generated" || l.tag === "scripted"), "a player line has a tag other than generated or scripted");
      return `${generator.calls.length} player prompts checked against ${base.length} shared strings (every hidden fact, released or not, unless a participant said it aloud) and each role's other-role secrets: none appeared; ${generated} generated and ${spoken.length - generated} scripted player lines are tagged as recorded`;
    }, ["S-01"]);
  }

  if (o.evaluate) {
    const ev = o.evaluate;
    await ctx.n.heading("EVALUATION: feedback reports for the session", { record: false });
    await rec.run("S-16", async () => {
      ctx.n.line(ev.mock ? "The evaluator is scripted in a mock run (offline, deterministic): the scores are demo data, not a real assessment." : "The evaluator sends the session transcript to the configured model provider.", false);
      const outcome = await ev.run(sys!.logFile, ctx.signal);
      o.holder.evaluation = outcome;
      for (const l of summaryLines(outcome.result)) ctx.n.line(l, false);
      ctx.n.line(`reports written to ${scrubText(outcome.written.dir)} (index.md links them all)`, false);
      for (const f of outcome.result.failures) observations.push(`evaluation failed: ${f}`);
      const players = Object.values(scenario.roles).filter((r) => r.type === "player").length;
      ensure(outcome.written.participants.length === players, `${outcome.written.participants.length} personal reports for ${players} players`);
      const ok = outcome.result.participants.filter((p) => p.status === "ok").length;
      ensure(ok > 0, "no participant could be evaluated (every report says evaluation failed or insufficient evidence)");
      if (ev.mock) ensure(outcome.result.failures.length === 0, `the scripted evaluator failed: ${outcome.result.failures.join(" | ")}`);
      const v = await verifyReportFiles(outcome.written.dir, await readSessionLog(sys!.logFile), scenario);
      ensure(v.problems.length === 0, `the report files have problems: ${v.problems.slice(0, 3).join("; ")}`);
      const dropped = outcome.result.participants.reduce((a, p) => a + p.criteria.reduce((b, c) => b + c.droppedQuotes, 0), 0);
      return `${ok} of ${players} players evaluated; ${v.reports} reports (${players} players and the group) in ${outcome.written.files.length} files: ${v.quotes} quotes are verbatim lines of the session, ${v.scores} scores are 1 to 4 or Not observed, the method and the visibility line are in every report; ${dropped} unverifiable quote(s) were dropped; ${outcome.result.modelCalls} model call(s)`;
    }, ["S-01"]);
  }

  if (!mock) {
    await rec.run("S-18", async () => {
      const g = summary.gm;
      const total = summary.scenes.length;
      const asked = g.evaluations + g.noVerdicts.length;
      const reasons = Object.entries(g.noVerdictByReason).map(([k, v]) => `${k} ${v}`).join(", ");
      // An EARLY exit (before the scripted agreement): the Game Master ended the scene at or before the last scripted line after which the labelled negative controls say the
      // condition is not yet met. Always reported. Only scenes WITHOUT AI characters are gated (in a scene with AI characters their live replies can legitimately meet the condition).
      const hasNpc = (id: string) => scenario.script.scenes.find((s) => s.id === id)!.participants.some((p) => scenario.roles[p]?.type === "npc");
      const early = summary.scenes.filter((s) => s.exitReason === "gm_detects" && lastNegativeLine(scenario.meta.id, s.id) > 0 && s.playerLines <= lastNegativeLine(scenario.meta.id, s.id));
      const gated = o.players ? [] : early.filter((s) => !hasNpc(s.id));
      const label = (s: { id: string; playerLines: number }) => `${s.id} after ${s.playerLines} line(s)${hasNpc(s.id) ? ", with AI characters" : ""}`;
      const evidence = `the Game Master ended ${g.exitedScenes.length} of ${total} scenes (${g.exitedScenes.length === total ? "all" : `the others: ${summary.scenes.filter((s) => s.exitReason !== "gm_detects").map((s) => `${s.id} by ${s.exitReason ?? "nothing"}`).join(", ")}`}); `
        + `early exits (before the scripted agreement) ${early.length}${early.length ? ` (${early.map(label).join(", ")}; in scenes without AI characters ${early.filter((s) => !hasNpc(s.id)).length}; an early exit in a scene with AI characters may be legitimate: their live replies can meet the condition)` : ""}; `
        + `${g.evaluations} usable verdicts (${g.verdictsTrue} true, ${g.verdictsFalse} false; read strictly ${g.via.strict}, tolerantly ${g.via.tolerant}, after a re-ask ${g.via.reask}); `
        + `no usable verdict ${g.noVerdicts.length} of ${asked} evaluations${reasons ? ` (${reasons})` : ""}; ${g.reasks} re-ask(s)`;
      if (o.minGmExits != null) ensure(g.exitedScenes.length >= o.minGmExits, `${evidence}; --min-gm-exits ${o.minGmExits} needs at least ${o.minGmExits}`);
      if (o.maxFalseExits != null) {
        // The labels behind "early" must still match the script, or the count means nothing.
        const have = JSON.stringify((await loadCases(path.join(ctx.repoRoot, "tests", "gm-cases")).catch(() => [] as GmCase[])).filter((c) => c.source.startsWith("showcase:")));
        ensure(have === JSON.stringify(buildShowcaseCases(scenario, o.script)), `the labelled cases in tests/gm-cases are missing or out of date with the showcase script, so early exits cannot be judged: run \`pnpm gm-eval --build tests/gm-cases\``);
        ensure(gated.length <= o.maxFalseExits, `${evidence}; --max-false-exits ${o.maxFalseExits} allows at most ${o.maxFalseExits} early exit(s) in scenes without AI characters (${gated.length}${o.players ? "; not gated with generated players" : ""})`);
      }
      return evidence;
    }, ["S-01"]);
  }

  await rec.run("S-12", () => {
    const took = ctx.now() - o.startedMs;
    ensure(took <= o.watchdogMs, `the run took ${Math.round(took / 1000)} s, more than its ${o.watchdogMinutes} minute limit`);
    return `finished in ${(took / 1000).toFixed(1)} s of the ${o.watchdogMinutes} minute limit`;
  });
}

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { SessionEvent } from "@acr/events";
import type { Scenario } from "@acr/script";
import { isEvent, type Inbound } from "./bots.js";
import { UNSAFE_CHARS, buildMarkers, ensure, findInjectLeaks, findMarkers, logShapeProblems, type CheckDef, type Markers } from "./checks.js";
import {
  PARTICIPANT_NAMES, ROLE_PLAYERS, connectBot, errCode, isJoinedMsg, settle, withTimeout, type Ctx, type PlayerId, type Story,
} from "./ctx.js";
import { MIN } from "./harness.js";
import { fallbackReason } from "./provenance.js";
import { buildShowcaseReport, clip, formatAiSummary, type ShowcaseReport } from "./showcase-report.js";
import { expectedGmEvaluations, type ShowcaseScript } from "./showcase-script.js";

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
] as const;

export type ShowcaseHolder = {
  /** Builds the report from what the facilitator has seen so far (also usable after a failure or an abort). */
  snapshot?: () => ShowcaseReport;
  report?: ShowcaseReport;
};

export type ShowcaseOptions = {
  script: ShowcaseScript;
  mode: "mock" | "live";
  maxLines: number | null;
  maxFallbacks: number | null;
  watchdogMinutes: number;
  watchdogMs: number;
  provider?: string;
  /** The AI characters' reply deadline: bounds every wait for a model in a live run. */
  replyTimeoutMs: number;
  startedMs: number;
  holder: ShowcaseHolder;
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

/** An upper bound of the model calls a run makes: one reply per AI character per line, plus the Game Master's evaluations. */
export function expectedModelCalls(scenario: Scenario, script: ShowcaseScript, maxLines: number | null): { npc: number; gm: number } {
  let npc = 0; let gm = 0;
  for (const scene of scenario.script.scenes) {
    const n = scene.participants.filter((p) => scenario.roles[p]?.type === "npc").length;
    const lines = linesFor(script, scene.id, maxLines).length;
    npc += n * lines;
    gm += expectedGmEvaluations(scene, lines, n);
  }
  return { npc, gm };
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

const NARRATION_CHARS = 600;
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
    watchdogMinutes: o.watchdogMinutes, observations, provider: o.provider,
  });
  o.holder.snapshot = snapshot;

  // ---- narration: events are printed in order, as they arrive, labelled by who produced them ----------------
  let chain: Promise<void> = Promise.resolve();
  let fallbackNext = false;
  const narrateEvent = async (e: SessionEvent): Promise<void> => {
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
      case "npc.updated": await n.tagged("system", "dim", "", `${e.roleId} updated: ${e.goals.length} goals, ${e.knowledge.length} knowledge items`); break;
      case "utterance": {
        const role = scenario.roles[e.roleId];
        if (role?.type === "npc") {
          const canned = fallbackNext; fallbackNext = false;
          await n.tagged("AI character", "cyan", `${role.name} (${role.id}${canned ? ", canned fallback line" : ""})`, clip(e.text, NARRATION_CHARS));
        } else await n.tagged("player bot", "green", e.roleId, clip(e.text, NARRATION_CHARS));
        break;
      }
      case "gm.decision":
        await n.tagged("Game Master", "yellow", `${e.verdict ? "TRUE" : "FALSE"} for "${clip(e.condition, 160)}"`, clip(e.reasoning, 300));
        break;
      case "facilitator.alert": {
        const why = fallbackReason(e.message);
        if (why !== null) fallbackNext = true;
        await n.tagged("alert", e.level === "warning" ? "red" : "yellow", "", why !== null ? `${e.message.split(":")[0]!.replace(/^NPC /, "AI character ")} fell back to its canned line: ${why}` : clip(e.message, 300));
        break;
      }
      case "facilitator.command": await n.tagged("system", "dim", "", `facilitator: ${e.command}`); break;
      case "session.ended": await n.tagged("system", "yellow", "", `session ended (${e.reason})`); break;
      default: break;
    }
  };
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
  ctx.tr?.attach(fac, { scenario, provider: o.mode, sceneHeadings: true });
  const narrate = (m: Inbound) => { if (m.type === "event") { const e = m.event; chain = chain.then(() => narrateEvent(e)).catch(() => undefined); } };
  const prior = fac.onMessage;
  fac.onMessage = (m) => { prior?.(m); narrate(m); };

  const waitSettled = async (npcCount: number, gmConditions: number): Promise<void> => {
    const bound = mock ? 20_000 : npcCount * o.replyTimeoutMs + gmConditions * Math.max(o.replyTimeoutMs, 60_000) + 10_000;
    await withTimeout(settle(ctx, st), bound, "the AI characters and the Game Master to finish");
    await flush();
  };
  const exited = (sceneId: string) => fac.events().some((e) => e.type === "scene.exited" && e.sceneId === sceneId);

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

    for (const [i, line] of lines.entries()) {
      if (exited(scene.id)) break; // the Game Master (or the time box) ended the scene early: the rest of its lines stay unspoken
      if (mock && sys?.fakeClock && i === 1 && timedAt > 0) {
        const entered = fac.events().find((e) => e.type === "scene.entered" && e.sceneId === scene.id)!;
        const delta = entered.ts + timedAt * MIN - sys.clock.now();
        if (delta > 0) { sys.fakeClock.advance(delta); await n.note(`the fake clock moves to minute ${timedAt} of the scene, so its timed injects fire`); }
      }
      const bot = st.players[line.role as PlayerId]!;
      const from = bot.mark();
      bot.send({ type: "say", text: line.text });
      const r = await bot.waitFor((m) => m.type === "error" || isEvent("utterance", (e) => e.roleId === line.role && e.text === line.text)(m), { from, timeoutMs: 15_000, what: `${line.role}'s line to be accepted` });
      if (r.type === "error") {
        if (r.code === "not_in_scene" || r.code === "stale_scene") { observations.push(`${line.role}'s line was refused (${r.code}): scene ${scene.id} had already ended`); break; }
        throw new Error(`${line.role}'s line was refused: ${errCode(r)}`);
      }
      await waitSettled(npcCount, gmConditions);
    }

    if (!exited(scene.id)) {
      // The safety net: the scripted lines are used up and the scene is still open.
      observations.push(`GM did not exit; facilitator advanced (${scene.id})`);
      await n.note("the scripted lines are used up and the Game Master has not ended the scene: the facilitator advances");
      const from = fac.mark();
      fac.send({ type: "command", command: { command: "advance" } });
      const r = await fac.waitFor((m) => m.type === "error" || isEvent("facilitator.command", (e) => e.command === "advance")(m), { from, timeoutMs: 15_000, what: "advance to be accepted" });
      ensure(r.type === "event", `facilitator advance was refused: ${errCode(r)}`);
      await waitSettled(npcCount, gmConditions);
    }
  }
  await fac.waitFor(isEvent("session.ended"), { timeoutMs: 15_000, what: "the session to end" });
  await flush();
  await settle(ctx, st);
  await flush();

  // ---- the summary ---------------------------------------------------------------------------------------
  const summary = snapshot();
  await n.heading("SUMMARY");
  const [title, ...rest] = formatAiSummary(summary);
  n.styled(title!, "bold");
  for (const l of rest) n.line(l, false);
  o.holder.report = summary;
  await playShowcaseAudit(ctx, st, o, summary);
}

/** The showcase's checks, run after the story: they need the whole run to be over. */
async function playShowcaseAudit(ctx: Ctx, st: Story, o: ShowcaseOptions, summary: ShowcaseReport): Promise<void> {
  const { rec, sys, scenario } = ctx;
  const mock = o.mode === "mock";
  const fac = st.fac!;
  const markers = ctx.markers;
  await ctx.n.heading("AUDIT: what the whole run proves");
  if (sys) { await sys.host.idle(); }
  const events = (): SessionEvent[] => fac.events();
  const npcIds = Object.values(scenario.roles).filter((r) => r.type === "npc").map((r) => r.id);

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
        ensure(said.length > 0, `${id} never spoke in ${scene.id}`);
        ensure(said.every((l) => l.text.trim().length > 0), `${id} produced an empty utterance in ${scene.id}`);
        parts.push(`${id}@${scene.id}:${said.length}`);
      }
    }
    ensure(parts.length > 0, "the scenario has no scene with an AI character (the check would be vacuous)");
    return `${summary.npcReplies} AI replies; every character spoke in every scene it is in (${parts.join(", ")})`;
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
    return `${summary.gm.evaluations} gm.decision events (${summary.gm.verdictsTrue} true, ${summary.gm.verdictsFalse} false); the Game Master ended ${summary.gm.exitedScenes.length} scene(s)`;
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
    for (const req of calls) {
      const found = findMarkers(`${req.system}\n${JSON.stringify(req.messages)}`, banned);
      ensure(found.length === 0, `a model prompt contained: ${found.join(" | ")}`);
    }
    const npcs = Object.values(scenario.roles).filter((r) => r.type === "npc") as { persona: string }[];
    ensure(npcs.every((p) => sys!.npc!.calls.some((c) => c.system.includes(p.persona.slice(0, 20)))), "an AI character's own persona is missing from its prompts (vacuous audit)");
    const conditions = scenario.script.scenes.flatMap((s) => s.exit_when.any_of).filter((c): c is { gm_detects: string } => typeof c === "object").map((c) => c.gm_detects);
    ensure(sys!.gm!.calls.every((c) => conditions.some((cond) => c.system.includes(cond))), "a Game Master prompt lacks the scene's condition (vacuous audit)");
    return `all ${calls.length} captured prompts (${sys!.npc!.calls.length} AI character, ${sys!.gm!.calls.length} Game Master) were checked against ${banned.length} strings; none appeared, and the positive controls did`;
  }, ["S-01"]);

  await rec.run("S-07", () => {
    const by = new Map<string, string[]>();
    let audited = 0;
    for (const [role] of ROLE_PLAYERS) {
      const bot = st.players[role as PlayerId]!;
      const text = JSON.stringify(bot.inbox);
      audited += bot.inbox.length;
      for (const e of bot.events()) ensure(!["npc.updated", "gm.decision", "facilitator.alert"].includes(e.type), `${role} received a ${e.type} event`);
      ensure(!text.includes("participantId"), `${role} received a participantId`);
      const names = findMarkers(text, PARTICIPANT_NAMES);
      ensure(names.length === 0, `${role} saw participant names: ${names.join(", ")}`);
      const others = Object.entries(markers.secretsByRole).filter(([r]) => r !== role).flatMap(([, v]) => v);
      const leaked = findMarkers(text, [...others, ...markers.npcInternals, ...markers.hidden, ...markers.rubric]);
      ensure(leaked.length === 0, `${role} received text it must not see: ${leaked.join(" | ")}`);
      const injectLeaks = findInjectLeaks(text, role, scenario.script.scenes);
      ensure(injectLeaks.length === 0, `${role} saw inject ${injectLeaks.join(", ")}, which is not addressed to them`);
      ensure(JSON.stringify(st.joined[role as PlayerId]).includes(markers.secretsByRole[role]![0]!.slice(0, 20)), `${role}'s own brief is missing (vacuous audit)`);
      by.set(role, others);
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

  await rec.run("S-12", () => {
    const took = ctx.now() - o.startedMs;
    ensure(took <= o.watchdogMs, `the run took ${Math.round(took / 1000)} s, more than its ${o.watchdogMinutes} minute limit`);
    return `finished in ${(took / 1000).toFixed(1)} s of the ${o.watchdogMinutes} minute limit`;
  });
}

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { SessionEvent } from "@acr/events";
import { bootstrap } from "../main.js";
import { isEvent, type Inbound } from "./bots.js";
import { assertRotatedOnly, ensure, findInjectLeaks, findMarkers, logShapeProblems, missingMarkers, sceneTrace } from "./checks.js";
import {
  PARTICIPANT_NAMES, ROLE_PLAYERS, act, codeSecrets, connectBot, got, isJoinedMsg, npcRole, sceneIds, utterancesByScene,
  type Ctx, type PlayerId, type Story,
} from "./ctx.js";
import { FAKE_KEY } from "./harness.js";

const WHISPER_MARK = "WHISPER-ONLY-FOR-DELIVERY-LEAD";
const FACILITATOR_ONLY = ["npc.updated", "gm.decision", "gm.no_verdict", "facilitator.alert"];
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** The final act: everything that needs the whole run to be over. */
export async function playAudit(ctx: Ctx, st: Story): Promise<void> {
  const { rec, n, sys } = ctx;
  const [s1] = sceneIds(ctx.scenario) as [string];
  const npc = npcRole(ctx.scenario);
  const story = ["F-01"];
  const ended = ["F-25"];

  await act(ctx, st, 7, "Audit: what the whole run proves", async () => {
    if (sys) { await sys.host.idle(); await sys.stop(); }
    const fac = st.fac;
    const events = (): SessionEvent[] => fac?.events() ?? [];

    await rec.run("F-14", async () => {
      const mid = got<{ recorded: boolean; unchanged: boolean }>(st.ev.stale, "the mid-run stale-verdict probe");
      ensure(!mid.recorded && mid.unchanged, "a verdict for an ended scene was recorded while the session ran");
      const seq = sys!.engine.state.lastSeq;
      const after = await sys!.engine.recordGmVerdict("ended probe", true, "probe");
      ensure(!after && seq === sys!.engine.state.lastSeq, "a verdict was recorded after the session ended");
      return `a verdict bound to the ended scene ${s1} was refused and appended nothing, mid-run and again after the session ended`;
    }, ["F-25"]);

    await rec.run("F-16", () => {
      const ev = events();
      const i = ev.findIndex((e) => e.type === "scene.exited" && e.reason === "facilitator_advance");
      ensure(i >= 0, "no scene was ended by a facilitator advance");
      const next = ev.slice(i + 1).find((e) => e.type === "scene.entered" || e.type === "session.ended");
      ensure(next, "nothing followed the advance");
      const exited = ev[i] as Extract<SessionEvent, { type: "scene.exited" }>;
      let lab = "";
      if (rec.applicable("F-10")) {
        got(st.ev.labAdvance, "the side room's scene 1 -> 2 advance");
        lab = "; in the side room an advance moved scene 1 to scene 2";
      }
      return `advance ended ${exited.sceneId} and was followed by ${next.type === "scene.entered" ? `scene.entered ${next.sceneId}` : "session.ended"}${lab}`;
    }, ended);

    await rec.run("F-17", () => {
      got(st.ev.whisper, "the whisper step");
      const target = st.players.delivery_lead!;
      const heard = target.events().some((e) => e.type === "facilitator.command" && e.command === "whisper" && e.text.includes(WHISPER_MARK));
      ensure(heard, "the target never received the whisper");
      const others = ROLE_PLAYERS.filter(([r]) => r !== "delivery_lead");
      let audited = 0;
      for (const [role] of others) {
        const bot = st.players[role]!;
        audited += bot.inbox.length;
        ensure(!JSON.stringify(bot.inbox).includes(WHISPER_MARK), `${role}'s inbox contains the whisper`);
        ensure(!bot.events().some((e) => e.type === "facilitator.command" && e.command === "whisper"), `${role} saw a whisper event`);
      }
      ensure(events().some((e) => e.type === "facilitator.command" && e.command === "whisper"), "the facilitator's stream lacks the whisper (the control)");
      return `only delivery_lead received the whisper (${audited} messages in the other players' whole inboxes audited); whispering ${npc.id} was refused with npc_role`;
    }, ended);

    await rec.run("F-18", () => {
      const absent = missingMarkers(ctx.scenario, ctx.markers);
      ensure(absent.length === 0, `the audit markers are not in the scenario files: ${absent.join(", ")}`);
      const by = utterancesByScene(events());
      let audited = 0;
      let markerCount = 0;
      for (const [role] of ROLE_PLAYERS) {
        const bot = st.players[role as PlayerId]!;
        const text = JSON.stringify(bot.inbox);
        audited += bot.inbox.length;
        for (const e of bot.events()) ensure(!FACILITATOR_ONLY.includes(e.type), `${role} received a ${e.type} event`);
        ensure(!text.includes("participantId"), `${role} received a participantId`);
        const names = findMarkers(text, PARTICIPANT_NAMES);
        ensure(names.length === 0, `${role} saw participant names: ${names.join(", ")}`);
        const others = Object.entries(ctx.markers.secretsByRole).filter(([r]) => r !== role).flatMap(([, v]) => v);
        const leaked = findMarkers(text, [...others, ...ctx.markers.npcInternals, ...ctx.markers.hidden, ...ctx.markers.rubric]);
        ensure(leaked.length === 0, `${role} received text it must not see: ${leaked.join(" | ")}`);
        markerCount += others.length;
        // Injects addressed to others, and the lines of scenes this role is not in.
        const injectLeaks = findInjectLeaks(text, role, ctx.scenario.script.scenes);
        ensure(injectLeaks.length === 0, `${role} saw inject ${injectLeaks.join(", ")}, which is not addressed to them`);
        for (const scene of ctx.scenario.script.scenes) {
          if (!scene.participants.includes(role)) {
            ensure(!bot.events().some((e) => e.type === "scene.entered" && e.sceneId === scene.id), `${role} saw scene ${scene.id} start`);
            for (const u of by[scene.id] ?? []) if (u.text.length >= 12) ensure(!text.includes(JSON.stringify(u.text).slice(1, -1)), `${role} saw a line from scene ${scene.id}`);
          }
        }
        // Positive control: they did receive their own material.
        ensure(JSON.stringify(st.joined[role as PlayerId]).includes(ctx.markers.secretsByRole[role]![0]!.slice(0, 20)), `${role}'s own brief is missing (vacuous audit)`);
      }
      const f = events();
      ensure(f.some((e) => e.type === "npc.updated"), "the facilitator saw no npc.updated (the control)");
      ensure(JSON.stringify(st.fac!.inbox).includes("ZedAlphaParticipant"), "the facilitator never saw participant names (the control)");
      return `${audited} messages in 3 players' whole inboxes audited against ${markerCount + ctx.markers.npcInternals.length + ctx.markers.rubric.length} real scenario strings, ${PARTICIPANT_NAMES.length} names and scene/inject scopes: nothing leaked`;
    }, story);

    await rec.run("F-19", () => {
      const calls = [...sys!.npc!.calls, ...sys!.gm!.calls];
      ensure(calls.length === 10, `expected 4 NPC and 6 Game Master model calls (one of them the re-ask), saw ${calls.length}`);
      const banned = [...ctx.markers.rubric, ...ctx.markers.hidden, ...Object.values(ctx.markers.secretsByRole).flat(), ...PARTICIPANT_NAMES, WHISPER_MARK];
      for (const req of calls) {
        const found = findMarkers(`${req.system}\n${JSON.stringify(req.messages)}`, banned);
        ensure(found.length === 0, `a model prompt contained: ${found.join(" | ")}`);
      }
      const gmCond = ctx.scenario.script.scenes[0]!.exit_when.any_of.find((c): c is { gm_detects: string } => typeof c === "object")!.gm_detects;
      ensure(sys!.npc!.calls[0]!.system.includes(npc.persona.slice(0, 20)), "the NPC's own persona is missing from its prompt (vacuous audit)");
      ensure(sys!.gm!.calls[0]!.system.includes(gmCond), "the scene's condition is missing from the Game Master prompt (vacuous audit)");
      return `all ${calls.length} captured prompts (${sys!.npc!.calls.length} NPC, ${sys!.gm!.calls.length} Game Master) were checked against ${banned.length} strings; none appeared, and the positive controls did`;
    }, ended);

    await rec.run("F-26", async () => {
      const text = await readFile(sys!.logFile, "utf8");
      const disk = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as SessionEvent);
      const problems = logShapeProblems(disk, ctx.sessionId);
      ensure(problems.length === 0, `the log is malformed: ${problems.join("; ")}`);
      ensure(disk.length > 0 && disk[0]!.seq === 1, "the log does not start at seq 1");
      const seen = events();
      ensure(seen.length === disk.length, `the facilitator saw ${seen.length} events but the log holds ${disk.length}`);
      ensure(disk.every((e, i) => JSON.stringify(e) === JSON.stringify(seen[i])), "an event on disk differs from what the facilitator received");
      return `${disk.length} events on disk: seq 1..${disk.length} without gaps, ts and sessionId on every event, identical to the facilitator's stream`;
    }, story);

    await rec.run("F-27", () => {
      const ev = events();
      ensure(ev.length > 0 && ev[0]!.type === "session.started", "the stream does not start with session.started");
      ev.forEach((e, i) => ensure(e.seq === i + 1, `the facilitator's stream has a gap at event ${i + 1}`));
      const ends = ev.filter((e) => e.type === "session.ended");
      ensure(ends.length === 1 && ev.at(-1)!.type === "session.ended", "session.ended must appear exactly once, last");
      const ids = sceneIds(ctx.scenario);
      const trace = sceneTrace(ev);
      ensure(trace[0] === `entered:${ids[0]}`, "the first scene was not entered first");
      ensure(trace.at(-1) === "ended:script_complete", "the stream does not end with script_complete");
      const expected = ctx.kind === "mock"
        ? [`entered:${ids[0]}`, `exited:${ids[0]}:gm_detects`, `entered:${ids[1]}`, `exited:${ids[1]}:gm_detects`, `entered:${ids[2]}`, `exited:${ids[2]}:facilitator_advance`, "ended:script_complete"]
        : null;
      if (expected) ensure(JSON.stringify(trace) === JSON.stringify(expected), `scene trace was ${trace.join(" > ")}`);
      else trace.forEach((t, i) => { if (t.startsWith("exited:")) ensure(trace[i - 1]?.startsWith("entered:" + t.split(":")[1]), `${t} did not follow its own entry`); });
      return `scene trace: ${trace.join(" > ")}`;
    }, ended);

    // Restart: stop done above; start a fresh server on the same session id and data dir.
    await rec.run("F-24", async () => {
      const file = sys!.logFile;
      const before = await readFile(file);
      const logs: string[] = [];
      const shown: { roleId: string; code: string }[][] = [];
      const r = await bootstrap({
        env: { RUNTIME_PORT: "0", SESSION_ID: ctx.sessionId, MODEL_PROVIDER: "mock", ANTHROPIC_API_KEY: FAKE_KEY },
        root: ctx.tmp!.root, logDir: ctx.tmp!.dataDir, now: () => new Date("2030-01-02T03:04:05Z"), log: (m) => logs.push(m), warn: (m) => logs.push(m), tickMs: 60_000,
        showJoinCodes: (c) => { shown.push(c); ctx.secretValues.push(...codeSecrets(Object.fromEntries(c.map((x) => [x.roleId, x.code])))); },
      });
      ensure(r.ok, `the restarted server did not start: ${r.ok ? "" : r.errors.join("; ")}`);
      // US-0033: the real server issues one join code per player role, shows them once outside its log and stores only their hashes.
      ensure(shown.length === 1 && JSON.stringify(shown[0]!.map((c) => c.roleId).sort()) === JSON.stringify(ROLE_PLAYERS.map(([role]) => role).sort()), "the restarted server did not show one join code per player role exactly once");
      ensure(findMarkers(logs.join("\n"), codeSecrets(Object.fromEntries(shown[0]!.map((x) => [x.roleId, x.code])))).length === 0, "a join code appeared in the server's log lines");
      ctx.register(() => r.runtime.stop().catch(() => undefined));
      ctx.labLogs.push(...logs);
      const rotatedName = `${ctx.sessionId}.20300102T030405Z.jsonl`;
      const rotated = await readFile(path.join(ctx.tmp!.dataDir, rotatedName));
      ensure(sha(rotated) === sha(before) && rotated.equals(before), "the rotated log differs from the original");
      assertRotatedOnly(await readdir(ctx.tmp!.dataDir), ctx.sessionId, rotatedName);
      const f2 = await connectBot(ctx, "restart facilitator", { url: `ws://127.0.0.1:${r.runtime.port}` });
      const j = await f2.call({ type: "join_facilitator", sessionId: ctx.sessionId }, isJoinedMsg, { what: "the restarted server" });
      ensure(isJoinedMsg(j), "the facilitator could not join the restarted server");
      f2.send({ type: "start" });
      const started = await f2.waitFor(isEvent("session.started"), { what: "the new session's start" });
      const first = (started as Extract<Inbound, { type: "event" }>).event;
      ensure(first.seq === 1, `the new session started at seq ${first.seq}`);
      const fresh = (await readFile(file, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as SessionEvent);
      ensure(fresh[0]?.seq === 1 && fresh[0].type === "session.started", "the new log does not start at seq 1");
      ensure((await readFile(path.join(ctx.tmp!.dataDir, rotatedName))).equals(before), "the rotated log changed after the restart");
      ensure(logs.some((l) => l.includes("moved aside")), "the restart did not report the rotation");
      f2.close();
      await r.runtime.stop();
      await n.step(`restart on the same session id: the old log moved aside as ${rotatedName}, byte for byte; the new session began at seq 1`);
      return `old log (${before.length} bytes) rotated aside byte-identical as <id>.<UTC time>.jsonl; the restarted session began at seq 1; the real server showed ${shown[0]!.length} player join codes once, outside its log`;
    }, ["F-26"]);

    await rec.run("F-28", async () => {
      const files = [sys!.logFile, ...(await listLogs(ctx)), ...(await listCodeFiles(ctx))];
      const haystacks: [string, string][] = [
        ...(await Promise.all(files.map(async (f) => [`log ${path.basename(f)}`, await readFile(f, "utf8").catch(() => "")] as [string, string]))),
        ...ctx.bots.map((b) => [`inbox of ${b.label}`, JSON.stringify(b.inbox)] as [string, string]),
        ["narration", ctx.outputTap.join("\n")],
        ["host log", [...sys!.hostLog, ...sys!.serverLog, ...ctx.labLogs].join("\n")],
      ];
      for (const [what, hay] of haystacks) {
        const found = findMarkers(hay, ctx.secretValues);
        ensure(found.length === 0, `a secret value appeared in the ${what}`);
      }
      return `${ctx.secretValues.length} secret value(s) (a fake API key, passed through the env of the restarted bootstrap() server in F-24, every player join code the demo's servers issued, plus any key-like values in the runner's own environment) are absent from ${haystacks.length} places: every session log and join codes file on disk (the old, rotated and new ones), every client's inbox, the narration so far and the server logs`;
    }, ["F-24"]);

    await rec.run("F-29", () => {
      const host = [...sys!.hostLog, ...ctx.labHostLog];
      ensure(host.length === 0, `background failures were reported: ${host.slice(0, 2).join(" | ")}`);
      const bad = [...sys!.serverLog, ...ctx.labLogs].filter((l) => /^(error:|handler failed|send failed|ping failed|server error)/.test(l));
      ensure(bad.length === 0, `the server logged: ${bad.slice(0, 2).join(" | ")}`);
      return `the hosts reported no background failure and the servers logged no handler, send or internal error (${sys!.serverLog.length} routine lines)`;
    });
  }, { always: true });
}

/** US-0033: the join codes files the restarted server wrote (hashes only: F-28 proves no code is in them). */
async function listCodeFiles(ctx: Ctx): Promise<string[]> {
  const names = await readdir(ctx.tmp!.dataDir).catch(() => [] as string[]);
  return names.filter((x) => x.endsWith(".codes.json")).map((x) => path.join(ctx.tmp!.dataDir, x));
}

async function listLogs(ctx: Ctx): Promise<string[]> {
  const names = await readdir(ctx.tmp!.dataDir).catch(() => [] as string[]);
  return names.filter((x) => x.endsWith(".jsonl")).map((x) => path.join(ctx.tmp!.dataDir, x));
}

import { cp, mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { activeElapsedMs, type SessionEvent, type SessionState } from "@acr/events";
import type { Scenario } from "@acr/script";
import { FakeClock } from "../engine/clock.js";
import { SessionStoreError } from "../engine/session-store.js";
import { isEvent, type Bot } from "./bots.js";
import { ensure } from "./checks.js";
import { act, connectBot, isJoinedMsg, npcRole, sceneIds, type Ctx, type Joined, type Story } from "./ctx.js";
import { GatedProvider, MIN, T0, startResumableSystem, type ResumableSystem } from "./harness.js";

/** How long the server stays down in the room: longer than what is left of the scene's time box, and past its timed inject. */
export const RESUME_DOWNTIME_MS = 20 * MIN;
/** How far into scene 2 the crash happens. */
export const CRASH_AT_MS = 4 * MIN;
const SID = "resume";
const HISTORY_LINE = "Before the call: we offer a phased plan, nothing is free.";
const LINE_1 = "Priya, we can deliver the module in a second phase.";
const REPLY_1 = "A second phase? Tell me what Finance gets on day one.";
const PENDING_LINE = "Day one gets a manual tie-out report; the module follows in four weeks.";
const NEVER = "This reply was still being generated when the server died.";
const ANSWER_AFTER = "A manual report on day one could work. Put it in writing.";

/** The parts of the state a crash must not change (the resume adds only the pause). */
const durable = (s: SessionState) => ({ lastSeq: s.lastSeq, roles: s.roles, currentScene: s.currentScene, sceneHistory: s.sceneHistory, transcript: s.transcript, injectsFired: s.injectsFired, npcs: s.npcs, gmVerdicts: s.gmVerdicts, advanceRequested: s.advanceRequested });
const lines = async (file: string) => (await readFile(file, "utf8")).split("\n").filter(Boolean);
const evs = async (file: string) => (await lines(file)).map((l) => JSON.parse(l) as SessionEvent);

/**
 * The resume room (act 6c, `pnpm demo --resume`, US-0018): a server is killed in the middle of scene 2 while the AI character is still
 * thinking about a player's line, and restarted on the same log after 20 minutes. Then what a restart must refuse: another scenario, a
 * corrupt log, a log another server holds; and the two ways a log is moved aside: SESSION_START=fresh, and a session that had ended.
 * Everything runs on the real session store (lock, fsync, resume, rotation), a fake clock and scripted models, in a private temp dir.
 */
export async function playResumeRoom(ctx: Ctx, st: Story): Promise<void> {
  if (!ctx.rec.has("F-34") || !ctx.rec.applicable("F-34")) return; // opt-in: pnpm demo --resume
  const { rec, n } = ctx;
  const scenario = ctx.scenario;
  const [s1, s2] = sceneIds(scenario) as [string, string];
  const npc = npcRole(scenario);
  const scene2 = scenario.script.scenes.find((x) => x.id === s2)!;
  const timed = (scene2.injects ?? []).find((i) => i.at_minute !== undefined)!;
  const injectAtMs = timed.at_minute! * MIN;
  const timeBoxMs = scene2.time_box_minutes * MIN;

  await act(ctx, st, "6c", "Resume room: a crash in the middle of a scene, a restart, and what a restart must refuse", async () => {
    const root = path.join(ctx.tmp!.root, "resume-room");
    const dir = path.join(root, "sessions");
    const logFile = path.join(dir, `${SID}.jsonl`);
    const systems: ResumableSystem[] = [];
    let closed = false;
    const stopAll = async () => { if (closed) return; closed = true; for (const s of systems.reverse()) await s.stop().catch(() => undefined); };
    ctx.register(stopAll);
    const start = async (o: Omit<Parameters<typeof startResumableSystem>[0], "scenario" | "sessionId" | "dataDir"> & { scenario?: Scenario; dataDir?: string }) => {
      const s = await startResumableSystem({ scenario, sessionId: SID, dataDir: dir, now: () => new Date("2030-03-04T05:06:07Z"), ...o });
      systems.push(s);
      return s;
    };
    const url = (s: ResumableSystem) => `ws://127.0.0.1:${s.port}`;
    const joinFac = async (s: ResumableSystem, label: string) => {
      const fac = await connectBot(ctx, label, { url: url(s) });
      const j = await fac.call({ type: "join_facilitator", sessionId: SID }, isJoinedMsg, { what: `${label} to join` });
      ensure(isJoinedMsg(j), `${label} could not join`);
      return { fac, joined: j };
    };
    const joinPlayer = async (s: ResumableSystem, role: string, who: string): Promise<{ bot: Bot; joined: Joined }> => {
      const bot = await connectBot(ctx, `resume ${role}`, { url: url(s) });
      const j = await bot.call({ type: "join", sessionId: SID, roleId: role, participantId: who }, isJoinedMsg, { what: `${role} to join` });
      ensure(isJoinedMsg(j), `${role} could not join: ${j.type === "error" ? j.code : j.type}`);
      return { bot, joined: j };
    };

    // ---- life 1: play into scene 2 and die while the AI character is still answering ------------------------------------------
    const clockA = new FakeClock(T0);
    const npcA = new GatedProvider([REPLY_1, NEVER], 2);
    const a = await start({ clock: clockA, npcProvider: npcA });
    await n.step("a server starts on a fresh session log (the real session store: lock, fsync after each event, owner-only files)");
    const { fac: facA } = await joinFac(a, "resume facilitator");
    const dlA = await joinPlayer(a, "delivery_lead", "ZedAlphaParticipant");
    await joinPlayer(a, "tech_lead", "ZedBravoParticipant");
    const amA = await joinPlayer(a, "account_manager", "ZedCharlieParticipant");
    facA.send({ type: "start" });
    await facA.waitFor(isEvent("scene.entered", (e) => e.sceneId === s1), { what: "scene 1" });
    await a.host.start(); // resolves once the start has fully finished (players may speak from then on)
    dlA.bot.send({ type: "say", text: HISTORY_LINE });
    await facA.waitFor(isEvent("utterance", (e) => e.text === HISTORY_LINE), { what: "the scene 1 line" });
    facA.send({ type: "command", command: { command: "advance" } });
    await facA.waitFor(isEvent("scene.entered", (e) => e.sceneId === s2), { what: "scene 2" });
    clockA.advance(CRASH_AT_MS); await a.engine.tick();
    dlA.bot.send({ type: "say", text: LINE_1 });
    await facA.waitFor(isEvent("utterance", (e) => e.roleId === npc.id && e.text === REPLY_1), { what: `${npc.name}'s first reply` });
    amA.bot.send({ type: "say", text: PENDING_LINE });
    await facA.waitFor(isEvent("utterance", (e) => e.text === PENDING_LINE), { what: "the line that will go unanswered" });
    await npcA.holding;
    const before = structuredClone(a.engine.state);
    const activeBefore = activeElapsedMs(before, clockA.now());
    await n.step(`scene 2 is ${CRASH_AT_MS / MIN} minutes in; account_manager has just spoken and ${npc.name} is still thinking about it`);
    await a.crash();
    npcA.release(); // the model answers after the crash: that reply can never be recorded
    await a.host.idle();
    const bytesAtCrash = await readFile(logFile);
    await n.step(`the server dies (simulated in this process: its connections are cut, its lock and log are abandoned, nothing is cleaned up) and stays down for ${RESUME_DOWNTIME_MS / MIN} minutes`);
    ensure(!(await lines(logFile)).some((l) => l.includes(NEVER)), "a reply generated after the crash reached the log");

    // ---- life 2: the restart -----------------------------------------------------------------------------------------------------
    const clockB = new FakeClock(clockA.now() + RESUME_DOWNTIME_MS);
    const npcB = new GatedProvider([ANSWER_AFTER]);
    const b = await start({ clock: clockB, npcProvider: npcB });

    await rec.run("F-34", async () => {
      ensure(b.store.outcome === "resumed", `the restart did not resume (outcome ${b.store.outcome})`);
      ensure(b.engine.state.paused, "the resumed session is not paused");
      ensure(b.engine.state.lastSeq === before.lastSeq + 2, `expected exactly two new events (session.resumed and the alert), the log went from seq ${before.lastSeq} to ${b.engine.state.lastSeq}`);
      const restored = { ...durable(b.engine.state), lastSeq: before.lastSeq };
      ensure(JSON.stringify(restored) === JSON.stringify(durable(before)), "the restored state differs from the state at the crash");
      const now = await readFile(logFile);
      ensure(now.subarray(0, bytesAtCrash.length).equals(bytesAtCrash), "the events from before the crash changed on disk");
      const added = (await evs(logFile)).slice(before.lastSeq);
      ensure(JSON.stringify(added.map((e) => e.type)) === JSON.stringify(["session.resumed", "facilitator.alert"]), `the restart appended ${added.map((e) => e.type).join(", ")}`);
      const active = activeElapsedMs(b.engine.state, clockB.now());
      ensure(active === activeBefore, `the scene clock moved during the downtime: ${active} ms active, ${activeBefore} ms at the crash`);
      ensure(b.store.lock.verify(), "the restarted server does not hold the session lock");
      const { fac, joined } = await joinFac(b, "resume facilitator (after restart)");
      ensure(joined.state?.paused === true, "the facilitator's snapshot does not show the session paused");
      ensure(fac.inbox.length > 0, "no answer");
      st.ev.resumeFac = { ok: true, value: fac };
      await n.step(`restart: the session is rebuilt from its log, PAUSED, with ${Math.round((timeBoxMs - active) / 1000)} s of scene 2 left (as at the crash); the dead server's lock was taken over`);
      return `restored from ${before.lastSeq} logged events to the same state, byte-identical log prefix, then session.resumed + a facilitator alert; paused with ${(active / MIN).toFixed(0)} of ${scene2.time_box_minutes} minutes used, as at the crash, after ${RESUME_DOWNTIME_MS / MIN} minutes of downtime; the stale lock of the dead server was taken over`;
    });
    const facB = (st.ev.resumeFac?.ok ? st.ev.resumeFac.value : null) as Bot | null;

    await rec.run("F-37", async () => {
      const dl = await joinPlayer(b, "delivery_lead", "ZedAlphaParticipant");
      const am = await joinPlayer(b, "account_manager", "ZedCharlieParticipant");
      const tl = await joinPlayer(b, "tech_lead", "ZedDeltaParticipant"); // someone else: claims are not kept across a restart
      const texts = (j: Joined) => (j.state?.transcript ?? []).map((u) => u.text);
      for (const p of [dl, am]) {
        const t = texts(p.joined);
        ensure(JSON.stringify(t) === JSON.stringify([HISTORY_LINE, LINE_1, REPLY_1, PENDING_LINE]), `${p.bot.label} rejoined with history ${JSON.stringify(t)}`);
        ensure(p.joined.state?.paused === true, `${p.bot.label} does not see the session paused`);
      }
      ensure(JSON.stringify(texts(tl.joined)) === JSON.stringify([HISTORY_LINE]), `tech_lead (not in scene 2) got ${JSON.stringify(texts(tl.joined))}`);
      for (const p of [dl, am, tl]) {
        const raw = JSON.stringify(p.bot.inbox);
        ensure(!raw.includes("resumed after a server restart") && !raw.includes("npcs\":{\""), `${p.bot.label} received facilitator-only data`);
        for (const h of npc.hidden) ensure(!raw.includes(h), `${p.bot.label} received hidden-fact text`);
      }
      st.ev.resumePlayers = { ok: true, value: [dl.bot, am.bot] };
      await n.step("the players rejoin (anyone may claim a role again, as after any disconnect) and each gets the history it may see: tech_lead, who was not on the call, gets none of it");
      return "delivery_lead and account_manager rejoined with their 4 visible lines (scene 1 and the call); tech_lead, claimed by a new participant, got only scene 1; no facilitator-only data or hidden-fact text reached a player";
    }, ["F-34"]);

    await rec.run("F-36", async () => {
      ensure(facB, "no facilitator on the restarted server");
      ensure(npcB.calls.length === 0, `${npc.name} answered before the facilitator resumed`);
      const from = facB.mark();
      facB.send({ type: "command", command: { command: "resume" } });
      await facB.waitFor(isEvent("utterance", (e) => e.roleId === npc.id), { from, what: `${npc.name}'s answer after /resume` });
      await b.host.idle();
      for (const command of ["pause", "resume"] as const) {
        const at = facB.mark();
        facB.send({ type: "command", command: { command } });
        await facB.waitFor(isEvent("facilitator.command", (e) => e.command === command), { from: at, what: `the second ${command}` });
      }
      await b.host.idle();
      const all = await evs(logFile);
      const pendingSeq = all.find((e) => e.type === "utterance" && e.text === PENDING_LINE)!.seq;
      const answers = all.filter((e) => e.seq > pendingSeq && e.type === "utterance" && e.roleId === npc.id);
      ensure(answers.length === 1 && answers[0]!.type === "utterance" && answers[0]!.text === ANSWER_AFTER, `expected one answer to the pending line, got ${answers.length}`);
      const asked = (): number => npcB.calls.length;
      ensure(asked() === 1, `${npc.name} was asked ${asked()} times`);
      ensure(all.some((e) => e.type === "facilitator.alert" && e.message === "answering the last player line from before the restart"), "no alert said the pending line is being answered");
      ensure(!all.some((e) => e.type === "utterance" && e.text === NEVER), "the reply lost in the crash was recorded");
      await n.say(npc.id, ANSWER_AFTER);
      await n.step(`/resume: ${npc.name} answers the line that was left unanswered by the crash, exactly once (a second pause and resume asks nothing)`);
      return `the player line pending at the crash was answered exactly once, after /resume (1 model call; none before it, none on a second pause/resume); the reply lost in the crash never reached the log`;
    }, ["F-34"]);

    await rec.run("F-35", async () => {
      await b.engine.tick();
      const fired = () => b.engine.state.injectsFired.filter((x) => x === timed.id).length;
      ensure(fired() === 0, `${timed.id} fired on /resume although it was due during the downtime`);
      ensure(b.engine.state.currentScene?.id === s2, "the scene ended on its time box on /resume");
      const left = injectAtMs - activeElapsedMs(b.engine.state, clockB.now());
      clockB.advance(left - 1); await b.engine.tick();
      ensure(fired() === 0, `${timed.id} fired before its minute of active time`);
      clockB.advance(1); await b.engine.tick(); await b.engine.tick();
      ensure(fired() === 1, `${timed.id} fired ${fired()} times at its minute`);
      ensure(b.engine.state.currentScene?.id === s2, "the scene ended early");
      await n.step(`nothing that came due during the ${RESUME_DOWNTIME_MS / MIN} minutes of downtime fires on /resume: ${timed.id} fires once, at minute ${timed.at_minute} of ACTIVE time`);
      return `${timed.id} (minute ${timed.at_minute}) did not fire on /resume after ${RESUME_DOWNTIME_MS / MIN} minutes of downtime; it fired exactly once at minute ${timed.at_minute} of active time, and the ${scene2.time_box_minutes} minute scene did not end early`;
    }, ["F-34"]);
    for (const s of [facB, ...((st.ev.resumePlayers?.ok ? st.ev.resumePlayers.value : []) as Bot[])]) s?.close();

    // ---- what a restart refuses -----------------------------------------------------------------------------------------------
    await b.crash();
    const atRefusal = await readFile(logFile);
    await rec.run("F-38", async () => {
      const edited: Scenario = { ...scenario, meta: { ...scenario.meta, title: `${scenario.meta.title} (edited after the session started)` } };
      const err = await start({ clock: new FakeClock(clockB.now()), scenario: edited }).then(() => null, (e: unknown) => e);
      ensure(err instanceof SessionStoreError && err.code === "resume_refused", `a log of another scenario was not refused: ${err instanceof Error ? err.message : "it resumed"}`);
      ensure(/sha256 differs/.test(err.message) && /SESSION_START=fresh/.test(err.message), `the refusal does not explain itself: ${err.message}`);
      ensure((await readFile(logFile)).equals(atRefusal), "the refused log changed");
      ensure(!(await readdir(dir)).includes(`${SID}.lock`), "the refused start left a lock behind");
      await n.step("a restart with changed scenario files is refused (the log records the scenario's sha256); the log is untouched and the operator is told about SESSION_START=fresh");
      return "a restart against an edited scenario was refused (sha256 differs), naming SESSION_START=fresh; the log stayed byte-identical and no lock was left";
    }, ["F-34"]);

    await rec.run("F-39", async () => {
      const corrupt = path.join(root, "corrupt"); const cut = path.join(root, "cut");
      for (const d of [corrupt, cut]) { await mkdir(d, { recursive: true }); await cp(logFile, path.join(d, `${SID}.jsonl`)); }
      const ls = await lines(path.join(corrupt, `${SID}.jsonl`));
      ls[4] = ls[4]!.slice(0, 20);
      const broken = ls.join("\n") + "\n";
      await writeFile(path.join(corrupt, `${SID}.jsonl`), broken);
      const err = await start({ clock: new FakeClock(clockB.now()), dataDir: corrupt }).then(() => null, (e: unknown) => e);
      ensure(err instanceof SessionStoreError && err.code === "resume_refused" && /at line 5/.test(err.message), `a log broken in the middle was not refused: ${err instanceof Error ? err.message : "it resumed"}`);
      ensure((await readFile(path.join(corrupt, `${SID}.jsonl`), "utf8")) === broken, "the corrupt log was changed");
      const tail = '{"seq":999,"ts":1,"type":"utter';
      const cutFile = path.join(cut, `${SID}.jsonl`);
      await writeFile(cutFile, (await readFile(cutFile, "utf8")) + tail);
      const c = await start({ clock: new FakeClock(clockB.now()), dataDir: cut });
      const cutEvents = await evs(cutFile);
      ensure(c.store.outcome === "resumed" && c.store.resume?.partialTailBytes === tail.length, "a cut-off last line was not repaired");
      ensure(!(await readFile(cutFile, "utf8")).includes(tail) && cutEvents.at(-1)?.type === "facilitator.alert", "the cut-off line is still in the log");
      await c.stop();
      await n.step("a log broken in the middle is refused (line 5) and left as it is; a cut-off LAST line (a crash mid-write) is cut, with a warning, and the session resumes");
      return `corruption at line 5 was refused and the file left byte-identical; a ${tail.length}-byte cut-off last line was cut (and reported) and that session resumed`;
    }, ["F-34"]);

    await rec.run("F-40", async () => {
      const f = await start({ clock: new FakeClock(clockB.now()), mode: "fresh" });
      ensure(f.store.outcome === "rotated" && f.store.rotatedBecause === "fresh" && f.store.rotatedTo, `SESSION_START=fresh did not move the log aside (${f.store.outcome})`);
      ensure((await readFile(f.store.rotatedTo!)).equals(atRefusal), "the rotated log differs from the old one");
      ensure(!(await readdir(dir)).includes(`${SID}.jsonl`), "a log remained in place");
      const { fac } = await joinFac(f, "fresh facilitator");
      fac.send({ type: "start" });
      const startedMsg = await fac.waitFor(isEvent("session.started"), { what: "the fresh session" });
      ensure(startedMsg.type === "event" && startedMsg.event.seq === 1, "the fresh session did not start at seq 1");
      for (const cmd of ["advance", "advance", "advance"] as const) {
        const from = fac.mark();
        fac.send({ type: "command", command: { command: cmd } });
        await fac.waitFor((m) => m.type === "event" && (m.event.type === "scene.entered" || m.event.type === "session.ended"), { from, what: "the next scene" });
      }
      await fac.waitFor(isEvent("session.ended"), { what: "the end of the fresh session" });
      fac.close();
      await f.stop();
      await n.step(`SESSION_START=fresh moves the running session's log aside byte for byte (${path.basename(f.store.rotatedTo!)}) and starts a new session at seq 1`);
      return `SESSION_START=fresh rotated the old log byte-identical to ${path.basename(f.store.rotatedTo!).replace(/\d{8}T\d{6}Z/, "<UTC time>")}; the new session began at seq 1 (and was played to its end for F-41)`;
    }, ["F-34"]);

    await rec.run("F-41", async () => {
      const endedBytes = await readFile(logFile);
      ensure((await evs(logFile)).at(-1)?.type === "session.ended", "the session to restart over has not ended");
      const g = await start({ clock: new FakeClock(clockB.now()) });
      ensure(g.store.outcome === "rotated" && g.store.rotatedBecause === "ended", `a restart over an ended session did not move its log aside (${g.store.outcome})`);
      ensure((await readFile(g.store.rotatedTo!)).equals(endedBytes), "the ended session's log changed when it was moved aside");
      ensure(g.engine.state.status === "idle", "the restart did not start fresh");
      st.ev.resumeHolder = { ok: true, value: g };
      await n.step("a restart over a session that had ENDED moves its log aside and starts fresh (there is nothing to resume)");
      return "the default restart (resume) over an ended session's log moved it aside byte-identical and started a fresh, idle session";
    }, ["F-40"]);

    await rec.run("F-42", async () => {
      const holder = st.ev.resumeHolder?.ok ? (st.ev.resumeHolder.value as ResumableSystem) : await start({ clock: new FakeClock(clockB.now()) });
      const refused = async (what: string, o: Partial<Parameters<typeof start>[0]>, why: RegExp) => {
        const listing = JSON.stringify((await readdir(dir)).sort());
        const err = await start({ clock: new FakeClock(clockB.now()), ...o }).then(() => null, (e: unknown) => e);
        ensure(err instanceof SessionStoreError && err.code === "lock", `${what} was not refused by the lock: ${err instanceof Error ? err.message : "it started"}`);
        ensure(why.test(err.message), `${what}: the refusal does not say why: ${err.message}`);
        ensure(JSON.stringify((await readdir(dir)).sort()) === listing, `${what}: a refused start changed the data directory`);
      };
      await refused("a second server in this process", {}, /already open in this server process/);
      ensure(holder.store.lock.verify(), "the holder lost its lock");
      await holder.stop();
      // Another server (another host sharing the directory) holds the session: its lock has a fresh heartbeat.
      const lockFile = path.join(dir, `${SID}.lock`);
      await writeFile(lockFile, JSON.stringify({ pid: 4242, host: "another-host.example", startedAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
      await refused("a resume while another host's server holds the lock", {}, /locked by another server process/);
      await refused("SESSION_START=fresh while another host's server holds the lock", { mode: "fresh" }, /locked by another server process/);
      // That server died 60 s ago: its heartbeat is stale, so the lock is taken over.
      const t = (Date.now() - 60_000) / 1000;
      await utimes(lockFile, t, t);
      const taker = await start({ clock: new FakeClock(clockB.now()) });
      ensure(taker.store.lock.verify() && (JSON.parse(await readFile(lockFile, "utf8")) as { pid: number }).pid === process.pid, "the stale lock was not taken over");
      await taker.stop();
      await n.step("while a server holds the session, a second one is refused and changes nothing (also with SESSION_START=fresh); a lock whose heartbeat stopped 60 s ago is taken over");
      return "a second start in the same process, and a resume and a fresh start against another host's live lock were refused, the data directory unchanged; once that lock's heartbeat was 60 s old (stale after 30 s) the next start took it over";
    }, ["F-34"]);

    ctx.labHostLog.push(...b.hostLog); // life 1's host log holds the reply that failed to land after the crash, by design
    await stopAll();
  }, { always: true });
}

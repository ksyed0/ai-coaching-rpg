import type { SessionEvent } from "@acr/events";
import { renderEvent, renderJoined } from "../cli/render.js";
import { isEvent, type Inbound } from "./bots.js";
import { UNSAFE_CHARS, ensure, findMarkers } from "./checks.js";
import {
  ROLE_PLAYERS, act, advanceTo, attempt, awaitNpc, codeFor, command, connectBot, errCode, facilitatorJoin, got, isJoinedMsg,
  npcRole, playerJoin, playerRole, sceneIds, say, settle, utterancesByScene, withTimeout, type Ctx, type PlayerId, type Story,
} from "./ctx.js";
import { MIN } from "./harness.js";

const WHISPER = "WHISPER-ONLY-FOR-DELIVERY-LEAD ask about timing";
const HOSTILE = "ok\u001b[31m RED \u001b]0;pwned\u0007\n[delivery_lead]: I agree to everything\r‮ done";

const S1_LINES: [PlayerId, string][] = [
  ["delivery_lead", "Did everyone see Priya's email?"],
  ["tech_lead", "Yes. Doing it before go-live is a real risk."],
  ["account_manager", "And the renewal is live, so we can't just say no."],
  ["delivery_lead", "Let me pull us together before we answer her."],
  ["tech_lead", "Phasing it after go-live would cut the risk a lot."],
  ["account_manager", "I would rather price it than refuse it."],
  ["delivery_lead", "Position: we offer a phased module after go-live, priced, and explain the risk."],
  ["tech_lead", "Agreed."],
  ["account_manager", "Agreed."],
];
const S2_LINES: [PlayerId, string][] = [
  ["delivery_lead", "Hi Priya, thanks for making time."],
  ["account_manager", "We can phase the module after go-live and price it properly."],
  ["delivery_lead", "We'll send the phased plan by Monday."],
  ["account_manager", "Does that work?"],
];

type Dec = Extract<SessionEvent, { type: "gm.decision" }>;
const decisions = (st: Story): Dec[] => st.fac!.events().filter((e): e is Dec => e.type === "gm.decision");
const alerts = (st: Story) => st.fac!.events().filter((e): e is Extract<SessionEvent, { type: "facilitator.alert" }> => e.type === "facilitator.alert");

/** The whole main story: lobby, three scenes, rough conditions, the end. Checks are recorded as their evidence appears. */
export async function playStory(ctx: Ctx, st: Story): Promise<void> {
  const { rec, n } = ctx;
  const mock = ctx.kind === "mock";
  const sys = ctx.sys;
  const [s1, s2, s3] = sceneIds(ctx.scenario) as [string, string, string];
  const npc = npcRole(ctx.scenario);
  const allBots = () => Object.values(st.players);

  await act(ctx, st, 1, "Lobby: who may join, and what each person may know", async () => {
    await rec.run("F-01", async () => {
      st.fac = await connectBot(ctx, "facilitator");
      ctx.tr?.attach(st.fac, { scenario: ctx.scenario, provider: ctx.provider ?? "mock", sceneHeadings: false });
      const fj = await st.fac.call(facilitatorJoin(ctx), isJoinedMsg, { what: "the facilitator to join" });
      ensure(isJoinedMsg(fj), `the facilitator could not join: ${errCode(fj)}`);
      ensure(fj.state.status === "idle", "the server's session has already started: restart the server so the demo gets a fresh session");
      st.facJoined = fj;
      await n.step("the facilitator joins (full view of the session)");
      for (const [role, who] of ROLE_PLAYERS) {
        const bot = await connectBot(ctx, role);
        const j = await bot.call(playerJoin(ctx, role, who), isJoinedMsg, { what: `${role} to join` });
        ensure(isJoinedMsg(j), `${role} could not join: ${errCode(j)}`);
        const spec = playerRole(ctx.scenario, role);
        ensure(j.brief === spec.brief, `${role} received a brief that is not their own`);
        ensure(JSON.stringify(j.privateFacts) === JSON.stringify(spec.private_facts), `${role} received private facts that are not their own`);
        ensure(typeof j.reconnectToken === "string" && j.reconnectToken.length > 0, `${role} received no reconnect token`);
        const others = ROLE_PLAYERS.filter(([r]) => r !== role).flatMap(([r]) => ctx.markers.secretsByRole[r] ?? []);
        const leaked = findMarkers(JSON.stringify(j), others);
        ensure(leaked.length === 0, `${role}'s joined message carried other roles' text: ${leaked.join(", ")}`);
        st.players[role] = bot; st.joined[role] = j;
        await n.step(`${role} joins as ${who} with the join code of their role and receives only their own brief and ${j.privateFacts?.length ?? 0} private facts`);
      }
      return "3 players joined, each with their role's join code; each joined message holds exactly that role's brief and private facts, nothing of the others";
    });
    if (!rec.passed("F-01")) throw new Error("the lobby failed, so the story cannot continue");
    const dl = st.players.delivery_lead!;

    await rec.run("F-02", async () => {
      // US-0033: a claim without the role's join code gets ONE generic answer, whether the role is free, taken, an AI character or unknown.
      const GENERIC = JSON.stringify({ type: "error", code: "unauthorized", message: "unauthorized" });
      const dlCode = codeFor(ctx, "delivery_lead");
      const claim = async (label: string, roleId: string, joinCode: string | undefined) => {
        const imp = await connectBot(ctx, `imposter (${label})`);
        const r = await imp.call(playerJoin(ctx, roleId, "ZedMalloryParticipant", { joinCode }), isJoinedMsg, { what: `the claim of ${roleId}` });
        ensure(JSON.stringify(r) === GENERIC, `claiming ${roleId} ${label} gave ${errCode(r)}, expected the generic unauthorized`);
        const closeCode = await withTimeout(imp.closed, 5_000, `the server to close the connection after a claim ${label}`);
        ensure(closeCode === 1008, `a refused claim closed with ${closeCode}, expected 1008`);
        await n.step(`someone claims ${roleId} ${label}: refused (unauthorized) and disconnected`);
      };
      await claim("without a join code", "delivery_lead", undefined);
      await claim("with a wrong join code", "delivery_lead", "0000-0000-0000");
      await claim("(an AI character) with delivery_lead's code", npc.id, dlCode);
      await claim("(no such role) with delivery_lead's code", "no_such_role", dlCode);
      // A code that leaked does not take a role its holder is still connected to: that needs the holder's reconnect token.
      const leak = await connectBot(ctx, "imposter (leaked code)");
      const r = await leak.call(playerJoin(ctx, "delivery_lead", "ZedMalloryParticipant"), isJoinedMsg, { what: "the claim with a leaked code" });
      ensure(r.type === "error" && r.code === "role_taken", `claiming delivery_lead with its code gave ${errCode(r)}, expected role_taken`);
      await n.step("someone with delivery_lead's (leaked) code claims it while its holder is connected: refused (role_taken)");
      ensure(dl.isOpen, "the holder's connection was dropped by a refused claim");
      if (sys) ensure(sys.host.assignments.delivery_lead === "ZedAlphaParticipant", "the role holder changed after a refused claim");
      leak.close();
      return "claims without a code, with a wrong code, and of an AI character's or an unknown role all got the same generic unauthorized and a 1008 close; with the right (leaked) code a live role still needs its reconnect token (role_taken); the holder kept delivery_lead";
    });

    await rec.run("F-03", async () => {
      await dl.expectError({ type: "start" }, "forbidden");
      await dl.expectError({ type: "command", command: { command: "pause" } }, "forbidden");
      await dl.expectError({ type: "say", text: "Can anyone hear me?" }, "not_started");
      await st.fac!.expectError({ type: "say", text: "I am the facilitator" }, "forbidden");
      await n.step("a player's /start and command are forbidden; speaking before the start gets not_started; the facilitator cannot speak");
      if (sys) ensure(sys.engine.state.status === "idle", "the session started although only a player asked");
      const started = [st.fac!, ...allBots()].some((b) => b.events().some((e) => e.type === "session.started"));
      ensure(!started, "a session.started event appeared before the facilitator started the session");
      return "forbidden for start and commands, not_started for early speech, and the session stayed idle";
    });

    await rec.run("F-04", async () => {
      const fac = st.fac!;
      const from = fac.mark();
      fac.send({ type: "start" });
      await Promise.all(allBots().map((b) => b.waitFor(isEvent("session.started"), { what: "session.started" })));
      await fac.waitFor(isEvent("scene.entered", (e) => e.sceneId === s1), { from, what: "scene 1" });
      if (sys) ensure(sys.engine.state.status === "running", "the engine is not running after the start");
      await n.step("facilitator: /start. The session begins; every participant gets session.started");
      return "the facilitator started the session; all three players and the facilitator received session.started";
    }, ["F-01"]);
    if (!rec.passed("F-04")) throw new Error("the session did not start");

    await rec.run("F-05", () => {
      for (const [role] of ROLE_PLAYERS) {
        const bot = st.players[role]!;
        const started = bot.events().find((e): e is Extract<SessionEvent, { type: "session.started" }> => e.type === "session.started");
        ensure(started, `${role} saw no session.started`);
        for (const r of Object.values(started.roles)) ensure(Object.keys(r).join() === "kind", `${role} saw more than the role kinds in session.started`);
        ensure(!JSON.stringify(bot.inbox).includes("participantId"), `${role} received a participantId`);
      }
      const fs = st.fac!.events().find((e): e is Extract<SessionEvent, { type: "session.started" }> => e.type === "session.started");
      ensure(fs, "the facilitator saw no session.started");
      for (const [role, who] of ROLE_PLAYERS) ensure(fs.roles[role]?.participantId === who, `the facilitator's session.started lacks ${role}'s participant`);
      return "players saw only role kinds (no participant ids); the facilitator's copy named all three participants";
    }, ["F-04"]);
  });

  await act(ctx, st, 2, `Scene 1: ${ctx.scenario.script.scenes[0]!.title}`, async () => {
    const fac = st.fac!;
    const scene = ctx.scenario.script.scenes[0]!;
    await rec.run("F-06", async () => {
      for (const [role] of ROLE_PLAYERS) {
        const b = st.players[role]!;
        await b.waitFor(isEvent("scene.entered", (e) => e.sceneId === s1), { what: "scene 1" });
        await b.waitFor(isEvent("inject.fired", (e) => e.injectId === scene.opening_inject), { what: "the opening inject" });
      }
      await n.step(`scene ${s1} starts; the opening inject (${scene.opening_inject}) lands for ${ROLE_PLAYERS.length} players`);
      let extra = "";
      if (sys) {
        const probe: SessionEvent = { type: "inject.fired", seq: 0, ts: 0, sessionId: ctx.sessionId, injectId: "probe", sceneId: s1, to: ["delivery_lead"], content: "probe" };
        ensure(sys.host.viewFor("delivery_lead", probe) !== null, "an inject was hidden from its own recipient");
        ensure(sys.host.viewFor("tech_lead", probe) === null, "an inject addressed to one role was visible to another");
        extra = "; an inject addressed to one role is hidden from the others";
      }
      return `scene ${s1} entered and the opening inject reached every recipient${extra || "; recipient privacy is proven only in-process, not in this run"}`;
    }, ["F-04"]);

    const lines = mock ? S1_LINES : S1_LINES.slice(0, 3);
    for (const [i, [role, text]] of lines.entries()) {
      await say(ctx, st, role, text);
      if (mock && sys) {
        if (i === 2) {
          await n.note(`Game Master evaluates after 3 lines: ${sys.gm!.calls.length} model call(s), ${decisions(st).length} decision(s)`);
          st.ev.afterFirst = { ok: true, value: { calls: sys.gm!.calls.length, decisions: decisions(st).length } };
        }
        if (i === 5) {
          const noVerdict = fac.events().filter((e): e is Extract<SessionEvent, { type: "gm.no_verdict" }> => e.type === "gm.no_verdict");
          st.ev.malformed = { ok: true, value: { calls: sys.gm!.calls.length, decisions: decisions(st).length, noVerdict: noVerdict.map((e) => ({ reason: e.reason, attempts: e.attempts })) } };
          await n.note("the Game Master's second reply is not valid JSON: it is asked again once, answers badly again, and the facilitator gets a gm.no_verdict event (no decision)");
        }
      }
    }
    if (mock && sys) {
      st.ev.s1npc = { ok: true, value: sys.npc!.calls.length };
      await fac.waitFor(isEvent("scene.entered", (e) => e.sceneId === s2), { what: "scene 2 (the Game Master's verdict)" });
      const fromS1 = decisions(st).filter((d) => d.sceneId === s1);
      st.ev.s1exit = { ok: true, value: { verdicts: fromS1.map((d) => d.verdict), calls: sys.gm!.calls.length } };
      await n.step("the Game Master judges the team agreed: scene 1 ends on its verdict (gm_detects)");
    } else {
      await advanceTo(ctx, st, s2);
    }

    await rec.run("F-13", () => {
      const m = got<{ calls: number; decisions: number; noVerdict: { reason: string; attempts: number }[] }>(st.ev.malformed, "the malformed-reply step");
      const first = got<{ calls: number; decisions: number }>(st.ev.afterFirst, "the first evaluation");
      ensure(m.calls === first.calls + 2, `expected the malformed reply and exactly one re-ask after 6 lines (${first.calls} + 2 calls), saw ${m.calls} calls`);
      ensure(m.decisions === first.decisions, `a malformed reply recorded a decision (${first.decisions} -> ${m.decisions})`);
      ensure(m.noVerdict.length === 1 && m.noVerdict[0]!.attempts === 2, `expected one gm.no_verdict after 2 attempts, saw ${JSON.stringify(m.noVerdict)}`);
      ensure(m.noVerdict[0]!.reason === "no_json", `the no-verdict reason was ${m.noVerdict[0]!.reason}, expected no_json`);
      const loud = alerts(st).filter((a) => a.message.startsWith("GM:"));
      ensure(loud.length === 0, `an unusable reply raised an alert instead of gm.no_verdict: ${loud[0]?.message}`);
      return "an unparseable Game Master reply was re-asked once, then recorded as gm.no_verdict (no_json, 2 attempts) with no gm.decision";
    });
  });

  await act(ctx, st, 3, `Scene 2: ${ctx.scenario.script.scenes[1]!.title}`, async () => {
    const fac = st.fac!;
    const dl = st.players.delivery_lead!;
    const tl = st.players.tech_lead!;
    const inject = ctx.scenario.script.scenes[1]!.injects!.find((i) => i.at_minute !== undefined)!;
    const goal = inject.effect?.goals_add?.[0] ?? "";

    // The Game Master cannot record a verdict for a scene that has already ended (checked in-process).
    if (sys) {
      st.ev.stale = await attempt(async () => {
        const seq = sys.engine.state.lastSeq;
        const recorded = await sys.engine.recordGmVerdict("stale probe", true, "probe", { expectSceneId: s1 });
        return { recorded, unchanged: seq === sys.engine.state.lastSeq };
      }, ctx.signal);
    }

    // The facilitator whispers to one player; whispering an AI role is refused.
    st.ev.whisper = await attempt(async () => {
      await command(ctx, st, { command: "whisper", roleId: "delivery_lead", text: WHISPER }, "facilitator whispers privately to delivery_lead");
      await dl.waitFor(isEvent("facilitator.command", (e) => e.command === "whisper"), { what: "the whisper" });
      await fac.expectError({ type: "command", command: { command: "whisper", roleId: npc.id, text: "psst" } }, "npc_role");
      await n.step(`a whisper to ${npc.id} is refused (npc_role)`);
      return true;
    }, ctx.signal);

    let from = fac.mark();
    await say(ctx, st, "delivery_lead", S2_LINES[0]![1]);
    await awaitNpc(ctx, st, from);

    // Pause: speech is refused and nothing is appended; resume restores it.
    st.ev.pause = await attempt(async () => {
      await command(ctx, st, { command: "pause" }, "facilitator: pause");
      const text = "This line must be refused while paused.";
      const mark = fac.mark();
      await dl.expectError({ type: "say", text }, "paused");
      await n.step("delivery_lead tries to speak while paused: refused (paused)");
      await command(ctx, st, { command: "resume" }, "facilitator: resume");
      ensure(!fac.events().slice(mark).some((e) => e.type === "utterance" && e.text === text), "a line spoken while paused was appended");
      return true;
    }, ctx.signal);

    // A role that is not in this scene cannot speak in it.
    st.ev.absent = await attempt(async () => {
      await tl.expectError({ type: "say", text: "Can I join the call?" }, "not_in_scene");
      await n.step("tech_lead is not on the client call and cannot speak into it (not_in_scene)");
      return true;
    }, ctx.signal);

    if (mock && sys) {
      const clock = sys.fakeClock!;
      st.ev.timed = await attempt(async () => {
        const at = inject.at_minute!;
        clock.advance(at * MIN - 1_000);
        await command(ctx, st, { command: "resume" }, `clock at ${at - 1}:59, one second before the inject`);
        const early = sys.engine.state.injectsFired.includes(inject.id);
        clock.advance(1_000);
        await command(ctx, st, { command: "resume" }, `clock at ${at}:00`);
        const onTime = sys.engine.state.injectsFired.includes(inject.id);
        await fac.waitFor(isEvent("inject.fired", (e) => e.injectId === inject.id), { what: "the timed inject" });
        await n.step(`inject ${inject.id} fires now (addressed only to ${inject.to.join(", ")})`);
        return { early, onTime, goalAdded: sys.engine.state.npcs[npc.id]?.goals.includes(goal) === true };
      }, ctx.signal);
    }

    // The next line is spoken after resume: it must be accepted and answered.
    from = fac.mark();
    await say(ctx, st, "account_manager", S2_LINES[1]![1]);
    await awaitNpc(ctx, st, from);
    st.ev.afterResume = { ok: true, value: true };

    if (mock && sys) {
      await rec.run("F-07", () => {
        const t = got<{ early: boolean; onTime: boolean; goalAdded: boolean }>(st.ev.timed, "the timed-inject step");
        ensure(!t.early, `inject ${inject.id} had already fired one second before minute ${inject.at_minute}`);
        ensure(t.onTime, `inject ${inject.id} had not fired at minute ${inject.at_minute}`);
        ensure(t.goalAdded, "the inject's effect did not reach the NPC state");
        const last = sys.npc!.calls.at(-1);
        ensure(last && `${last.system}\n${JSON.stringify(last.messages)}`.includes(goal), "the inject's effect did not reach the NPC's next prompt");
        return `${inject.id} was absent at ${inject.at_minute! - 1}:59 and fired at ${inject.at_minute}:00; its goal reached the NPC's next prompt`;
      });
      for (const [role, text] of S2_LINES.slice(2)) {
        from = fac.mark();
        await say(ctx, st, role, text);
        await awaitNpc(ctx, st, from);
      }
      await fac.waitFor(isEvent("scene.entered", (e) => e.sceneId === s3), { what: "scene 3 (the Game Master's verdict)" });
      await n.step("the Game Master judges a next step was agreed with Priya: scene 2 ends on its verdict");
      await rec.run("F-12", () => {
        const exits = fac.events().filter((x): x is Extract<SessionEvent, { type: "scene.exited" }> => x.type === "scene.exited" && x.reason === "gm_detects");
        ensure(exits.map((x) => x.sceneId).join() === `${s1},${s2}`, `expected gm_detects exits for ${s1} and ${s2}, saw ${exits.map((x) => x.sceneId).join() || "none"}`);
        const e = got<{ verdicts: boolean[]; calls: number }>(st.ev.s1exit, "scene 1 exit");
        ensure(e.verdicts.at(-1) === true, "scene 1's exiting verdict was not true");
        return `scenes ${s1} and ${s2} both exited on scripted true verdicts (${decisions(st).length} decisions in all, the malformed reply recorded none, and one fenced reply was read tolerantly)`;
      });
    } else {
      await advanceTo(ctx, st, s3);
    }

    // The AI character: once per line, only where present.
    await rec.run("F-08", () => {
      const inScene = utterancesByScene(fac.events())[s2] ?? [];
      const npcLines = inScene.filter((u) => u.roleId === npc.id);
      const playerLines = inScene.filter((u) => u.roleId !== npc.id);
      ensure(npcLines.length > 0, `${npc.id} never spoke in ${s2}`);
      ensure(npcLines.every((u) => u.text.trim().length > 0), `${npc.id} produced an empty utterance`);
      for (let i = 1; i < inScene.length; i++) ensure(!(inScene[i]!.roleId === npc.id && inScene[i - 1]!.roleId === npc.id), `${npc.id} spoke twice in a row`);
      ensure(inScene[0]!.roleId !== npc.id, `${npc.id} spoke before any player`);
      ensure(npcLines.length === playerLines.length, `${playerLines.length} player lines but ${npcLines.length} replies`);
      if (mock && sys) {
        ensure(sys.npc!.calls.length === npcLines.length, `${sys.npc!.calls.length} model calls for ${npcLines.length} replies`);
        const expected = ["Thanks for calling.", "I hear you.", "Hm. Can you put a number on that?", "Alright. Send me the phased plan"];
        npcLines.forEach((u, i) => ensure(u.text.startsWith(expected[i]!), `reply ${i + 1} is not the scripted reply`));
      }
      return `${npcLines.length} replies for ${playerLines.length} player lines, strictly alternating, none empty${mock ? "; each is the scripted reply" : ""}`;
    });
    await rec.run("F-15", () => {
      got(st.ev.pause, "the pause step");
      got(st.ev.afterResume, "the line after resume");
      const text = "This line must be refused while paused.";
      ensure(!fac.events().some((e) => e.type === "utterance" && e.text === text), "the paused line was appended");
      ensure(fac.events().some((e) => e.type === "facilitator.command" && e.command === "pause") && fac.events().some((e) => e.type === "facilitator.command" && e.command === "resume"), "pause/resume were not both recorded");
      return "while paused the line was refused (paused) and appended nothing; after resume the next line was accepted and answered";
    });
  });

  await act(ctx, st, 4, `Scene 3 and rough conditions: ${ctx.scenario.script.scenes[2]!.title}`, async () => {
    const fac = st.fac!;
    const j = st.joined.delivery_lead!;

    // A dropped player rejoins with the reconnect token; imposters are refused.
    await rec.run("F-22", async () => {
      const old = st.players.delivery_lead!;
      const heard = old.events().filter((e) => e.type === "utterance").length;
      const claimer = async (label: string, participantId: string, token: string | undefined, why: string) => {
        const b = await connectBot(ctx, label);
        const r = await b.call(playerJoin(ctx, "delivery_lead", participantId, { reconnectToken: token }), isJoinedMsg, { what: why }); // with the role's code (US-0033)
        ensure(r.type === "error" && r.code === "role_taken", `${why} gave ${errCode(r)}, expected role_taken`);
        b.close();
      };
      await claimer("imposter-no-token", "ZedMalloryParticipant", undefined, "an imposter without the token");
      await claimer("imposter-wrong-token", "ZedMalloryParticipant", "not-the-token", "an imposter with a wrong token");
      await claimer("same-name-no-token", "ZedAlphaParticipant", undefined, "the right name without the token");
      await n.step("while delivery_lead's old connection is still up, three takeover attempts with the role's join code but without the real reconnect token are refused");
      const fresh = await connectBot(ctx, "delivery_lead (rejoined)", { inbox: old.inbox });
      // The live rejoin needs only the reconnect token, not the join code again (US-0033 keeps the reconnect token separate).
      const back = await fresh.call(playerJoin(ctx, "delivery_lead", "ZedAlphaParticipant", { joinCode: undefined, reconnectToken: j.reconnectToken }), isJoinedMsg, { what: "the rejoin" });
      ensure(isJoinedMsg(back), `the rejoin with the token was refused: ${errCode(back)}`);
      ensure(back.roleId === "delivery_lead", "the rejoin did not return the same role");
      ensure(back.reconnectToken !== j.reconnectToken, "the reconnect token was not rotated");
      await withTimeout(old.closed, 5_000, "the server to close the old connection");
      const lines = renderJoined(back);
      ensure((back.state.transcript.length) >= heard, `the rejoin history has ${back.state.transcript.length} lines, ${heard} were heard`);
      ensure(lines.some((l) => l.includes(S1_LINES[0]![1])), "the rendered history lacks an early line of the session");
      await n.step(`delivery_lead rejoins with the reconnect token (no join code needed): role kept, ${back.state.transcript.length} lines of history rendered, old connection closed by the server`);
      await claimer("imposter-after-rejoin", "ZedMalloryParticipant", undefined, "an imposter after the rejoin");
      st.players.delivery_lead = fresh; st.joined.delivery_lead = back;
      return `rejoin with the reconnect token alone kept the role and replayed ${back.state.transcript.length} history lines; the old socket was closed; imposters and the same name holding the join code but not the reconnect token were refused`;
    });

    // Hostile and malformed frames.
    await rec.run("F-20", async () => {
      const spare = await connectBot(ctx, "fuzzer");
      await spare.expectError("this is not json", "bad_json");
      await spare.expectError({ type: "teleport" }, "bad_message");
      await spare.expectError({ type: "say", text: "x".repeat(2_001) }, "bad_message");
      await spare.expectError({ type: "join", sessionId: ctx.sessionId, roleId: "", participantId: "x" }, "bad_message");
      await spare.expectError({ type: "say", text: "hello" }, "not_joined");
      await n.step("bad JSON, an unknown type, an over-long line, an empty id and speech before joining all get an error message");
      const big = await connectBot(ctx, "oversize");
      big.sendRaw("x".repeat(70_000));
      const code = await withTimeout(big.closed, 5_000, "the server to drop the oversized frame's connection");
      ensure(code === 1009, `an oversized frame closed the socket with ${code}, expected 1009`);
      await n.step("a 70 kB frame is refused at the socket (close code 1009)");
      const after = await connectBot(ctx, "probe");
      const r = await after.call(facilitatorJoin(ctx), isJoinedMsg, { what: "a fresh connection" });
      ensure(isJoinedMsg(r), "the server did not accept a new connection after the hostile frames");
      ensure(fac.isOpen, "the facilitator's connection was affected");
      spare.close(); after.close();
      return "bad_json, bad_message (unknown type, over-long line, empty id) and not_joined returned errors; a 70 kB frame closed with 1009; the server kept serving";
    });

    const dl = st.players.delivery_lead!;
    const s3npcBefore = sys?.npc?.calls.length;
    // Terminal safety: hostile text from a participant, rendered by the real terminal client code.
    const echo = await attempt(() => say(ctx, st, "tech_lead", HOSTILE), ctx.signal);
    await rec.run("F-21", async () => {
      got(echo, "the hostile line");
      const seen = await dl.waitFor(isEvent("utterance", (e) => e.text === HOSTILE), { what: "the hostile line at another player" });
      const e = (seen as Extract<Inbound, { type: "event" }>).event;
      ensure(e.type === "utterance" && /\u001b/.test(e.text), "the raw text did not carry the escape sequence (the test would be vacuous)");
      for (const [viewer, label] of [["delivery_lead", "a player"], ["facilitator", "the facilitator"], ["tech_lead", "the speaker"]] as const) {
        const out = renderEvent(e, viewer);
        ensure(out !== null, `${label}'s client rendered nothing`);
        ensure(!UNSAFE_CHARS.test(out), `${label}'s rendering contains a control or bidi character`);
        ensure(!/[\r\n]/.test(out), `${label}'s rendering contains a line break`);
        ensure(!out.startsWith("[delivery_lead]"), `${label}'s rendering starts with a forged line`);
        ensure(out.includes("⏎"), `${label}'s rendering lost the visible newline marker`);
      }
      return "an ESC colour code, an OSC title sequence, a bidi override and a forged '[delivery_lead]:' newline were all neutralised by the terminal client's renderEvent";
    });
    await say(ctx, st, "delivery_lead", "Noted. I will write up the summary for the wider team.");
    await fac.waitFor(isEvent("utterance", (e) => e.roleId === "delivery_lead" && e.text.startsWith("Noted.")), { what: "the wrap-up line" });
    st.ev.s3npc = { ok: true, value: sys?.npc ? { before: s3npcBefore, after: sys.npc.calls.length } : null };
  });

  await act(ctx, st, 5, "Finale: the facilitator ends the scene and the session", async () => {
    const fac = st.fac!;
    if (mock && sys) {
      const clock = sys.fakeClock!;
      const box = ctx.scenario.script.scenes[2]!.time_box_minutes;
      clock.advance(box * MIN - 1_000);
      await command(ctx, st, { command: "resume" }, `clock at ${box - 1}:59 of the ${box} minute time box`);
      ensure(sys.engine.state.status === "running", "the scene ended before its time box");
      await n.note("not yet over: the time box has not elapsed");
    }
    await advanceTo(ctx, st, "end");
    await n.step("the facilitator advances: the last scene ends and the session is over");
    await rec.run("F-25", async () => {
      const ended = fac.events().find((e): e is Extract<SessionEvent, { type: "session.ended" }> => e.type === "session.ended");
      ensure(ended && ended.reason === "script_complete", `the session ended with ${ended?.reason ?? "no session.ended"}`);
      for (const [role] of ROLE_PLAYERS) await st.players[role]!.waitFor(isEvent("session.ended"), { what: `${role} to see the end` });
      await st.players.delivery_lead!.expectError({ type: "say", text: "Is anyone still there?" }, "ended");
      await fac.expectError({ type: "command", command: { command: "resume" } }, "ended");
      await n.step("speech and commands after the end are refused (ended)");
      return "session.ended (script_complete) reached everyone; speech and commands afterwards were refused with ended";
    });
    await settle(ctx, st);
  });

  // Evidence that spans the whole story.
  await rec.run("F-09", () => {
    const by = utterancesByScene(st.fac!.events());
    const absentIn = [s1, s3].filter((id) => !(ctx.scenario.script.scenes.find((s) => s.id === id)?.participants ?? []).includes(npc.id));
    for (const id of absentIn) ensure(!(by[id] ?? []).some((u) => u.roleId === npc.id), `${npc.id} spoke in ${id}, where it is absent`);
    got(st.ev.absent, "the absent-role step");
    let extra = "";
    if (mock && sys) {
      ensure(st.ev.s1npc?.ok && st.ev.s1npc.value === 0, "the NPC model was called during scene 1");
      const s3n = got<{ before: number; after: number } | null>(st.ev.s3npc, "scene 3 NPC count");
      ensure(s3n && s3n.before === s3n.after, "the NPC model was called during scene 3");
      extra = `; the NPC model was never called in ${s1} or ${s3}`;
    }
    return `${npc.id} said nothing in ${absentIn.join(" or ")}${extra}; a role outside a scene gets not_in_scene when it speaks`;
  }, ["F-25"]);
}


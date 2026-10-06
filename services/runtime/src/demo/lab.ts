import { Bot, isEvent, type Inbound } from "./bots.js";
import { ensure } from "./checks.js";
import { act, attempt, connectBot, errCode, isJoinedMsg, npcRole, sceneIds, utterancesOf, withTimeout, type Ctx, type Story, type Utter } from "./ctx.js";
import { LAB_FIRST_TOKEN_MS, LAB_HEARTBEAT_MS, startLabSystem } from "./harness.js";

/** The server terminates a silent socket at the second heartbeat tick after its last answer, so a 3 period limit has room for scheduling slack. */
export const SILENT_DROP_LIMIT_PERIODS = 3;

/**
 * BUG-0003: judges check F-23 from what the silent client saw, not from how long the whole check took. `pings` is the number of
 * server pings it received (and never answered) before the socket was closed; `sinceFirstPingMs` is measured from the first one.
 * The server pings once, then terminates at the next tick, so 1 ping is normal and more than 2 means the heartbeat is not working.
 */
export function silentDropEvidence(o: { pings: number; sinceFirstPingMs: number; heartbeatMs: number }): string {
  ensure(o.pings >= 1, "the server never pinged the silent client before closing it, so the drop was not caused by the heartbeat");
  ensure(o.pings <= 2, `the server pinged the silent client ${o.pings} times before dropping it (at most 2 expected)`);
  const periods = o.sinceFirstPingMs / o.heartbeatMs;
  ensure(periods <= SILENT_DROP_LIMIT_PERIODS, `the silent client was dropped ${periods.toFixed(1)} heartbeat periods after its first unanswered ping (limit ${SILENT_DROP_LIMIT_PERIODS})`);
  return `the silent client got ${o.pings} unanswered ping${o.pings === 1 ? "" : "s"} and was dropped within ${SILENT_DROP_LIMIT_PERIODS} heartbeat periods of the first; live clients stayed; its role was freed`;
}

/**
 * The side room (act 6): a second in-process server with a short heartbeat, short NPC timeouts and an NPC model that
 * misbehaves on purpose (stalls, then answers with nothing). It proves the failure paths the main story cannot wait for.
 */
export async function playLab(ctx: Ctx, st: Story): Promise<void> {
  if (!ctx.rec.applicable("F-10")) return;
  const { rec, n } = ctx;
  const npc = npcRole(ctx.scenario);
  const [s1, s2] = sceneIds(ctx.scenario) as [string, string];

  await act(ctx, st, 6, "Side room: a stalled model, an empty reply and a dead client", async () => {
    const lab = await startLabSystem({ scenario: ctx.scenario, sessionId: "lab" });
    let stopped = false;
    const stop = async () => { if (!stopped) { stopped = true; await lab.stop(); } };
    ctx.register(stop);
    const url = `ws://127.0.0.1:${lab.port}`;
    await n.step(`a second server starts with a ${LAB_HEARTBEAT_MS} ms heartbeat, a ${LAB_FIRST_TOKEN_MS} ms NPC first-token timeout and a misbehaving NPC model`);

    const fac = await connectBot(ctx, "lab facilitator", { url });
    ctx.tr?.attach(fac, { scenario: ctx.scenario, provider: "mock", sceneHeadings: false });
    await fac.call({ type: "join_facilitator", sessionId: "lab" }, isJoinedMsg);
    const join = async (bot: Bot, role: string, who: string): Promise<Inbound> => bot.call({ type: "join", sessionId: "lab", roleId: role, participantId: who }, isJoinedMsg, { what: `${role} to join` });
    const dl = await connectBot(ctx, "lab delivery_lead", { url });
    const am = await connectBot(ctx, "lab account_manager", { url });
    ensure(isJoinedMsg(await join(dl, "delivery_lead", "ZedAlphaParticipant")), "the lab delivery_lead could not join");
    ensure(isJoinedMsg(await join(am, "account_manager", "ZedCharlieParticipant")), "the lab account_manager could not join");

    // A client that connects, claims a role and then never answers pings.
    await rec.run("F-23", async () => {
      const ghost = await connectBot(ctx, "ghost", { url, autoPong: false });
      let pings = 0; let firstPingAt = 0;
      ghost.ws.on("ping", () => { if (pings++ === 0) firstPingAt = Date.now(); });
      ensure(isJoinedMsg(await join(ghost, "tech_lead", "ZedGhostParticipant")), "the ghost could not join");
      await n.step("a client claims tech_lead, then stops answering the server's pings");
      await withTimeout(ghost.closed, 5_000, `the server to drop the silent client (heartbeat ${LAB_HEARTBEAT_MS} ms)`);
      const closedAt = Date.now();
      ensure(dl.isOpen && am.isOpen, "a client that answered its pings was dropped too");
      const taker = await connectBot(ctx, "replacement tech_lead", { url });
      const j = await join(taker, "tech_lead", "ZedDeltaParticipant");
      ensure(isJoinedMsg(j), `the role was not freed: ${errCode(j)}`);
      taker.close();
      await n.step("the silent client is terminated by the server and tech_lead is free for someone else");
      return silentDropEvidence({ pings, sinceFirstPingMs: pings > 0 ? closedAt - firstPingAt : 0, heartbeatMs: LAB_HEARTBEAT_MS });
    });

    fac.send({ type: "start" });
    await fac.waitFor(isEvent("scene.entered", (e) => e.sceneId === s1), { what: "the lab's scene 1" });
    st.ev.labAdvance = await attempt(async () => {
      fac.send({ type: "command", command: { command: "advance" } });
      await fac.waitFor(isEvent("scene.entered", (e) => e.sceneId === s2), { what: "the lab's scene 2 after advance" });
      return true;
    }, ctx.signal);
    if (!st.ev.labAdvance.ok) throw new Error(`the side room's advance failed: ${st.ev.labAdvance.error}`);
    await n.step("lab: the facilitator advances from scene 1 to scene 2, where the AI character is present");

    const reply = async (who: Bot, role: string, text: string) => {
      const from = fac.mark();
      who.send({ type: "say", text });
      await n.say(role, text);
      const m = await fac.waitFor(isEvent("utterance", (e) => e.roleId === npc.id), { from, timeoutMs: 5_000, what: `${npc.id}'s fallback line` });
      const alertMsg = await fac.waitFor(isEvent("facilitator.alert"), { from, timeoutMs: 5_000, what: "the facilitator alert" });
      const u = (m as Extract<Inbound, { type: "event" }>).event as Utter;
      const a = (alertMsg as Extract<Inbound, { type: "event" }>).event;
      await n.say(`${npc.name} (${npc.id})`, u.text);
      return { utterance: u, alert: a.type === "facilitator.alert" ? a : null };
    };

    const stall = await reply(dl, "delivery_lead", "Hello Priya, can you hear us?");
    await rec.run("F-10", () => {
      ensure(stall.utterance.text === npc.fallback_line, "the NPC did not speak its fallback line");
      ensure(stall.alert && stall.alert.level === "warning" && /no first token/.test(stall.alert.message), `the alert was not the first-token warning: ${stall.alert?.message ?? "none"}`);
      ensure(lab.npcProvider.calls.length === 1, "the stalled model was not called exactly once");
      return `the model stalled past ${LAB_FIRST_TOKEN_MS} ms: the NPC said its scripted fallback line and the facilitator got a warning alert`;
    });
    await lab.host.idle();

    const empty = await reply(am, "account_manager", "Priya, are you there?");
    await lab.host.idle();
    await rec.run("F-11", () => {
      ensure(empty.utterance.text === npc.fallback_line, "an empty reply did not produce the fallback line");
      ensure(empty.alert && /empty reply/.test(empty.alert.message), `the alert was not about an empty reply: ${empty.alert?.message ?? "none"}`);
      const blank = utterancesOf(fac.events()).filter((u) => u.text.trim() === "");
      ensure(blank.length === 0, `${blank.length} empty utterance(s) were appended`);
      return "an empty model reply produced the fallback line and an alert; no empty utterance was ever appended";
    });
    await lab.host.idle();
    ctx.labLogs.push(...lab.hostLog, ...lab.serverLog);
    ctx.labHostLog.push(...lab.hostLog);
    for (const b of [fac, dl, am]) b.close();
    await stop();
  }, { always: true });
}

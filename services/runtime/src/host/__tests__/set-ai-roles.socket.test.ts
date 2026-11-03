import { afterEach, describe, expect, it, vi } from "vitest";
import { setAiRoles } from "../set-ai-roles.js";
import { reissueRole } from "../reissue.js";
import { CLOSE_REISSUED } from "../ws-server.js";
import { cleanup, consent, facilitator, open, pat, seat, setup } from "./ai-roles-harness.js";
// US-0060 Task 7: what the switch does to real connections. Real-socket tests: a generous explicit limit; nothing measures elapsed time.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
afterEach(cleanup);

const joinWith = async (port: number, roleId: string, extra: Record<string, unknown>, participantId: string) => {
  const c = await open(port);
  c.send({ type: "join", sessionId: "local", roleId, participantId, ...extra });
  return { c, r: await c.next((m) => m.type === "joined" || m.type === "error") };
};

describe("setAiRoles over real sockets (US-0060)", () => {
  it("after the switch, account_manager's old join code and Pat's credential are both refused", async () => {
    const e = await setup();
    const p = await pat(e);
    const credential = p.r.credential as string;
    const oldCode = e.plain.account_manager!;
    const [sw] = await setAiRoles(e.deps, ["account_manager"]);
    await p.closed;
    expect((await joinWith(e.port, "account_manager", { joinCode: oldCode }, "mallory")).r).toMatchObject({ type: "error", code: "unauthorized" });
    expect((await joinWith(e.port, "account_manager", { credential }, "pat")).r).toMatchObject({ type: "error", code: "unauthorized" });
    // the new code opens the seat for the bot, without consent
    const bot = await joinWith(e.port, "account_manager", { joinCode: sw!.code, issueCredential: true }, "bot1");
    expect(bot.r.type).toBe("joined");
  });

  it("switching tech_lead back to human closes the bot with 4002, revokes the bot's credential and returns a new code; the bot's old code is refused", async () => {
    const e = await setup({ aiRoles: ["tech_lead"] });
    const bot = await seat(e.port, "tech_lead", e.plain.tech_lead!, "bot1");
    expect(bot.r.type).toBe("joined");
    expect(e.seats.credentials.has("tech_lead")).toBe(true);
    const out = await setAiRoles(e.deps, []);
    expect(out.map((x) => x.roleId)).toEqual(["tech_lead"]);
    expect((await bot.closed).code).toBe(CLOSE_REISSUED);
    expect(e.seats.credentials.has("tech_lead")).toBe(false);
    expect(e.seats.aiRoles!.list()).toEqual([]);
    expect((await joinWith(e.port, "tech_lead", { joinCode: e.plain.tech_lead! }, "bot2")).r).toMatchObject({ type: "error", code: "unauthorized" });
    const human = await joinWith(e.port, "tech_lead", { joinCode: out[0]!.code, issueCredential: true, displayName: "Tess" }, "tess");
    expect(human.r.type).toBe("joined");
    expect(human.r.consent.given).toBe(false); // a human seat asks for consent again
  });

  it("after the kick, the reconnect token of Pat's closed socket is refused for account_manager", async () => {
    const e = await setup();
    const p = await pat(e);
    const token = p.r.reconnectToken as string;
    await setAiRoles(e.deps, ["account_manager"]);
    await p.closed;
    expect((await joinWith(e.port, "account_manager", { reconnectToken: token }, "pat")).r).toMatchObject({ type: "error", code: "unauthorized" });
  });

  it("the roster is re-sent with ai true for a switched role nobody held", async () => {
    const e = await setup();
    const f = await facilitator(e.port);
    const pl = await seat(e.port, "delivery_lead", e.plain.delivery_lead!, "dana", "Dana");
    await setAiRoles(e.deps, ["tech_lead"]); // nobody holds tech_lead: kickRole alone would send nothing
    const roster = await f.next((m) => m.type === "roster" && m.entries.some((x: any) => x.roleId === "tech_lead" && x.ai === true));
    expect(roster.entries.find((x: any) => x.roleId === "tech_lead")).toMatchObject({ ai: true, joined: false });
    expect(roster.entries.find((x: any) => x.roleId === "delivery_lead").ai).toBeUndefined();
    const peers = await pl.next((m) => m.type === "roster" && m.entries.some((x: any) => x.roleId === "tech_lead" && x.ai === true));
    expect(peers.audience).toBe("peers");
  });

  it("a failed seat write leaves delivery_lead's old code and Pat's credential working", async () => {
    const e = await setup();
    const p = await pat(e);
    const credential = p.r.credential as string;
    e.state.persistFails = true;
    await expect(setAiRoles(e.deps, ["account_manager", "delivery_lead"])).rejects.toThrow("disk full");
    e.state.persistFails = false;
    expect(p.ws.readyState).toBe(p.ws.OPEN); // nobody was kicked
    // Pat's credential still opens account_manager (reconnecting on a new socket takes the seat)
    expect((await joinWith(e.port, "account_manager", { credential }, "pat")).r.type).toBe("joined");
    // delivery_lead holds no credential, so its old code still opens it
    expect((await joinWith(e.port, "delivery_lead", { joinCode: e.plain.delivery_lead!, issueCredential: true, displayName: "Dana" }, "dana")).r.type).toBe("joined");
    expect(e.seats.aiRoles!.list()).toEqual([]);
  });

  it("the real reissueRole on an AI seat after a switch, then a rejoin with the reissued code", async () => {
    const e = await setup();
    const [sw] = await setAiRoles(e.deps, ["tech_lead"]);
    const bot = await seat(e.port, "tech_lead", sw!.code, "bot1");
    expect(bot.r.type).toBe("joined");
    const reissued = await reissueRole(e.deps, "tech_lead", "Kim");
    expect((await bot.closed).code).toBe(CLOSE_REISSUED);
    expect(reissued).not.toBe(sw!.code);
    expect(e.seats.aiRoles!.list()).toEqual(["tech_lead"]); // still an AI role
    expect((await joinWith(e.port, "tech_lead", { joinCode: sw!.code }, "bot2")).r).toMatchObject({ type: "error", code: "unauthorized" });
    const again = await joinWith(e.port, "tech_lead", { joinCode: reissued, issueCredential: true }, "bot2");
    expect(again.r.type).toBe("joined");
    expect(e.seats.consent.hasEntry("tech_lead")).toBe(false); // no consent step for an AI seat
    const dana = await seat(e.port, "delivery_lead", e.plain.delivery_lead!, "dana", "Dana");
    await consent(dana, e.seats, "delivery_lead", "dana");
  });
});

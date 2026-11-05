import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_ROLES_REFUSED, AiRolesRefusedError, setAiRoles } from "../set-ai-roles.js";
import { CLOSE_AI_FILLED } from "../ws-server.js";
import { MAX_AI_ROLES, noticeNamesAiPlayers } from "../limits.js";
import { JoinCodes } from "../../engine/join-codes.js";
import { PlayerCredentials } from "../../engine/credentials.js";
import { ConsentStore } from "../../engine/consent.js";
import { AiRoleSet } from "../../engine/ai-roles.js";
import type { Seats } from "../../engine/seats.js";
import { BIND, PLAYERS, cleanup, consent, pat, seat, setup, stateOf, type Env } from "./ai-roles-harness.js";
// US-0060 Task 7: the switch of player roles to AI players, step by step. Real-socket tests: a generous explicit limit.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
afterEach(cleanup);

const refusal = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(AiRolesRefusedError); return (e as AiRolesRefusedError).reason; }
  throw new Error("expected a refusal");
};
const events = (e: Env) => { const r = e.engine.eventsAfter(0); if (!r.complete) throw new Error("window incomplete"); return [...r.events]; };

describe("setAiRoles (US-0060)", () => {
  it("the fixed reasons are the contract", () => {
    expect(AI_ROLES_REFUSED).toEqual({
      started: "AI roles can only be changed before the start", invalid: "not a player role of this session",
      noHuman: "at least one player role must stay human", tooMany: "at most 8 player roles can be AI players",
      notice: "the consent notice in use does not mention AI players", failed: "the AI roles could not be changed",
    });
    expect(CLOSE_AI_FILLED).toBe(4004);
  });

  it("switching account_manager (joined and consented as Pat) to AI writes a new code first, revokes the credential, withdraws consent, closes the socket with 4004 \"ai_filled\" and returns one code for account_manager", async () => {
    const e = await setup();
    const p = await pat(e);
    expect(e.seats.consent.hasEntry("account_manager")).toBe(true);
    const oldCode = e.plain.account_manager!;
    // Observe the state at the moment the codes are written: nothing may be revoked yet.
    let atWrite: { cred: boolean; consent: boolean; ai: string[]; socketOpen: boolean } | undefined;
    const write = e.deps.writeCodes;
    e.deps.writeCodes = (c) => { atWrite = { cred: e.seats.credentials.has("account_manager"), consent: e.seats.consent.hasEntry("account_manager"), ai: e.seats.aiRoles!.list(), socketOpen: p.ws.readyState === p.ws.OPEN }; write(c); };
    const persists0 = e.state.persists;
    const out = await setAiRoles(e.deps, ["account_manager"]);
    expect(atWrite).toEqual({ cred: true, consent: true, ai: [], socketOpen: true });
    expect(out).toHaveLength(1);
    expect(out[0]!.roleId).toBe("account_manager");
    expect(out[0]!.code).not.toBe(oldCode);
    expect(e.current().verify("account_manager", out[0]!.code)).toBe(true);
    expect(e.current().verify("account_manager", oldCode)).toBe(false);
    expect(e.seats.credentials.has("account_manager")).toBe(false);
    expect(e.seats.consent.hasEntry("account_manager")).toBe(false);
    expect(e.seats.aiRoles!.list()).toEqual(["account_manager"]);
    expect(e.host.assignments.account_manager).toBeUndefined();
    expect(await p.closed).toEqual({ code: 4004, reason: "ai_filled" });
    expect(JSON.parse(e.files.aiRoles).roles).toEqual(["account_manager"]);
    expect(e.state.persists - persists0).toBe(1);
  });

  it("codes come back in the scenario's player-role order, one per changed role", async () => {
    const e = await setup();
    const out = await setAiRoles(e.deps, ["tech_lead", "account_manager"]);
    expect(out.map((x) => x.roleId)).toEqual(["account_manager", "tech_lead"]);
    expect(e.seats.aiRoles!.list()).toEqual(["account_manager", "tech_lead"]);
    for (const x of out) expect(e.current().verify(x.roleId, x.code)).toBe(true);
    expect(e.current().verify("delivery_lead", e.plain.delivery_lead!)).toBe(true); // an unchanged role keeps its code
  });

  it("the same set again writes no code, kicks nobody and returns []", async () => {
    const e = await setup({ aiRoles: ["tech_lead"] });
    const kick = vi.fn(); const roster = vi.fn(); const set = vi.fn();
    const deps = { ...e.deps, server: { kickRole: kick, broadcastRoster: roster }, setCodes: set };
    const before = stateOf(e);
    expect(await setAiRoles(deps, ["tech_lead"])).toEqual([]);
    expect(stateOf(e)).toBe(before);
    expect(e.written).toHaveLength(0);
    expect(e.state.persists).toBe(0);
    expect(kick).not.toHaveBeenCalled();
    expect(roster).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it("refused with \"AI roles can only be changed before the start\" after the start, while the start is in flight and after the end, nothing changed", async () => {
    // after the start
    const e = await setup();
    const a = await pat(e);
    const d = await seat(e.port, "delivery_lead", e.plain.delivery_lead!, "dana", "Dana");
    await consent(d, e.seats, "delivery_lead", "dana");
    const t = await seat(e.port, "tech_lead", e.plain.tech_lead!, "tess", "Tess");
    await consent(t, e.seats, "tech_lead", "tess");
    // while the start is in flight
    const log = (e.engine as unknown as { log: { append: (...a: unknown[]) => Promise<unknown> } }).log;
    const real = log.append.bind(log);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    log.append = async (...args: unknown[]) => { await gate; return real(...args); };
    const starting = e.host.start();
    await vi.waitFor(() => expect(e.host.isStarting).toBe(true));
    const flight = stateOf(e);
    expect(await refusal(setAiRoles(e.deps, ["tech_lead"]))).toBe("AI roles can only be changed before the start");
    expect(stateOf(e)).toBe(flight);
    release(); await starting;
    const started = stateOf(e);
    expect(await refusal(setAiRoles(e.deps, ["tech_lead"]))).toBe(AI_ROLES_REFUSED.started);
    expect(await refusal(setAiRoles(e.deps, []))).toBe(AI_ROLES_REFUSED.started);
    expect(stateOf(e)).toBe(started);
    expect(a.ws.readyState).toBe(a.ws.OPEN);
    // after the end
    await e.host.endNow({ by: "Kim" });
    const ended = stateOf(e);
    expect(await refusal(setAiRoles(e.deps, ["tech_lead"]))).toBe(AI_ROLES_REFUSED.started);
    expect(stateOf(e)).toBe(ended);
  });

  it("refused with \"not a player role of this session\" for client_sponsor, \"ghost\" and tech_lead twice", async () => {
    const e = await setup();
    const before = stateOf(e);
    for (const roles of [["client_sponsor"], ["ghost"], ["tech_lead", "tech_lead"], ["__proto__"], ["constructor"], ["facilitator"]]) {
      expect(await refusal(setAiRoles(e.deps, roles)), JSON.stringify(roles)).toBe("not a player role of this session");
    }
    expect(await refusal(setAiRoles(e.deps, "tech_lead" as unknown as string[]))).toBe(AI_ROLES_REFUSED.invalid);
    expect(await refusal(setAiRoles(e.deps, [5] as unknown as string[]))).toBe(AI_ROLES_REFUSED.invalid);
    expect(stateOf(e)).toBe(before);
  });

  it("refused with \"at least one player role must stay human\" for all three player roles", async () => {
    const e = await setup();
    const before = stateOf(e);
    expect(await refusal(setAiRoles(e.deps, [...PLAYERS]))).toBe("at least one player role must stay human");
    expect(await refusal(setAiRoles(e.deps, [...PLAYERS].reverse()))).toBe(AI_ROLES_REFUSED.noHuman);
    expect(stateOf(e)).toBe(before);
  });

  it("without an AI-role set on the seats it fails with the fixed failed reason", async () => {
    const e = await setup();
    delete e.seats.aiRoles;
    expect(await refusal(setAiRoles(e.deps, ["tech_lead"]))).toBe(AI_ROLES_REFUSED.failed);
  });

  it("a failed seat write restores credential, consent and AI set in memory, puts the old codes file back, and re-persists once", async () => {
    const e = await setup();
    await pat(e);
    const d = await seat(e.port, "delivery_lead", e.plain.delivery_lead!, "dana", "Dana"); // joined, so it holds a credential
    expect(d.r.type).toBe("joined");
    const credBefore = JSON.stringify(PLAYERS.map((r) => e.seats.credentials.snapshotRole(r)));
    const consentBefore = JSON.stringify(e.seats.consent.snapshot());
    const filesBefore = JSON.stringify(e.files);
    const persists0 = e.state.persists;
    e.state.persistFails = true;
    await expect(setAiRoles(e.deps, ["account_manager", "tech_lead"])).rejects.toThrow("disk full");
    expect(JSON.stringify(PLAYERS.map((r) => e.seats.credentials.snapshotRole(r)))).toBe(credBefore);
    expect(JSON.stringify(e.seats.consent.snapshot())).toBe(consentBefore);
    expect(e.seats.aiRoles!.list()).toEqual([]);
    expect(JSON.stringify(e.files)).toBe(filesBefore); // the old codes file is back
    expect(e.current().verify("tech_lead", e.plain.tech_lead!)).toBe(true);
    expect(e.state.persists - persists0).toBe(2); // the failed write and the one best-effort re-persist
    expect(e.written).toHaveLength(2); // new codes, then the old ones put back
  });

  it("when the codes write fails, nothing changed: credential, consent, AI set, AI-role file and socket untouched, nothing kicked", async () => {
    const e = await setup();
    const p = await pat(e);
    const kick = vi.fn(); const roster = vi.fn();
    const deps = { ...e.deps, server: { kickRole: kick, broadcastRoster: roster } };
    const before = stateOf(e);
    e.state.codesFail = true;
    await expect(setAiRoles(deps, ["account_manager"])).rejects.toThrow("codes disk full");
    expect(stateOf(e)).toBe(before);
    expect(kick).not.toHaveBeenCalled();
    expect(roster).not.toHaveBeenCalled();
    expect(p.ws.readyState).toBe(p.ws.OPEN);
    expect(e.seats.credentials.has("account_manager")).toBe(true);
    expect(e.seats.consent.hasEntry("account_manager")).toBe(true);
  });

  it("nothing is appended to the log", async () => {
    const e = await setup();
    await pat(e);
    await setAiRoles(e.deps, ["account_manager"]);
    await setAiRoles(e.deps, ["tech_lead"]);
    await setAiRoles(e.deps, []);
    expect(events(e)).toEqual([]);
  });

  it("the AI role never has a consent entry after the switch, and the start gate's consents hold only the humans", async () => {
    const e = await setup();
    await pat(e);
    const [switched] = await setAiRoles(e.deps, ["account_manager"]);
    expect(e.seats.consent.hasEntry("account_manager")).toBe(false);
    expect(Object.keys(e.seats.consent.snapshot())).not.toContain("account_manager");
    // the bot takes the seat (no displayName, no consent); even then no consent entry appears
    const bot = await seat(e.port, "account_manager", switched!.code, "bot1");
    expect(bot.r.type).toBe("joined");
    expect(e.seats.consent.hasEntry("account_manager")).toBe(false);
    const dana = await seat(e.port, "delivery_lead", e.plain.delivery_lead!, "dana", "Dana");
    await consent(dana, e.seats, "delivery_lead", "dana");
    const tess = await seat(e.port, "tech_lead", e.plain.tech_lead!, "tess", "Tess");
    await consent(tess, e.seats, "tech_lead", "tess");
    expect(Object.keys(e.seats.consent.snapshot()).sort()).toEqual(["delivery_lead", "tech_lead"]);
    await e.host.start();
    const started = events(e).find((x) => x.type === "session.started") as { consents?: Record<string, unknown>; aiRoles?: string[] };
    expect(Object.keys(started.consents ?? {}).sort()).toEqual(["delivery_lead", "tech_lead"]);
    expect(started.aiRoles).toEqual(["account_manager"]);
  });
});

describe("setAiRoles under the consent notice (US-0060)", () => {
  it("set_ai_roles [tech_lead] under CONSENT_NOTICE_VERSION=v1 is refused \"the consent notice in use does not mention AI players\" and nothing changes", async () => {
    const e = await setup({ noticeVersion: "v1" });
    const p = await pat(e);
    const kick = vi.fn(); const roster = vi.fn();
    const before = stateOf(e);
    const reason = await refusal(setAiRoles({ ...e.deps, server: { kickRole: kick, broadcastRoster: roster } }, ["tech_lead"]));
    expect(reason).toBe("the consent notice in use does not mention AI players");
    expect(reason).toBe(AI_ROLES_REFUSED.notice);
    expect(stateOf(e)).toBe(before); // codes file, seat files, credentials, consent, AI set, log
    expect(kick).not.toHaveBeenCalled();
    expect(roster).not.toHaveBeenCalled();
    expect(p.ws.readyState).toBe(p.ws.OPEN);
  });

  it("the notice refusal comes first: an invalid role under v1 is still the notice refusal", async () => {
    const e = await setup({ noticeVersion: "v1" });
    expect(await refusal(setAiRoles(e.deps, ["nobody"]))).toBe(AI_ROLES_REFUSED.notice);
  });

  it("set_ai_roles [] under v1 is allowed, and switches a role back to human", async () => {
    const e = await setup({ noticeVersion: "v1" });
    expect(await setAiRoles(e.deps, [])).toEqual([]);
    const e2 = await setup({ noticeVersion: "v1", aiRoles: ["tech_lead"] });
    const out = await setAiRoles(e2.deps, []);
    expect(out.map((x) => x.roleId)).toEqual(["tech_lead"]);
    expect(e2.seats.aiRoles!.list()).toEqual([]);
  });

  it("noticeNamesAiPlayers is false for \"v1\", \"x2\", \"v\" and true for \"v2\", \"v10\"", () => {
    for (const v of ["v1", "x2", "v", "", "v0", "v2a", "V2"]) expect(noticeNamesAiPlayers(v)).toBe(false);
    for (const v of ["v2", "v10"]) expect(noticeNamesAiPlayers(v)).toBe(true);
  });
});

describe("setAiRoles caps (US-0060)", () => {
  /** A fake host with twelve player roles; the seats are real objects, the disk and the sockets fakes. */
  function twelve() {
    const players = Array.from({ length: 12 }, (_, i) => `p${i + 1}`);
    const aiRoles = AiRoleSet.empty();
    aiRoles.replace([], players);
    const seats: Seats = { credentials: PlayerCredentials.create(BIND), consent: new ConsentStore({ version: "v2", text: "n" }), aiRoles, persist: () => {} };
    const host = {
      hasStarted: false, isStarting: false, engine: { state: { status: "idle" } },
      hasPlayerRole: (r: string) => players.includes(r), playerRoleIds: () => players,
    };
    const issued = JoinCodes.issue(players, BIND);
    let current = issued.codes;
    const deps = {
      host, seats, sessionId: "local", server: { kickRole: () => {}, broadcastRoster: () => {} },
      codes: () => current, setCodes: (c: JoinCodes) => { current = c; }, writeCodes: () => {},
    } as unknown as Parameters<typeof setAiRoles>[0];
    return { players, deps, seats };
  }

  it("nine AI roles of a twelve-player scenario are refused \"at most 8 player roles can be AI players\" and nothing changed", async () => {
    const { players, deps, seats } = twelve();
    expect(MAX_AI_ROLES).toBe(8);
    const writeCodes = vi.fn(); const kick = vi.fn(); const roster = vi.fn();
    const spied = { ...deps, writeCodes, server: { kickRole: kick, broadcastRoster: roster } };
    expect(await refusal(setAiRoles(spied, players.slice(0, 9)))).toBe("at most 8 player roles can be AI players");
    expect(writeCodes).not.toHaveBeenCalled();
    expect(kick).not.toHaveBeenCalled();
    expect(roster).not.toHaveBeenCalled();
    expect(seats.aiRoles!.list()).toEqual([]);
  });

  it("eight are accepted", async () => {
    const { players, deps, seats } = twelve();
    const out = await setAiRoles(deps, players.slice(0, 8));
    expect(out).toHaveLength(8);
    expect(seats.aiRoles!.list()).toEqual(players.slice(0, 8));
  });

  it("all twelve AI is \"at least one player role must stay human\" (that check comes first)", async () => {
    const { players, deps } = twelve();
    expect(await refusal(setAiRoles(deps, players))).toBe("at least one player role must stay human");
  });
});

describe("setAiRoles with the group-score option (US-0061)", () => {
  it("an option-only change from on to off persists v2, returns [], keeps every code and credential, kicks nobody and sends no roster", async () => {
    const e = await setup({ aiRoles: ["tech_lead"] });
    const p = await pat(e);
    const kick = vi.fn(); const roster = vi.fn(); const set = vi.fn();
    const deps = { ...e.deps, server: { kickRole: kick, broadcastRoster: roster }, setCodes: set };
    const creds = JSON.stringify(PLAYERS.map((r) => e.seats.credentials.snapshotRole(r)));
    const persists0 = e.state.persists;
    expect(JSON.parse(e.files.aiRoles).v).toBe(1);
    expect(await setAiRoles(deps, ["tech_lead"], false)).toEqual([]);
    expect(e.seats.aiRoles!.includeInGroup).toBe(false);
    expect(JSON.parse(e.files.aiRoles)).toEqual({ v: 2, ...BIND, roles: ["tech_lead"], includeInGroup: false });
    expect(e.state.persists - persists0).toBe(1);
    expect(e.written).toHaveLength(0); // no code issued
    expect(set).not.toHaveBeenCalled();
    expect(kick).not.toHaveBeenCalled();
    expect(roster).not.toHaveBeenCalled();
    expect(JSON.stringify(PLAYERS.map((r) => e.seats.credentials.snapshotRole(r)))).toBe(creds);
    expect(e.seats.consent.hasEntry("account_manager")).toBe(true);
    expect(p.ws.readyState).toBe(p.ws.OPEN);
    expect(e.current().verify("account_manager", e.plain.account_manager!)).toBe(true);
  });

  it("the same option again is a no-op that writes nothing", async () => {
    const e = await setup({ aiRoles: ["tech_lead"] });
    expect(await setAiRoles(e.deps, ["tech_lead"], true)).toEqual([]); // on and asked on: nothing
    expect(e.state.persists).toBe(0);
    expect(await setAiRoles(e.deps, ["tech_lead"], false)).toEqual([]);
    const before = stateOf(e);
    expect(await setAiRoles(e.deps, ["tech_lead"], false)).toEqual([]);
    expect(await setAiRoles(e.deps, ["tech_lead"])).toEqual([]); // absent keeps the current option
    expect(stateOf(e)).toBe(before);
    expect(e.state.persists).toBe(1);
  });

  it("a role switch without includeInGroup keeps an off option", async () => {
    const e = await setup({ aiRoles: ["tech_lead"] });
    await setAiRoles(e.deps, ["tech_lead"], false);
    const out = await setAiRoles(e.deps, ["tech_lead", "account_manager"]);
    expect(out.map((x) => x.roleId)).toEqual(["account_manager"]);
    expect(e.seats.aiRoles!.includeInGroup).toBe(false);
    expect(JSON.parse(e.files.aiRoles)).toMatchObject({ v: 2, includeInGroup: false, roles: ["account_manager", "tech_lead"] });
  });

  it("roles and option together change both in one persist", async () => {
    const e = await setup();
    const persists0 = e.state.persists;
    const out = await setAiRoles(e.deps, ["tech_lead"], false);
    expect(out.map((x) => x.roleId)).toEqual(["tech_lead"]);
    expect(e.state.persists - persists0).toBe(1);
    expect(JSON.parse(e.files.aiRoles)).toMatchObject({ v: 2, includeInGroup: false, roles: ["tech_lead"] });
    expect(e.seats.aiRoles!.includeInGroup).toBe(false);
  });

  it("a failed persist restores the option (option only, and with roles)", async () => {
    const e = await setup({ aiRoles: ["tech_lead"] });
    const filesBefore = JSON.stringify(e.files);
    e.state.persistFails = true;
    await expect(setAiRoles(e.deps, ["tech_lead"], false)).rejects.toThrow("disk full");
    expect(e.seats.aiRoles!.includeInGroup).toBe(true);
    expect(JSON.stringify(e.files)).toBe(filesBefore);
    await expect(setAiRoles(e.deps, ["account_manager"], false)).rejects.toThrow("disk full");
    expect(e.seats.aiRoles!.includeInGroup).toBe(true);
    expect(e.seats.aiRoles!.list()).toEqual(["tech_lead"]);
    expect(JSON.stringify(e.files)).toBe(filesBefore);
  });

  it("an option change after the start is refused \"AI roles can only be changed before the start\"", async () => {
    const e = await setup({ aiRoles: ["tech_lead"] });
    await pat(e);
    const d = await seat(e.port, "delivery_lead", e.plain.delivery_lead!, "dana", "Dana");
    await consent(d, e.seats, "delivery_lead", "dana");
    await seat(e.port, "tech_lead", e.plain.tech_lead!, "bot1");
    await e.host.start();
    const before = stateOf(e);
    expect(await refusal(setAiRoles(e.deps, ["tech_lead"], false))).toBe("AI roles can only be changed before the start");
    expect(stateOf(e)).toBe(before);
    expect(e.seats.aiRoles!.includeInGroup).toBe(true);
  });

  it("includeInGroup false with roles [] under notice v1 is allowed; a defined non-boolean is invalid and changes nothing", async () => {
    const e = await setup({ noticeVersion: "v1" });
    expect(noticeNamesAiPlayers("v1")).toBe(false);
    expect(await setAiRoles(e.deps, [], false)).toEqual([]);
    expect(e.seats.aiRoles!.includeInGroup).toBe(false);
    const before = stateOf(e);
    for (const bad of ["no", 0, 1, null, {}, []]) expect(await refusal(setAiRoles(e.deps, [], bad as unknown as boolean)), JSON.stringify(bad)).toBe(AI_ROLES_REFUSED.invalid);
    expect(await refusal(setAiRoles(e.deps, ["tech_lead"], false))).toBe(AI_ROLES_REFUSED.notice);
    expect(stateOf(e)).toBe(before);
  });
});

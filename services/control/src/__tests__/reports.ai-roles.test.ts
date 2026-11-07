import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_LINK_REFUSED, NO_REPORT, NOT_READY, REPORTS_UNREADABLE, createReportService, type ReportService } from "../reports.js";
import { ControlError } from "../supervisor.js";
import { sid } from "./fake-child.js";
import { makeReportWorld, type ReportWorld } from "./report-fixture.js";

/**
 * US-0060 (slice 2c-4, Task 3, AC-0322): the explicit AI-role guard on issue and reissue (fail closed when the AI roles cannot be read) and
 * the `ai: true` display flag in links(). The AI-role set is a fake here; the reader itself is tested against real files in ai-roles.test.ts.
 */
let w: ReportWorld;
let svc: ReportService;
let ai: string[] | null;
let aiRoles: ReturnType<typeof vi.fn<(id: string) => Promise<string[] | null>>>;
const make = (): ReportService => createReportService({ config: w.config, store: w.store, secrets: [], now: () => w.clock.t, aiRoles });
beforeEach(async () => {
  // A draft review: alice and bob are draft human players.
  w = await makeReportWorld({ release: false });
  ai = [];
  aiRoles = vi.fn(async () => ai);
  svc = make();
});
afterEach(async () => { await w.cleanup(); });

const refusal = async (p: Promise<unknown>): Promise<{ code: string; message: string } | null> => {
  try { await p; return null; } catch (e) { if (e instanceof ControlError) return { code: e.code, message: e.message }; throw e; }
};
const minted = async (): Promise<number> => (await w.store.list(w.sessionId)).length;

describe("the AI-role guard on issue and reissue", () => {
  it("the refusal sentence is fixed", () => {
    expect(AI_LINK_REFUSED).toBe("AI players do not get report links.");
  });
  it("issue refuses a role that has a draft but is listed by aiRoles with AI_LINK_REFUSED and mints nothing", async () => {
    ai = ["alice"];
    expect(await refusal(svc.issue(w.sessionId, "alice"))).toEqual({ code: "conflict", message: AI_LINK_REFUSED });
    expect(await minted()).toBe(0);
    expect(aiRoles).toHaveBeenCalledWith(w.sessionId);
  });
  it("reissue refuses a role that has a draft but is listed by aiRoles with AI_LINK_REFUSED and mints nothing", async () => {
    ai = ["alice"];
    expect(await refusal(svc.reissue(w.sessionId, "alice"))).toEqual({ code: "conflict", message: AI_LINK_REFUSED });
    expect(await minted()).toBe(0);
  });
  it("issue and reissue answer 503 when aiRoles returns null", async () => {
    ai = null;
    for (const role of ["alice", "bob", "mallory"]) {
      expect(await refusal(svc.issue(w.sessionId, role))).toEqual({ code: "unavailable", message: REPORTS_UNREADABLE });
      expect(await refusal(svc.reissue(w.sessionId, role))).toEqual({ code: "unavailable", message: REPORTS_UNREADABLE });
    }
    expect(await minted()).toBe(0);
  });
  it("issue and reissue answer 503 when aiRoles throws or answers something that is not a list", async () => {
    for (const bad of [() => Promise.reject(new Error("boom")), () => Promise.resolve("alice" as unknown as string[])]) {
      aiRoles.mockImplementation(bad);
      expect(await refusal(svc.issue(w.sessionId, "alice"))).toEqual({ code: "unavailable", message: REPORTS_UNREADABLE });
      expect(await refusal(svc.reissue(w.sessionId, "alice"))).toEqual({ code: "unavailable", message: REPORTS_UNREADABLE });
    }
    expect(await minted()).toBe(0);
  });
  it("a lobby session with no review still answers NOT_READY, not 503, when aiRoles returns null", async () => {
    ai = null;
    expect(await refusal(svc.issue("other-session", "alice"))).toEqual({ code: "conflict", message: NOT_READY });
    expect(await refusal(svc.reissue("other-session", "alice"))).toEqual({ code: "conflict", message: NOT_READY });
    expect(aiRoles).not.toHaveBeenCalled();
  });
  it("a human role with a draft is still issued a link", async () => {
    ai = ["alice"];
    expect((await svc.issue(w.sessionId, "bob")).credential.role).toBe("bob");
    expect((await svc.reissue(w.sessionId, "bob")).credential.role).toBe("bob");
  });
  it("a role named __proto__ or constructor is not AI unless listed", async () => {
    ai = ["alice"];
    for (const role of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(await refusal(svc.issue(w.sessionId, role))).toEqual({ code: "conflict", message: NO_REPORT });
    }
    ai = ["__proto__", "constructor"];
    for (const role of ["__proto__", "constructor"]) {
      expect(await refusal(svc.issue(w.sessionId, role))).toEqual({ code: "conflict", message: AI_LINK_REFUSED });
    }
    expect((await svc.issue(w.sessionId, "alice")).credential.role).toBe("alice");
  });
  it("revoke still works for an AI role with a live credential", async () => {
    await w.store.issue(w.sessionId, "alice");
    ai = ["alice"];
    expect(await svc.revoke(w.sessionId, "alice")).toBe(true);
    expect(await svc.revoke(w.sessionId, "alice")).toBe(false);
  });
});

describe("links and AI roles", () => {
  it("links lists an AI role with a live credential as ai: true", async () => {
    const { credential } = await w.store.issue(w.sessionId, "alice");
    ai = ["alice"];
    const l = await svc.links(w.sessionId);
    expect(l.roles.find((r) => r.role === "alice")).toEqual({ role: "alice", credential, selfRated: expect.anything(), draft: true, ai: true });
  });
  it("links omits an AI role without a credential", async () => {
    ai = ["alice"];
    expect((await svc.links(w.sessionId)).roles.map((r) => r.role)).toEqual(["bob"]);
  });
  it("links leaves human roles unchanged", async () => {
    const before = await svc.links(w.sessionId);
    ai = ["alice"];
    const after = await make().links(w.sessionId);
    expect(after.roles.find((r) => r.role === "bob")).toEqual(before.roles.find((r) => r.role === "bob"));
    expect(Object.hasOwn(after.roles.find((r) => r.role === "bob")!, "ai")).toBe(false);
    expect(before.roles.every((r) => !Object.hasOwn(r, "ai"))).toBe(true);
  });
  it("links treats a null AI-role set as unknown: nothing marked, nothing hidden", async () => {
    await w.store.issue(w.sessionId, "alice");
    ai = null;
    const l = await svc.links(w.sessionId);
    expect(l.roles.map((r) => r.role)).toEqual(["alice", "bob"]);
    expect(l.roles.every((r) => !Object.hasOwn(r, "ai"))).toBe(true);
    expect(l.state).toBe("ready");
  });
  it("links treats a throwing aiRoles as unknown", async () => {
    aiRoles.mockImplementation(() => Promise.reject(new Error("boom")));
    expect((await svc.links(w.sessionId)).roles.map((r) => r.role)).toEqual(["alice", "bob"]);
  });
  it("links does not call aiRoles when there is no review and no live credential", async () => {
    expect(await svc.links("other-session")).toEqual({ state: "not_ready", players: null, roles: [] });
    expect(aiRoles).not.toHaveBeenCalled();
  });
  it("links calls aiRoles for a session with no review but a live credential", async () => {
    const other = sid(9);
    await w.store.issue(other, "alice");
    ai = ["alice"];
    const l = await svc.links(other);
    expect(l.state).toBe("not_ready");
    expect(l.roles.map((r) => [r.role, r.ai])).toEqual([["alice", true]]);
    expect(aiRoles).toHaveBeenCalledWith(other);
  });
  it("aiRoles is read once per session across repeated links calls", async () => {
    ai = ["alice"];
    for (let i = 0; i < 3; i++) await svc.links(w.sessionId);
    expect(aiRoles).toHaveBeenCalledTimes(1);
  });
  it("a null result is not cached", async () => {
    ai = null;
    expect((await svc.links(w.sessionId)).roles.map((r) => r.role)).toEqual(["alice", "bob"]);
    ai = ["alice"];
    expect((await svc.links(w.sessionId)).roles.map((r) => r.role)).toEqual(["bob"]);
    expect(aiRoles).toHaveBeenCalledTimes(2);
  });
  it("the cache holds at most 64 sessions and drops the oldest", async () => {
    const ids = Array.from({ length: 65 }, (_, i) => sid(100 + i));
    for (const id of ids) await w.store.issue(id, "alice");
    for (const id of ids) await svc.links(id);
    expect(aiRoles).toHaveBeenCalledTimes(65);
    await svc.links(ids[64]!); // still cached
    expect(aiRoles).toHaveBeenCalledTimes(65);
    await svc.links(ids[0]!); // dropped when the 65th was added
    expect(aiRoles).toHaveBeenCalledTimes(66);
  });
  it("issue and reissue read the AI roles afresh, not from the links cache", async () => {
    ai = [];
    await svc.links(w.sessionId);
    ai = ["alice"];
    expect(await refusal(svc.issue(w.sessionId, "alice"))).toEqual({ code: "conflict", message: AI_LINK_REFUSED });
  });
});

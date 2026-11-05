import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectSecrets } from "@acr/runtime/reports";
import { writeFile } from "node:fs/promises";
import { ReportAccessStore } from "../report-access.js";
import { NO_REPORT, NOT_READY, REPORTS_UNREADABLE, REPORT_UNAVAILABLE, createReportService, type ReportService } from "../reports.js";
import { ControlError } from "../supervisor.js";
import { makeReportWorld, type ReportWorld } from "./report-fixture.js";

let w: ReportWorld;
let svc: ReportService;
beforeEach(async () => {
  w = await makeReportWorld();
  svc = createReportService({ config: w.config, store: w.store, secrets: collectSecrets({}), now: () => w.clock.t });
});
afterEach(async () => { await w.cleanup(); });

const refusal = async (p: Promise<unknown>): Promise<{ code: string; message: string } | null> => {
  try { await p; return null; } catch (e) { if (e instanceof ControlError) return { code: e.code, message: e.message }; throw e; }
};
const DAY = 86_400_000;
const store_list = (world: ReportWorld) => world.store.list(world.sessionId);

describe("links", () => {
  it("is ready with the released roles and their live credential", async () => {
    expect(await svc.links(w.sessionId)).toEqual({ state: "ready", roles: [{ role: "alice", credential: null }, { role: "bob", credential: null }] });
    const { credential } = await svc.issue(w.sessionId, "alice");
    expect((await svc.links(w.sessionId)).roles[0]).toEqual({ role: "alice", credential });
  });
  it("is not ready when no review resolves", async () => {
    expect(await svc.links("other-session")).toEqual({ state: "not_ready", roles: [] });
  });
  it("keeps a role with a live link listed after its report is withdrawn, so it can be revoked", async () => {
    await svc.issue(w.sessionId, "alice");
    await w.run(["withdraw", w.rel, "alice", "--reason", "wrong", "--by", "kamal"]);
    const l = await svc.links(w.sessionId);
    expect(l.roles.map((r) => r.role)).toContain("alice");
    expect(l.roles.find((r) => r.role === "alice")!.credential).not.toBeNull();
  });
  it("does not list a revoked or expired credential as the role's link", async () => {
    await svc.issue(w.sessionId, "alice");
    await svc.revoke(w.sessionId, "alice");
    expect((await svc.links(w.sessionId)).roles.find((r) => r.role === "alice")!.credential).toBeNull();
    await svc.issue(w.sessionId, "bob");
    w.clock.t += 91 * DAY;
    expect((await svc.links(w.sessionId)).roles.find((r) => r.role === "bob")?.credential ?? null).toBeNull();
  });
});

describe("issue and reissue", () => {
  it("refuses a role that is not released, with the fixed sentence and no id echoed", async () => {
    for (const role of ["mallory", "group"]) {
      const r = await refusal(svc.issue(w.sessionId, role));
      expect(r).toEqual({ code: "conflict", message: NO_REPORT });
      expect(NO_REPORT).toBe("There is no released report to link for this role.");
      expect(r!.message).not.toContain(role);
      expect(await refusal(svc.reissue(w.sessionId, role))).toEqual({ code: "conflict", message: NO_REPORT });
    }
  });
  it("refuses when nothing resolves, with the fixed sentence and no path or id", async () => {
    const r = await refusal(svc.issue("other-session", "alice"));
    expect(r).toEqual({ code: "conflict", message: NOT_READY });
    expect(NOT_READY).toBe("No reports are ready for this session yet. Run evaluate, then moderate open and release, from the terminal (see the guide).");
    expect(r!.message).not.toContain(w.root);
    expect(await refusal(svc.reissue("other-session", "alice"))).toEqual({ code: "conflict", message: NOT_READY });
  });
  it("refuses when the review is a draft (nothing released)", async () => {
    await w.cleanup();
    w = await makeReportWorld({ release: false });
    svc = createReportService({ config: w.config, store: w.store, secrets: [], now: () => w.clock.t });
    expect(await refusal(svc.issue(w.sessionId, "alice"))).toEqual({ code: "conflict", message: NO_REPORT });
  });
  it("an AI role named in the group draft cannot get a link and is never listed", async () => {
    await w.cleanup();
    w = await makeReportWorld({ aiRoles: ["ai1"] });
    svc = createReportService({ config: w.config, store: w.store, secrets: [], now: () => w.clock.t });
    expect(await refusal(svc.issue(w.sessionId, "ai1"))).toEqual({ code: "conflict", message: NO_REPORT });
    expect(await refusal(svc.reissue(w.sessionId, "ai1"))).toEqual({ code: "conflict", message: NO_REPORT });
    expect((await svc.links(w.sessionId)).roles.map((r) => r.role)).toEqual(["alice", "bob"]);
  });
  it("a second issue for a live pair is a conflict", async () => {
    await svc.issue(w.sessionId, "alice");
    expect((await refusal(svc.issue(w.sessionId, "alice")))!.code).toBe("conflict");
  });
  it("reissue returns the new token once; the old one stops working", async () => {
    const first = await svc.issue(w.sessionId, "alice");
    const second = await svc.reissue(w.sessionId, "alice");
    expect(second.token).not.toBe(first.token);
    expect(await svc.exchange(first.token)).toBeNull();
    expect(await svc.exchange(second.token)).toEqual({ credentialId: second.credential.id, sessionId: w.sessionId, role: "alice", expiresAt: second.credential.expiresAt });
    expect((await svc.links(w.sessionId)).roles.find((r) => r.role === "alice")!.credential?.id).toBe(second.credential.id);
  });
});

describe("revoke", () => {
  it("works whatever state the report is in, and is idempotent", async () => {
    const { token } = await svc.issue(w.sessionId, "alice");
    await w.run(["withdraw", w.rel, "alice", "--reason", "wrong", "--by", "kamal"]);
    expect(await svc.revoke(w.sessionId, "alice")).toBe(true);
    expect(await svc.revoke(w.sessionId, "alice")).toBe(false);
    expect(await svc.exchange(token)).toBeNull();
  });
  it("works even when no review resolves any more", async () => {
    await svc.issue(w.sessionId, "alice");
    await w.removeReports();
    expect(await svc.revoke(w.sessionId, "alice")).toBe(true);
  });
});

describe("exchange", () => {
  it("returns null for an unknown, revoked, expired, wrong-secret and malformed token", async () => {
    const { token, credential } = await svc.issue(w.sessionId, "alice");
    const other = await svc.issue(w.sessionId, "bob");
    expect(await svc.exchange(token)).not.toBeNull();
    const id = token.split(".")[0]!;
    const wrongSecret = `${id}.${"A".repeat(22)}`;
    const unknown = `${"B".repeat(11)}.${token.split(".")[1]}`;
    for (const t of [wrongSecret, unknown, "", "x", `${token}x`, token.replace(".", "_"), "a".repeat(64), `${id}.`]) expect(await svc.exchange(t)).toBeNull();
    await svc.revoke(w.sessionId, "bob");
    expect(await svc.exchange(other.token)).toBeNull();
    w.clock.t = credential.expiresAt; // dead at exactly expiresAt
    expect(await svc.exchange(token)).toBeNull();
  });
});

describe("read", () => {
  it("returns the released view for the credential's role", async () => {
    const { credential } = await svc.issue(w.sessionId, "alice");
    const r = await svc.read(w.sessionId, credential.id);
    expect(r.status).toBe(200);
    if (r.status !== 200 || r.body.state !== "released") throw new Error("expected released");
    expect(r.body.view.kind).toBe("released");
    expect(r.body.view.markdown.own.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.body)).not.toContain(credential.id);
  });
  it("works on a re-run folder (<id>-2)", async () => {
    const { credential } = await svc.issue(w.sessionId, "alice");
    await w.moveToRerun();
    const r = await svc.read(w.sessionId, credential.id);
    expect(r.status).toBe(200);
    expect(r.status === 200 && r.body.state).toBe("released");
  });
  it("after revoke, for another session's id, for an unknown id and for a malformed id: all 404", async () => {
    const { credential } = await svc.issue(w.sessionId, "alice");
    expect(await svc.read("other-session", credential.id)).toEqual({ status: 404 });
    expect(await svc.read(w.sessionId, "A".repeat(11))).toEqual({ status: 404 });
    expect(await svc.read(w.sessionId, "../etc")).toEqual({ status: 404 });
    await svc.revoke(w.sessionId, "alice");
    expect(await svc.read(w.sessionId, credential.id)).toEqual({ status: 404 });
  });
  it("a read with the wrong session does not touch lastUsedAt", async () => {
    const { credential } = await svc.issue(w.sessionId, "alice");
    const before = readFileSync(w.file, "utf8");
    w.clock.t += 60 * 60_000;
    expect(await svc.read("other-session", credential.id)).toEqual({ status: 404 });
    expect(readFileSync(w.file, "utf8")).toBe(before);
    expect((await svc.read(w.sessionId, credential.id)).status).toBe(200);
    expect((await store_list(w))[0]!.lastUsedAt).toBe(w.clock.t);
  });
  it("is dead at exactly expiresAt", async () => {
    const { credential } = await svc.issue(w.sessionId, "alice");
    w.clock.t = credential.expiresAt - 1;
    expect((await svc.read(w.sessionId, credential.id)).status).toBe(200);
    w.clock.t = credential.expiresAt;
    expect(await svc.read(w.sessionId, credential.id)).toEqual({ status: 404 });
  });
  it("a live credential whose report is withdrawn, or whose folder is gone, reads as not_released", async () => {
    const { credential } = await svc.issue(w.sessionId, "alice");
    await w.run(["withdraw", w.rel, "alice", "--reason", "wrong", "--by", "kamal"]);
    expect(await svc.read(w.sessionId, credential.id)).toEqual({ status: 200, body: { state: "not_released" } });
    await w.removeReports();
    expect(await svc.read(w.sessionId, credential.id)).toEqual({ status: 200, body: { state: "not_released" } });
  });
  it("a corrupt review is 503", async () => {
    const { credential } = await svc.issue(w.sessionId, "alice");
    await w.corrupt();
    expect(await svc.read(w.sessionId, credential.id)).toEqual({ status: 503 });
  });
  it("the store file holds no token and no secret", async () => {
    const { token } = await svc.issue(w.sessionId, "alice");
    const text = readFileSync(w.file, "utf8");
    expect(text).not.toContain(token);
    expect(text).not.toContain(token.split(".")[1]!);
  });
});

describe("storage and reader failures", () => {
  it("a corrupt store file is unavailable on exchange and read (file untouched), logged once a minute with a fixed line", async () => {
    const logs: string[] = [];
    svc = createReportService({ config: w.config, store: w.store, secrets: [], now: () => w.clock.t, log: (m) => logs.push(m) });
    const { token, credential } = await svc.issue(w.sessionId, "alice");
    await writeFile(w.file, "garbage");
    const before = readFileSync(w.file);
    expect(await refusal(svc.exchange(token))).toEqual({ code: "unavailable", message: REPORT_UNAVAILABLE });
    expect(await svc.read(w.sessionId, credential.id)).toEqual({ status: 503 });
    expect(await refusal(svc.exchange(token))).not.toBeNull();
    expect(readFileSync(w.file).equals(before)).toBe(true);
    expect(logs).toEqual(["report-access store unreadable"]);
    w.clock.t += 61_000;
    await svc.read(w.sessionId, credential.id);
    expect(logs).toEqual(["report-access store unreadable", "report-access store unreadable"]);
  });
  it("refusals for unknown, revoked and expired tokens stay null / 404 and log nothing", async () => {
    const logs: string[] = [];
    svc = createReportService({ config: w.config, store: w.store, secrets: [], now: () => w.clock.t, log: (m) => logs.push(m) });
    const a = await svc.issue(w.sessionId, "alice");
    const b = await svc.issue(w.sessionId, "bob");
    expect(await svc.exchange(`${"B".repeat(11)}.${"C".repeat(22)}`)).toBeNull();
    await svc.revoke(w.sessionId, "alice");
    expect(await svc.exchange(a.token)).toBeNull();
    expect(await svc.read(w.sessionId, a.credential.id)).toEqual({ status: 404 });
    w.clock.t = b.credential.expiresAt;
    expect(await svc.exchange(b.token)).toBeNull();
    expect(await svc.read(w.sessionId, b.credential.id)).toEqual({ status: 404 });
    expect(logs).toEqual([]);
  });
  it("a failed lastUsedAt write does not refuse the read or the exchange", async () => {
    let fail = false;
    const store = new ReportAccessStore({ file: w.file, days: 90, now: () => w.clock.t }, { beforeWrite: async () => { if (fail) throw new Error("disk full"); } });
    svc = createReportService({ config: w.config, store, secrets: [], now: () => w.clock.t });
    const { token, credential } = await svc.issue(w.sessionId, "alice");
    fail = true;
    w.clock.t += 60 * 60_000;
    expect((await svc.read(w.sessionId, credential.id)).status).toBe(200);
    expect((await svc.exchange(token))?.credentialId).toBe(credential.id);
    expect((await store.list(w.sessionId))[0]!.lastUsedAt).toBeUndefined();
  });
  it("an unreadable reader says so (fixed sentence, logged) instead of the evaluate hint; none still says the hint", async () => {
    const logs: string[] = [];
    await w.corrupt();
    svc = createReportService({ config: w.config, store: w.store, secrets: [], now: () => w.clock.t, log: (m) => logs.push(m) });
    expect(await refusal(svc.issue(w.sessionId, "alice"))).toEqual({ code: "unavailable", message: REPORTS_UNREADABLE });
    expect(await refusal(svc.reissue(w.sessionId, "alice"))).toEqual({ code: "unavailable", message: REPORTS_UNREADABLE });
    expect(await svc.links(w.sessionId)).toEqual({ state: "unavailable", roles: [] });
    expect(logs).toEqual(["report reader unavailable"]);
    expect(await refusal(svc.issue("other-session", "alice"))).toEqual({ code: "conflict", message: NOT_READY });
    expect(REPORTS_UNREADABLE).toBe("The reports for this session cannot be read. Check them with moderate status.");
  });
  it("links still lists a live link when the reader is unavailable, so it can be revoked", async () => {
    await svc.issue(w.sessionId, "alice");
    await w.corrupt();
    const l = await svc.links(w.sessionId);
    expect(l.state).toBe("unavailable");
    expect(l.roles.map((r) => r.role)).toEqual(["alice"]);
  });
});

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectSecrets } from "@acr/runtime/reports";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { writeReports } from "../../../runtime/src/evaluator/report-write.js";
import { sampleEvaluation } from "../../../runtime/src/evaluator/__tests__/fixtures.js";
import { fixedClock, makeFold } from "../../../runtime/src/review/__tests__/fixtures.js";
import { sealEntries } from "../../../runtime/src/review/review-log.js";
import { loadReview, supersedeReview } from "../../../runtime/src/review/store.js";
import { REVIEW_FILE, ZERO_HASH, type Entry } from "../../../runtime/src/review/types.js";
import { WRITE_OLD_SCHEMA, createParticipantWriteService } from "../participant-writes.js";
import { ReportAccessStore } from "../report-access.js";
import { NO_REPORT, NOT_READY, REPORTS_UNREADABLE, REPORT_UNAVAILABLE, createReportService, type ReportService } from "../reports.js";
import { ControlError } from "../supervisor.js";
import { makeReportWorld, type ReportWorld } from "./report-fixture.js";

// Lets one test make the progress read unavailable while everything else in the runtime stays real.
let progressDown = false;
vi.mock("@acr/runtime/participant", async (orig) => {
  const m = await orig<typeof import("@acr/runtime/participant")>();
  return { ...m, selfRatingProgress: (...a: Parameters<typeof m.selfRatingProgress>) => (progressDown ? Promise.resolve({ kind: "unavailable" as const }) : m.selfRatingProgress(...a)) };
});

let w: ReportWorld;
let svc: ReportService;
beforeEach(async () => {
  progressDown = false;
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
    expect(await svc.links(w.sessionId)).toEqual({ state: "ready", players: { rated: 0, total: 0 }, roles: [{ role: "alice", credential: null, selfRated: null, draft: false }, { role: "bob", credential: null, selfRated: null, draft: false }] });
    const { credential } = await svc.issue(w.sessionId, "alice");
    expect((await svc.links(w.sessionId)).roles[0]).toEqual({ role: "alice", credential, selfRated: null, draft: false });
  });
  it("is not ready when no review resolves", async () => {
    expect(await svc.links("other-session")).toEqual({ state: "not_ready", players: null, roles: [] });
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
  it("refuses a role that has no report, with the fixed sentence and no id echoed", async () => {
    for (const role of ["mallory", "group"]) {
      const r = await refusal(svc.issue(w.sessionId, role));
      expect(r).toEqual({ code: "conflict", message: NO_REPORT });
      expect(NO_REPORT).toBe("There is no report to link for this role.");
      expect(r!.message).not.toContain(role);
      expect(await refusal(svc.reissue(w.sessionId, role))).toEqual({ code: "conflict", message: NO_REPORT });
    }
  });
  it("refuses when nothing resolves, with the fixed sentence and no path or id", async () => {
    const r = await refusal(svc.issue("other-session", "alice"));
    expect(r).toEqual({ code: "conflict", message: NOT_READY });
    expect(NOT_READY).toBe("No reports are ready for this session yet. Run evaluate and moderate open, from the terminal (see the guide).");
    expect(r!.message).not.toContain(w.root);
    expect(await refusal(svc.reissue("other-session", "alice"))).toEqual({ code: "conflict", message: NOT_READY });
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
    expect(await svc.links(w.sessionId)).toEqual({ state: "unavailable", players: null, roles: [] });
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

// ---- draft reports (slice 2c-2) ----
const draftWorld = async (opts: Parameters<typeof makeReportWorld>[0] = {}) => {
  await w.cleanup();
  w = await makeReportWorld({ release: false, ...opts });
  svc = createReportService({ config: w.config, store: w.store, secrets: [], now: () => w.clock.t });
};
/** Re-seals the live review with its opener's schema replaced, so a released review can be made a /1 one. */
const asSchema1 = async (): Promise<void> => {
  const l = await loadReview(w.dir);
  const entries = l.events.map((e): Entry => ({ actor: e.actor, body: e, ...(e.carriedFrom ? { carriedFrom: e.carriedFrom } : {}) }));
  const first = entries[0]!.body as { schema: string };
  entries[0] = { ...entries[0]!, body: { ...first, schema: "acr.review/1" } as never };
  const sealed = sealEntries([], ZERO_HASH, entries, fixedClock());
  await writeFile(path.join(w.dir, REVIEW_FILE), sealed.map((e) => `${JSON.stringify(e)}\n`).join(""));
};
const rate = (role: string, spec: string) => w.run(["self-assess", w.rel, "--role", role, "--rate", spec, "--by", "kamal"]);

describe("draft reports: the link rule", () => {
  it("a draft human player can be issued, reissued and revoked", async () => {
    await draftWorld();
    const a = await svc.issue(w.sessionId, "alice");
    const b = await svc.reissue(w.sessionId, "alice");
    expect(b.token).not.toBe(a.token);
    expect(await svc.revoke(w.sessionId, "alice")).toBe(true);
    expect((await svc.reissue(w.sessionId, "bob")).credential.role).toBe("bob");
  });
  it("a withdrawn one cannot be issued or reissued but can be revoked", async () => {
    const { credential } = await svc.issue(w.sessionId, "alice");
    await w.run(["withdraw", w.rel, "alice", "--reason", "wrong", "--by", "kamal"]);
    expect(await refusal(svc.reissue(w.sessionId, "alice"))).toEqual({ code: "conflict", message: NO_REPORT });
    expect(await svc.revoke(w.sessionId, "alice")).toBe(true);
    expect(await refusal(svc.issue(w.sessionId, "alice"))).toEqual({ code: "conflict", message: NO_REPORT });
    expect(credential.role).toBe("alice");
  });
  it("an AI role never gets a link, in a draft review either", async () => {
    await draftWorld({ aiRoles: ["ai1"] });
    expect(await refusal(svc.issue(w.sessionId, "ai1"))).toEqual({ code: "conflict", message: NO_REPORT });
    expect(await refusal(svc.reissue(w.sessionId, "ai1"))).toEqual({ code: "conflict", message: NO_REPORT });
    expect((await svc.links(w.sessionId)).roles.map((r) => r.role)).toEqual(["alice", "bob"]);
  });
  it("the group and an unknown role are refused", async () => {
    await draftWorld();
    for (const role of ["group", "mallory"]) expect(await refusal(svc.issue(w.sessionId, role))).toEqual({ code: "conflict", message: NO_REPORT });
  });
});

describe("draft reports: read states", () => {
  it("gives self_assess with the form for a draft", async () => {
    await draftWorld();
    const { credential } = await svc.issue(w.sessionId, "alice");
    await rate("alice", "listening=3");
    const r = await svc.read(w.sessionId, credential.id);
    if (r.status !== 200 || r.body.state !== "self_assess") throw new Error("expected self_assess");
    expect(r.body.criteria.length).toBeGreaterThan(0);
    expect(r.body.scale.length).toBeGreaterThan(0);
    expect(r.body.existing).toMatchObject({ listening: { level: 3 } });
    expect(JSON.stringify(r.body)).not.toContain(credential.id);
  });
  it("gives released for a released report", async () => {
    const { credential } = await svc.issue(w.sessionId, "alice");
    const r = await svc.read(w.sessionId, credential.id);
    expect(r.status === 200 && r.body.state).toBe("released");
  });
  it("gives closed for a draft whose self-rating was closed by a supersede", async () => {
    const { credential } = await svc.issue(w.sessionId, "alice");
    const next = await writeReports(await sampleEvaluation(), { outDir: w.root, evaluator: { provider: "scripted mock", scripted: true, rubricHash: "h1", variant: "v1" } });
    await supersedeReview(w.dir, next.dir, { by: "kamal", now: fixedClock() });
    expect((await loadReview(next.dir)).view.subjects.get("alice")!.selfClosed).toBe(true);
    expect(await svc.read(w.sessionId, credential.id)).toEqual({ status: 200, body: { state: "closed" } });
    // links still lists that draft as a normal draft
    expect((await svc.links(w.sessionId)).roles.map((r) => r.role)).toEqual(["alice", "bob"]);
  });
  it("gives old_schema for a draft in a /1 review", async () => {
    await draftWorld();
    const { credential } = await svc.issue(w.sessionId, "alice");
    const l = await loadReview(w.dir);
    await writeFile(path.join(w.dir, REVIEW_FILE), makeFold(l.drafts, { schema: "acr.review/1" }).log().map((e) => `${JSON.stringify(e)}\n`).join(""));
    expect(await svc.read(w.sessionId, credential.id)).toEqual({ status: 200, body: { state: "old_schema" } });
  });
  it("gives not_released for a withdrawn report", async () => {
    const { credential } = await svc.issue(w.sessionId, "alice");
    await w.run(["withdraw", w.rel, "alice", "--reason", "wrong", "--by", "kamal"]);
    expect(await svc.read(w.sessionId, credential.id)).toEqual({ status: 200, body: { state: "not_released" } });
  });
  it("a released /1 review still reads released and a write to it answers old_schema", async () => {
    const { credential } = await svc.issue(w.sessionId, "alice");
    await asSchema1();
    expect((await loadReview(w.dir)).view.opened.schema).toBe("acr.review/1");
    const r = await svc.read(w.sessionId, credential.id);
    expect(r.status === 200 && r.body.state).toBe("released");
    const writes = createParticipantWriteService({ config: w.config, store: w.store, secrets: [], now: () => w.clock.t, sleep: async () => {}, random: () => 0.5 });
    expect(await writes.respond(w.sessionId, credential.id, { text: "fair" })).toMatchObject({ status: 409, code: "old_schema", message: WRITE_OLD_SCHEMA });
  });
  it("a corrupt review is still 503", async () => {
    await draftWorld();
    const { credential } = await svc.issue(w.sessionId, "alice");
    await w.corrupt();
    expect(await svc.read(w.sessionId, credential.id)).toEqual({ status: 503 });
  });
});

describe("draft reports: links", () => {
  it("lists draft and released roles with selfRated and the players summary", async () => {
    await draftWorld();
    await rate("alice", "listening=3");
    await rate("alice", "discovery=na");
    const l = await svc.links(w.sessionId);
    const total = (await loadReview(w.dir)).view.subjects.get("alice")!.criteria.length;
    expect(l).toEqual({
      state: "ready",
      players: { rated: 1, total: 2 },
      roles: [{ role: "alice", credential: null, selfRated: { rated: 2, total }, draft: true }, { role: "bob", credential: null, selfRated: { rated: 0, total }, draft: true }],
    });
  });
  it("a released role has selfRated null while a draft one has its counts", async () => {
    await w.cleanup();
    w = await makeReportWorld({ release: false });
    svc = createReportService({ config: w.config, store: w.store, secrets: [], now: () => w.clock.t });
    expect((await w.run(["release", w.rel, "alice", "--by", "kamal"])).code).toBe(0);
    const l = await svc.links(w.sessionId);
    expect(l.roles.find((r) => r.role === "alice")!.selfRated).toBeNull();
    expect(l.roles.find((r) => r.role === "bob")!.selfRated).toMatchObject({ rated: 0 });
    expect(l.players).toEqual({ rated: 0, total: 1 });
  });
  it("when progress is unavailable the draft roles are still listed with selfRated null and links never fails", async () => {
    await draftWorld();
    progressDown = true;
    const l = await svc.links(w.sessionId);
    expect(l).toEqual({ state: "ready", players: null, roles: [{ role: "alice", credential: null, selfRated: null, draft: true }, { role: "bob", credential: null, selfRated: null, draft: true }] });
  });
  it("a released role is draft:false and a draft one draft:true, with progress readable and unreadable", async () => {
    await w.cleanup();
    w = await makeReportWorld({ release: false });
    svc = createReportService({ config: w.config, store: w.store, secrets: [], now: () => w.clock.t });
    expect((await w.run(["release", w.rel, "alice", "--by", "kamal"])).code).toBe(0);
    for (const down of [false, true]) {
      progressDown = down;
      const l = await svc.links(w.sessionId);
      expect(l.roles.map((r) => [r.role, r.draft])).toEqual([["alice", false], ["bob", true]]);
    }
  });
});

describe("sentences mirrored in the web app", () => {
  it("the panel's not-ready sentence and the BFF's known conflicts equal control's NOT_READY and NO_REPORT", () => {
    const web = path.resolve(__dirname, "../../../../apps/web/src");
    const panel = readFileSync(path.join(web, "lib/console-api.ts"), "utf8");
    const handlers = readFileSync(path.join(web, "server/report-handlers.ts"), "utf8");
    expect(panel).toContain(JSON.stringify(NOT_READY));
    expect(handlers).toContain(JSON.stringify(NOT_READY));
    expect(handlers).toContain(JSON.stringify(NO_REPORT));
  });
});

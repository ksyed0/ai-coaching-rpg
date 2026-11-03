import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadScenario, type Scenario } from "@acr/script";
import { FakeClock } from "../clock.js";
import { SessionStoreError, openSession, type OpenedSession } from "../session-store.js";

// Seams: make the credentials write fail, or the Nth removal of the AI-role file fail (a hook that throws simulates the failure).
const hooks = vi.hoisted(() => ({ failCredWrite: false, failAiRemoveCall: 0, aiRemoveCalls: 0 }));
vi.mock("../credentials-file.js", async (orig) => {
  const actual = await orig<typeof import("../credentials-file.js")>();
  return { ...actual, writeCredentialsFile: (...a: Parameters<typeof actual.writeCredentialsFile>) => { if (hooks.failCredWrite) throw Object.assign(new Error("boom"), { code: "EIO" }); actual.writeCredentialsFile(...a); } };
});
vi.mock("../ai-roles-file.js", async (orig) => {
  const actual = await orig<typeof import("../ai-roles-file.js")>();
  return { ...actual, removeAiRolesFile: (...a: Parameters<typeof actual.removeAiRolesFile>) => { if (++hooks.aiRemoveCalls === hooks.failAiRemoveCall) throw Object.assign(new Error("boom"), { code: "EIO" }); actual.removeAiRolesFile(...a); } };
});
const friday = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scenarios/friday-escalation");
const T0 = 2_000_000;
const V1 = { version: "v1", text: "Notice one." };
const SECRET = "SECRET-ROLE-X";
let scenario: Scenario;
let dir: string;
const open: OpenedSession[] = [];
beforeEach(async () => { hooks.failCredWrite = false; hooks.failAiRemoveCall = 0; hooks.aiRemoveCalls = 0; scenario = await loadScenario(friday); dir = await mkdtemp(path.join(os.tmpdir(), "acr-airoles-")); });
afterEach(async () => { for (const o of open.splice(0)) await o.close(); await rm(dir, { recursive: true, force: true }); });
const now = () => new Date("2031-02-03T04:05:06Z");
const openIt = async (o: { managed?: boolean; mode?: "resume" | "fresh" } = {}) => {
  const s = await openSession({ scenario, sessionId: "s", dataDir: dir, clock: new FakeClock(T0), mode: o.mode ?? "resume", now, joinCodes: true, consentNotice: V1, managed: o.managed ?? true });
  open.push(s);
  return s;
};
const crash = async (o: OpenedSession) => { o.lock.abandon(); await o.log.close(); open.splice(open.indexOf(o), 1); };
const aiFile = () => path.join(dir, "s.ai-roles.json");
const readRoles = async () => (JSON.parse(await readFile(aiFile(), "utf8")) as { roles: string[] }).roles;
const players = () => Object.values(scenario.roles).filter((r) => r.type === "player").map((r) => r.id);
/** A lobby with tech_lead as an AI role, one human seated and consenting, nothing in the log. */
const lobby = async () => {
  const a = await openIt();
  a.seats!.credentials.issue("account_manager", "Pat");
  a.seats!.consent.give("account_manager", "p", "v1", T0);
  a.seats!.aiRoles!.replace(["tech_lead"]);
  a.seats!.persist();
  return a;
};
/** A started session with tech_lead as an AI role, left running (the process crashed). */
const startedWithAi = async () => {
  const a = await lobby();
  await a.engine.start(Object.fromEntries(players().map((id) => [id, `p_${id}`])), { aiRoles: ["tech_lead"] });
  await crash(a);
};

describe("the AI-role seat file (US-0060)", () => {
  it("a managed restart of an empty log keeps {tech_lead} with the kept codes and seats", async () => {
    const a = await lobby();
    const codes = a.joinCodes!.issued!;
    await crash(a);
    const b = await openIt();
    expect(b.joinCodes!.issued).toBeNull();
    for (const [role, code] of Object.entries(codes)) expect(b.joinCodes!.codes.verify(role, code)).toBe(true);
    expect(b.seats!.credentials.nameOf("account_manager")).toBe("Pat");
    expect(b.seats!.consent.has("account_manager", "p")).toBe(true);
    expect(b.seats!.aiRoles!.list()).toEqual(["tech_lead"]);
    expect(await readRoles()).toEqual(["tech_lead"]);
  });

  it("codes that no longer fit remove the AI-role file with the seats: the reopened set is empty", async () => {
    const a = await lobby();
    await a.close(); open.pop();
    const other: Scenario = { ...scenario, meta: { ...scenario.meta, title: `${scenario.meta.title} (changed)` } };
    const otherDir = await mkdtemp(path.join(os.tmpdir(), "acr-airoles-other-"));
    try {
      const o = await openSession({ scenario: other, sessionId: "s", dataDir: otherDir, clock: new FakeClock(T0), mode: "resume", now, joinCodes: true, consentNotice: V1, managed: true });
      await o.close();
      const { copyFile } = await import("node:fs/promises");
      await copyFile(path.join(otherDir, "s.codes.json"), path.join(dir, "s.codes.json"));
    } finally { await rm(otherDir, { recursive: true, force: true }); }
    const b = await openIt();
    expect(b.joinCodes!.issued).not.toBeNull();
    expect(b.seats!.aiRoles!.list()).toEqual([]);
    expect(await readRoles()).toEqual([]);
    await crash(b);
    expect((await openIt()).seats!.aiRoles!.list()).toEqual([]);
  });

  it("SESSION_START=fresh and the rotation of an ended log remove the file", async () => {
    const a = await lobby();
    await crash(a);
    const f = await openIt({ mode: "fresh", managed: false });
    expect(f.seats!.aiRoles!.list()).toEqual([]);
    expect(await readRoles()).toEqual([]);
    f.seats!.aiRoles!.replace(["tech_lead"]); f.seats!.persist();
    await f.engine.start(Object.fromEntries(players().map((id) => [id, `p_${id}`])), { aiRoles: ["tech_lead"] });
    for (let i = 0; i < 40 && f.engine.state.status !== "ended"; i++) { await f.engine.command({ command: "advance" }); await f.engine.tick(); }
    expect(f.engine.state.status).toBe("ended");
    await f.close(); open.pop();
    const r = await openIt({ managed: false });
    expect(r.outcome).toBe("rotated");
    expect(r.seats!.aiRoles!.list()).toEqual([]);
    expect(await readRoles()).toEqual([]);
  });

  it("a lobby from before this change (no AI-role file beside kept credentials) has no AI roles and the file is written", async () => {
    const a = await lobby();
    await crash(a);
    await rm(aiFile());
    const b = await openIt();
    expect(b.joinCodes!.issued).toBeNull();
    expect(b.seats!.credentials.nameOf("account_manager")).toBe("Pat");
    expect(b.seats!.aiRoles!.list()).toEqual([]);
    expect(await readRoles()).toEqual([]);
  });

  it("when writing the AI-role file fails (a directory in its place), the credentials and consent files already hold the change and persist throws", async () => {
    const a = await openIt();
    await rm(aiFile());
    await mkdir(aiFile());
    a.seats!.credentials.issue("delivery_lead", "Quinn");
    a.seats!.consent.give("delivery_lead", "q", "v1", T0);
    expect(() => a.seats!.persist()).toThrow();
    const cred = JSON.parse(await readFile(path.join(dir, "s.credentials.json"), "utf8")) as { roles: Record<string, unknown> };
    const consent = JSON.parse(await readFile(path.join(dir, "s.consent.json"), "utf8")) as { entries: Record<string, unknown> };
    expect(Object.keys(cred.roles)).toContain("delivery_lead");
    expect(Object.keys(consent.entries)).toContain("delivery_lead");
  });

  it("persist writes the credentials, then the consent, then the AI-role file (a failure at the credentials leaves the later files untouched)", async () => {
    const a = await openIt();
    a.seats!.aiRoles!.replace(["tech_lead"]);
    a.seats!.consent.give("account_manager", "p", "v1", T0);
    await rm(path.join(dir, "s.credentials.json")); await mkdir(path.join(dir, "s.credentials.json"));
    expect(() => a.seats!.persist()).toThrow();
    expect(await readRoles()).toEqual([]); // the AI-role file was not reached
    const consent = JSON.parse(await readFile(path.join(dir, "s.consent.json"), "utf8")) as { entries: Record<string, unknown> };
    expect(Object.keys(consent.entries)).toEqual([]); // nor the consent file
  });

  it("new seats remove the AI-role file BEFORE the credentials are written: a failing credentials write leaves it absent, with an io error naming the seat files", async () => {
    const a = await lobby();
    await crash(a);
    // Force new seats with the codes KEPT (no credentials file: removeSeats does not run, only settleSeats' own removal) and make the credentials write fail.
    await rm(path.join(dir, "s.credentials.json"));
    hooks.failCredWrite = true;
    const err = await openIt().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionStoreError);
    expect(err).toMatchObject({ code: "io" });
    expect((await readdir(dir)).includes("s.ai-roles.json")).toBe(false);
  });

  it("a failing removal of the AI-role file says \"seat files\" (io, never the seats error)", async () => {
    const a = await lobby();
    await crash(a);
    await rm(path.join(dir, "s.credentials.json")); // codes kept, new seats: the only removal is the one before the new credentials
    hooks.aiRemoveCalls = 0; hooks.failAiRemoveCall = 1;
    const err = await openIt().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionStoreError);
    expect(err).toMatchObject({ code: "io" });
    expect((err as Error).message).toContain("cannot remove the previous seat files");
    expect((err as Error).message).not.toContain("consent file");
  });

  it("the file is mode 0600 and a symbolic link in its place is refused unread", async () => {
    const a = await lobby();
    expect((await stat(aiFile())).mode & 0o777).toBe(0o600);
    await crash(a);
    const target = path.join(dir, "elsewhere.json");
    await writeFile(target, JSON.stringify({ v: 1, sessionId: "s", scenarioSha256: "a".repeat(64), roles: [] }));
    await rm(aiFile()); await symlink(target, aiFile());
    const err = await openIt().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionStoreError);
    expect(err).toMatchObject({ code: "seats" });
    expect((err as Error).message).toContain("s.ai-roles.json");
    expect((err as Error).message).toContain("symlink");
  });

  it("a stale <id>.ai-roles.json.<hex>.tmp is swept on open", async () => {
    const a = await lobby();
    await crash(a);
    const tmp = path.join(dir, "s.ai-roles.json.0123456789ab.tmp");
    await writeFile(tmp, "junk");
    await openIt();
    expect((await readdir(dir)).includes("s.ai-roles.json.0123456789ab.tmp")).toBe(false);
  });

  it("discardIssuedCodes removes the empty AI-role file this start created", async () => {
    const a = await openIt();
    expect(await readRoles()).toEqual([]);
    expect(a.discardIssuedCodes()).toBe(true);
    expect((await readdir(dir)).includes("s.ai-roles.json")).toBe(false);
  });

  it("a corrupt AI-role file in a managed lobby refuses the open with SessionStoreError \"seats\" naming <id>.ai-roles.json and changes nothing", async () => {
    const a = await lobby();
    await crash(a);
    await writeFile(aiFile(), JSON.stringify({ v: 1, sessionId: "s", scenarioSha256: "a".repeat(64), roles: [SECRET] }));
    await chmod(aiFile(), 0o600);
    const before = Object.fromEntries(await Promise.all((await readdir(dir)).filter((n) => n !== "s.lock").sort().map(async (n) => [n, (await readFile(path.join(dir, n))).toString("hex")] as const)));
    const err = await openIt().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionStoreError);
    expect(err).toMatchObject({ code: "seats" });
    expect((err as Error).message).toContain("s.ai-roles.json");
    expect((err as Error).message).toContain("then human; set them again");
    expect((err as Error).message).not.toContain(SECRET);
    const after = Object.fromEntries(await Promise.all((await readdir(dir)).filter((n) => n !== "s.lock").sort().map(async (n) => [n, (await readFile(path.join(dir, n))).toString("hex")] as const)));
    expect(after).toEqual(before);
  });

  it("a started session resumes with a corrupt or symlinked AI-role file: the open succeeds and seats.aiRoles lists [\"tech_lead\"] from the log", async () => {
    await startedWithAi();
    await writeFile(aiFile(), "{ not json");
    const b = await openIt();
    expect(b.outcome).toBe("resumed");
    expect(b.seats!.aiRoles!.list()).toEqual(["tech_lead"]);
    expect(await readRoles()).toEqual(["tech_lead"]); // rewritten from the log
    await crash(b);
    const target = path.join(dir, "elsewhere.json");
    await writeFile(target, "{}");
    await rm(aiFile()); await symlink(target, aiFile());
    const c = await openIt({ managed: false });
    expect(c.outcome).toBe("resumed");
    expect(c.seats!.aiRoles!.list()).toEqual(["tech_lead"]);
    expect(await readFile(target, "utf8")).toBe("{}"); // the link's target is never written through
  });

  it("a started session whose AI-role file says [\"account_manager\"] resumes with [\"tech_lead\"] from the log and the file is rewritten to [\"tech_lead\"]", async () => {
    await startedWithAi();
    await writeFile(aiFile(), JSON.stringify({ v: 1, sessionId: "s", scenarioSha256: "a".repeat(64), roles: ["account_manager"] }));
    const b = await openIt();
    expect(b.seats!.aiRoles!.list()).toEqual(["tech_lead"]);
    expect(await readRoles()).toEqual(["tech_lead"]);
  });

  it("a started session with no AI roles resumes with an empty set", async () => {
    const a = await openIt();
    await a.engine.start(Object.fromEntries(players().map((id) => [id, `p_${id}`])));
    await crash(a);
    const b = await openIt();
    expect(b.seats!.aiRoles!.list()).toEqual([]);
    expect(await readRoles()).toEqual([]);
  });
});

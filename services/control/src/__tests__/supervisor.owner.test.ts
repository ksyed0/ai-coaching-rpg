import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControlConfig } from "../config.js";
import { OwnerStore } from "../accounts/owners.js";
import { AI_CONFIG, CODES, FakeChild, READY, flush, sid } from "./fake-child.js";
import { SessionList } from "../session-list.js";
import { ControlError, Supervisor, type SetTimer, type SpawnFn } from "../supervisor.js";

let root: string, config: ControlConfig, list: SessionList, owners: OwnerStore, children: FakeChild[], spawn: SpawnFn;
const setTimer: SetTimer = () => () => {};
const make = () => new Supervisor({
  config, list, owners, scenarios: async () => [{ id: "friday-escalation", title: "Friday" }], spawn, setTimer,
});
const start = async (sup: Supervisor, owner?: string): Promise<string> => {
  const n = children.length;
  const p = sup.create("friday-escalation", owner);
  await flush();
  children[n]!.emit({ type: "codes", codes: CODES }); children[n]!.emit(READY);
  return (await p).sessionId;
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "ctl-owner-"));
  const scenariosDir = path.join(root, "scenarios");
  mkdirSync(path.join(scenariosDir, "friday-escalation"), { recursive: true });
  config = {
    port: 1, serviceToken: "t".repeat(40), maxSessions: 5, dataDir: root, audioDir: path.join(root, "audio"), audioMinFreeMb: 2048, audioMaxRetentionDays: 30,
    sessionsDir: path.join(root, "sessions"), listFile: path.join(root, "sessions.json"), scenariosDir, logDir: path.join(root, "child-logs"), graceMs: 50, readyTimeoutMs: 5000,
    ...AI_CONFIG, ownersFile: path.join(root, "session-owners.json"),
  };
  mkdirSync(config.sessionsDir, { recursive: true });
  list = new SessionList(config.listFile);
  owners = new OwnerStore(config.ownersFile);
  children = [];
  spawn = ({ env, logFile }) => { const c = new FakeChild(env, logFile); children.push(c); return c; };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("session owners", () => {
  it("create_records_owner", async () => {
    const sup = make();
    const id = await start(sup, "acc-1");
    expect(owners.get(id)).toBe("acc-1");
    expect(sup.get(id)?.owner).toBe("acc-1");
  });

  it("create_without_owner_has_no_owner_field", async () => {
    const sup = make();
    const id = await start(sup);
    expect("owner" in sup.get(id)!).toBe(false);
    expect(owners.all()).toEqual({});
  });

  it("status_change_stop_restart_resume_and_end_preserve_owner", async () => {
    const sup = make();
    const id = await start(sup, "acc-1");
    children[0]!.exit(1);
    await flush();
    expect(sup.get(id)).toMatchObject({ status: "stopped", owner: "acc-1" });
    const restarting = sup.restart(id);
    await flush();
    children[1]!.emit({ type: "codes", codes: CODES }); children[1]!.emit(READY);
    await restarting;
    expect(sup.get(id)).toMatchObject({ status: "running", owner: "acc-1" });
    expect(sup.list()[0]).toMatchObject({ owner: "acc-1" });
    // a fresh Supervisor over the same files (a control restart) still reports it
    expect(new Supervisor({ config, list, owners: new OwnerStore(config.ownersFile), scenarios: async () => [], spawn, setTimer }).get(id)?.owner).toBe("acc-1");
    children[1]!.emit({ type: "ended" });
    expect(sup.get(id)).toMatchObject({ status: "ended", owner: "acc-1" });
  });

  it("set_owner_assigns_and_clears", async () => {
    const sup = make();
    const id = await start(sup);
    sup.setOwner(id, "acc-2");
    expect(sup.get(id)?.owner).toBe("acc-2");
    sup.setOwner(id, "acc-3");
    expect(sup.list()[0]?.owner).toBe("acc-3");
    sup.setOwner(id, null);
    expect("owner" in sup.get(id)!).toBe(false);
  });

  it("set_owner_unknown_session_is_not_found", () => {
    const sup = make();
    for (const id of ["f".repeat(32), "../x", ""]) {
      try { sup.setOwner(id, "acc-1"); throw new Error("expected throw"); }
      catch (e) { expect(e).toBeInstanceOf(ControlError); expect((e as ControlError).code).toBe("not_found"); }
    }
    expect(owners.all()).toEqual({});
  });

  it("sessions_json_is_byte_identical_with_and_without_an_owner", async () => {
    const withOwner = await (async () => { const s = make(); const id = await start(s, "acc-1"); return { id, text: readFileSync(config.listFile, "utf8") }; })();
    rmSync(config.listFile); rmSync(config.ownersFile); children = [];
    list = new SessionList(config.listFile); owners = new OwnerStore(config.ownersFile);
    const without = await (async () => { const s = make(); const id = await start(s); return { id, text: readFileSync(config.listFile, "utf8") }; })();
    expect(withOwner.text.split(withOwner.id).join("ID")).toBe(without.text.split(without.id).join("ID"));
    expect(withOwner.text).not.toContain("acc-1");
  });
  // Final review IMPORTANT 2: the owner rollback of a failed create really runs. On develop the owner is written before the session is
  // listed, so the list write failing after the owner write is the path that must clear the owner again.
  it("test_supervisor_owner_a_failed_create_after_the_owner_write_leaves_no_owner", async () => {
    class FailingList extends SessionList {
      override upsert(e: Parameters<SessionList["upsert"]>[0]): void { if (e.status === "running") throw new Error("disk full"); super.upsert(e); }
    }
    list = new FailingList(config.listFile);
    spawn = ({ env, logFile }) => { const c = new FakeChild(env, logFile); c.onKill = () => c.exit(137); children.push(c); return c; };
    const sup = new Supervisor({ config, list, owners, scenarios: async () => [{ id: "friday-escalation", title: "Friday" }], spawn, setTimer, newSessionId: () => sid(5) });
    const p = sup.create("friday-escalation", "acc-1");
    await flush();
    children[0]!.emit({ type: "codes", codes: CODES }); children[0]!.emit(READY);
    await expect(p).rejects.toMatchObject({ code: "start_failed" });
    expect(children[0]!.killed).toBeGreaterThan(0);
    expect(owners.all()).toEqual({});
    expect(existsSync(config.ownersFile) ? readFileSync(config.ownersFile, "utf8") : "").not.toContain("acc-1");
    expect(existsSync(config.listFile) ? readFileSync(config.listFile, "utf8") : "").not.toContain(sid(5));
    expect(sup.list()).toEqual([]);
  });

  it("test_supervisor_owner_a_failed_owner_write_fails_the_create_with_no_trace", async () => {
    class FailingOwners extends OwnerStore {
      override set(sessionId: string, owner: string | null): void { if (owner !== null) throw new Error("disk full"); super.set(sessionId, owner); }
    }
    owners = new FailingOwners(config.ownersFile);
    spawn = ({ env, logFile }) => { const c = new FakeChild(env, logFile); c.onKill = () => c.exit(137); children.push(c); return c; };
    const sup = new Supervisor({ config, list, owners, scenarios: async () => [{ id: "friday-escalation", title: "Friday" }], spawn, setTimer, newSessionId: () => sid(6) });
    const p = sup.create("friday-escalation", "acc-1");
    await flush();
    children[0]!.emit({ type: "codes", codes: CODES }); children[0]!.emit(READY);
    await expect(p).rejects.toMatchObject({ code: "start_failed" });
    expect(children[0]!.killed).toBeGreaterThan(0);
    expect(list.read()).toEqual([]);
    expect(existsSync(config.ownersFile) ? readFileSync(config.ownersFile, "utf8") : "").not.toContain("acc-1");
  });

  // Final review MINOR (T4 M4): a damaged session-owners.json must not break the lookups that do not need the owner (report routes, the
  // evaluate job, the restart answer), and it is logged with one fixed line per failure episode (not on every call).
  it("test_supervisor_owner_damaged_owners_file_spares_internal_lookups_and_logs_once_per_episode", async () => {
    const lines: string[] = [];
    const sup = new Supervisor({ config, list, owners, scenarios: async () => [{ id: "friday-escalation", title: "Friday" }], spawn, setTimer, log: (l) => lines.push(l) });
    const id = await start(sup, "acc-1");
    children[0]!.exit(1);
    await flush();
    writeFileSync(config.ownersFile, "{ not json", { mode: 0o600 });
    expect(sup.getWithoutOwner(id)).toEqual({ sessionId: id, scenarioId: "friday-escalation", status: "stopped" });
    expect(sup.getWithoutOwner(sid(77))).toBeUndefined();
    const restarting = sup.restart(id);
    await flush();
    children[1]!.emit({ type: "codes", codes: CODES }); children[1]!.emit(READY);
    expect(await restarting).toMatchObject({ sessionId: id, status: "running" });
    lines.length = 0;
    // the owner-carrying lookups refuse (never an owner-less answer that would hide whose session it is)
    expect(() => sup.get(id)).toThrow();
    expect(() => sup.list()).toThrow();
    expect(() => sup.get(id)).toThrow();
    expect(lines).toEqual(["session owners file is unreadable"]);
    // a good read ends the episode; the next failure logs again
    writeFileSync(config.ownersFile, JSON.stringify({ owners: { [id]: "acc-1" } }), { mode: 0o600 });
    expect(sup.get(id)?.owner).toBe("acc-1");
    writeFileSync(config.ownersFile, "{ not json", { mode: 0o600 });
    expect(() => sup.list()).toThrow();
    expect(lines).toEqual(["session owners file is unreadable", "session owners file is unreadable"]);
    expect(lines.join("\n")).not.toContain(config.ownersFile);
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario } from "@acr/script";
import { bootstrap } from "../main.js";
import { ClientMessageSchema } from "../host/protocol.js";
import { parseArgs as parseClientArgs, parseInput } from "../cli/commands.js";
import { parseDemoArgs } from "../demo/args.js";
import { isValidSessionId } from "@acr/events";
import { JsonlEventLog } from "../engine/event-log.js";
import { JoinCodes, JoinCodeRecordError } from "../engine/join-codes.js";
import { SessionLock } from "../engine/log-files.js";
import { openSession } from "../engine/session-store.js";
import { SystemClock } from "../engine/clock.js";
import { checkRoleId, writeReports } from "../evaluator/report-write.js";
import { id as reportId } from "../evaluator/report-md.js";
import { parseJoinCodesEnv } from "../demo/ctx.js";
import { renderTranscript } from "../demo/transcript-md.js";
import { earnedCheckOf } from "../agents/gm-prompt.js";
// Real bootstraps and file locks: a generous explicit limit; nothing here measures elapsed time.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

/**
 * US-0020 / AC-0062, characterisation: what each place that takes a session id, a role id or another client-supplied id accepted and
 * refused BEFORE the rules moved into one shared module. The refactor must keep every row.
 *   protocol: a transport bound only (1 to 128 characters, any content; the host then looks the id up as an OWN property or Map key)
 *   client:   the terminal client's own check (1 to 128 characters and no control character)
 *   session:  a session id, which becomes `<id>.jsonl`, `<id>.lock`, `<id>.codes.json` and a report directory name
 *   role:     the evaluator's file-safe role id (1 to 64 lower case letters, digits, `_`, `-`, and not a report file name)
 */
const long = (c: string, n: number) => c.repeat(n);
// [id, protocol, client, session, role]
const ROWS: [string, boolean, boolean, boolean, boolean][] = [
  ["local", true, true, true, true], ["a", true, true, true, true], ["a-b", true, true, true, true], ["a_b", true, true, true, true],
  ["-", true, true, true, true], ["_", true, true, true, true], ["t1", true, true, true, true],
  ["A", true, true, true, false], ["Local", true, true, true, false], ["LO1", true, true, true, false],
  ["a.b", true, true, false, false], ["a b", true, true, false, false], ["a/b", true, true, false, false], ["a\\b", true, true, false, false],
  ["../x", true, true, false, false], ["..", true, true, false, false], [".", true, true, false, false], [".hidden", true, true, false, false],
  ["x.jsonl", true, true, false, false], ["/etc/passwd", true, true, false, false], ["C:\\x", true, true, false, false],
  ["", false, false, false, false],
  ["a\n", true, false, false, false], ["\na", true, false, false, false], ["a\0", true, false, false, false], ["a\u007f", true, false, false, false],
  ["a\u0085", true, false, false, false], ["a\u009f", true, false, false, false], ["a\u202e", true, true, false, false],
  ["\u00e9", true, true, false, false], ["\uff41", true, true, false, false], ["a%2e%2e", true, true, false, false], ["a:b", true, true, false, false],
  [long("x", 64), true, true, true, true], [long("x", 65), true, true, false, false], [long("x", 128), true, true, false, false], [long("x", 129), false, false, false, false],
  [long("X", 64), true, true, true, false], [long("X", 65), true, true, false, false],
  ["__proto__", true, true, true, true], ["constructor", true, true, true, true], ["prototype", true, true, true, true], ["toString", true, true, true, false],
  ["facilitator", true, true, true, true], ["group", true, true, true, false], ["index", true, true, true, false], ["method", true, true, true, false],
  ["con", true, true, true, true], ["nul", true, true, true, true],
];
const REPORT_FILE_NAMES = new Set(["group", "index", "method"]);
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../packages/script/src/__tests__/fixtures/minimal");
let tmp: string;
beforeAll(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), "acr-idchar-")); });
afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });

describe("characterisation: the protocol's identifier bound (US-0020)", () => {
  it.each(ROWS)("join, join_facilitator, commands and expectSceneId take %j as: protocol", (id, protocol) => {
    const parses = (m: unknown) => ClientMessageSchema.safeParse(m).success;
    expect(parses({ type: "join", sessionId: id, roleId: "r", participantId: "p" })).toBe(protocol);
    expect(parses({ type: "join", sessionId: "s", roleId: id, participantId: "p" })).toBe(protocol);
    expect(parses({ type: "join", sessionId: "s", roleId: "r", participantId: id })).toBe(protocol);
    expect(parses({ type: "join_facilitator", sessionId: id })).toBe(protocol);
    expect(parses({ type: "say", text: "hi", expectSceneId: id })).toBe(protocol);
    expect(parses({ type: "command", command: { command: "fire_inject", injectId: id } })).toBe(protocol);
    expect(parses({ type: "command", command: { command: "whisper", roleId: id, text: "x" } })).toBe(protocol);
    expect(parses({ type: "command", command: { command: "release_hidden", roleId: id, fact: 1 } })).toBe(protocol);
    expect(parses({ type: "command", command: { command: "set_npc_stance", roleId: id, goals: [] } })).toBe(protocol);
  });
});

describe("characterisation: the terminal client's identifier check (US-0020)", () => {
  it.each(ROWS)("--session and --role take %j as: client", (id, _p, client) => {
    expect(parseClientArgs(["--role", "guest", "--name", "n", "--session", id]).ok).toBe(client);
    expect(parseClientArgs(["--facilitator", "--session", id]).ok).toBe(client);
    expect(parseClientArgs(["--role", id, "--name", "n"]).ok).toBe(client);
  });
  it("accepts the session it was given unchanged and defaults to local", () => {
    const r = parseClientArgs(["--role", "guest", "--name", "n", "--session", "A-b_9"]);
    expect(r.ok && r.opts.session).toBe("A-b_9");
    const d = parseClientArgs(["--facilitator"]);
    expect(d.ok && d.opts.session).toBe("local");
  });
  it.each(ROWS)("/release <role> <n> takes the role %j as: client (whitespace splits the word, so only control characters and length matter)", (id, _p, client) => {
    if (id === "" || /\s/.test(id)) return; // a typed word cannot be empty or hold whitespace
    const r = parseInput(`/release ${id} 1`, true);
    // the client bound is 128 characters here too (the protocol's, 129 is refused by the client before it is sent)
    expect(r.kind === "send").toBe(client);
  });
  it("/inject and /whisper pass the typed id on without a client-side id check (the server decides)", () => {
    expect(parseInput(`/inject ${long("x", 500)}`, true).kind).toBe("send");
    expect(parseInput("/whisper a\u0001b hello", true).kind).toBe("send");
  });
});

describe("characterisation: the session id rule (US-0020)", () => {
  it.each(ROWS)("isValidSessionId(%j)", (id, _p, _c, session) => {
    expect(isValidSessionId(id)).toBe(session);
  });

  it.each(ROWS)("the JSONL log, the demo --session option and the lock path take %j as: session", (id, _p, _c, session) => {
    const dir = path.join(tmp, "log-only");
    if (session) expect(() => new JsonlEventLog(id, dir)).not.toThrow();
    else expect(() => new JsonlEventLog(id, dir)).toThrow(/invalid session id/);
    expect(parseDemoArgs(["--session", id]).ok).toBe(session);
  });

  it("a session id never becomes a path outside its directory", () => {
    for (const [id, , , session] of ROWS) {
      if (!session) continue;
      const file = new JsonlEventLog(id, "data").file;
      expect(path.dirname(file)).toBe("data");
      expect(path.basename(file)).toBe(`${id}.jsonl`);
    }
  });

  it("bootstrap refuses a hostile SESSION_ID before touching the file system, from the environment and from .env", async () => {
    for (const [id, , , session] of ROWS) {
      if (session) continue;
      const root = await mkdtemp(path.join(tmp, "boot-"));
      const r = await bootstrap({ env: { SESSION_ID: id, SCENARIO_DIR: fixture, RUNTIME_PORT: "0" }, root, logDir: path.join(root, "data"), log: () => {}, warn: () => {} });
      expect(r.ok, JSON.stringify(id)).toBe(false);
      if (!r.ok) expect(r.errors.join("\n")).toMatch(/SESSION_ID .* is invalid: use 1 to 64 letters, digits, '_' or '-'/);
      expect(await readdir(root)).toEqual([]);
    }
  });

  it.each(["t1", "A-b_9", long("x", 64), "__proto__", "constructor"])("bootstrap starts a session called %j with its files under the data directory", async (id) => {
    const root = await mkdtemp(path.join(tmp, "boot-ok-"));
    const data = path.join(root, "data");
    const r = await bootstrap({ env: { SESSION_ID: id, SCENARIO_DIR: fixture, RUNTIME_PORT: "0" }, root, logDir: data, log: () => {}, warn: () => {}, showJoinCodes: () => {} });
    expect(r.ok).toBe(true);
    if (r.ok) await r.runtime.stop();
    const names = (await readdir(data)).sort();
    expect(names.every((n) => n.startsWith(`${id}.`))).toBe(true);
    expect(names).toContain(`${id}.codes.json`);
  });

  it("openSession refuses a hostile id and leaves nothing outside (or inside) the data directory", async () => {
    const scenario = await loadScenario(fixture);
    for (const [id, , , session] of ROWS) {
      if (session) continue;
      const root = await mkdtemp(path.join(tmp, "open-"));
      await expect(openSession({ scenario, sessionId: id, dataDir: path.join(root, "d"), clock: new SystemClock(), mode: "resume" }), JSON.stringify(id)).rejects.toThrow();
      expect(await readdir(root)).toEqual(expect.not.arrayContaining(["x.lock", "x.jsonl", "x"]));
      const inner = await readdir(path.join(root, "d")).catch(() => []);
      expect(inner).toEqual([]);
    }
  });

  it("SessionLock.acquire refuses an id that would leave the directory", () => {
    const dir = path.join(tmp, "lock-dir");
    for (const id of ["../x", "a/b", "..", "/abs"]) expect(() => SessionLock.acquire(dir, id), id).toThrow();
  });

  it("the evaluator refuses to write reports for a hostile session id and quotes a bad id as escaped text", async () => {
    for (const [id, , , session] of ROWS) {
      if (session) continue;
      await expect(writeReports({ sessionId: id } as never, { outDir: path.join(tmp, "reports"), evaluator: {} as never })).rejects.toThrow(/is not a safe directory name/);
      expect(reportId(id, [])).not.toBe(`\`${id}\``);
    }
    for (const [id, , , session] of ROWS) if (session) expect(reportId(id, [])).toBe(`\`${id}\``);
  });
});

describe("characterisation: role ids in evaluator file names and join codes (US-0020)", () => {
  it.each(ROWS)("checkRoleId(%j)", (id, _p, _c, _s, role) => {
    const ok = role && !REPORT_FILE_NAMES.has(id);
    if (ok) expect(checkRoleId(id)).toBe(id);
    else expect(() => checkRoleId(id)).toThrow();
  });

  it("checkRoleId names the reason: the character set or a reserved report file name", () => {
    expect(() => checkRoleId("A")).toThrow(/is not a safe file name/);
    expect(() => checkRoleId("group")).toThrow(/reserved for the report files/);
  });

  it.each(["facilitator", "__proto__", "constructor", "prototype"])("join codes are never issued for the reserved role %s, nor read back for it", (id) => {
    const bind = { sessionId: "s", scenarioSha256: "0".repeat(64) };
    expect(() => JoinCodes.issue([id], bind)).toThrow(/reserved id/);
    const rec = JoinCodes.issue(["guest"], bind).codes.toRecord();
    const forged = { ...rec, roles: Object.fromEntries([[id, "0".repeat(64)]]) };
    expect(() => JoinCodes.fromRecord(JSON.parse(JSON.stringify(forged)))).toThrow(JoinCodeRecordError);
  });

  it("join codes accept any other role id of 1 to 128 characters and refuse 0 or 129 when read back", () => {
    const bind = { sessionId: "s", scenarioSha256: "0".repeat(64) };
    for (const id of ["a.b", "A", long("x", 128)]) expect(() => JoinCodes.issue([id], bind)).not.toThrow();
    const rec = JoinCodes.issue(["guest"], bind).codes.toRecord();
    const withRole = (id: string) => JSON.parse(JSON.stringify({ ...rec, roles: { [id]: "0".repeat(64) } }));
    expect(() => JoinCodes.fromRecord(withRole(long("x", 128)))).not.toThrow();
    expect(() => JoinCodes.fromRecord(withRole(long("x", 129)))).toThrow(JoinCodeRecordError);
    expect(() => JoinCodes.fromRecord(withRole(""))).toThrow(JoinCodeRecordError);
  });

  it("a join codes record carries a session id of 1 to 64 characters, whatever they are", () => {
    const rec = JoinCodes.issue(["guest"], { sessionId: "s", scenarioSha256: "0".repeat(64) }).codes.toRecord();
    const withSession = (sessionId: string) => JSON.parse(JSON.stringify({ ...rec, sessionId }));
    for (const s of ["a", "a.b", long("x", 64)]) expect(() => JoinCodes.fromRecord(withSession(s))).not.toThrow();
    for (const s of ["", long("x", 65)]) expect(() => JoinCodes.fromRecord(withSession(s))).toThrow(JoinCodeRecordError);
  });
});

describe("characterisation: the demo's own readers of ids (US-0020)", () => {
  // [id, scenarioId (lower case, any length), roleKey (JOIN_CODES: either case, 1 to 128)]
  const KEYS: [string, boolean, boolean][] = [
    ["guest", true, true], ["a-b_9", true, true], ["Guest", false, true], ["a.b", false, false], ["a b", false, false], ["", false, false], ["a=b", false, false], ["a,b", false, false],
    ["../x", false, false], ["a\u0001b", false, false], ["__proto__", true, true], [long("x", 128), true, true], [long("x", 129), true, false], [long("X", 128), false, true],
  ];
  it.each(KEYS)("JOIN_CODES role key %j is accepted as: %s/%s", (id, _scenarioId, roleKey) => {
    const r = parseJoinCodesEnv(`${id}=ABCD-EFGH-JKMN`);
    expect(r.ok).toBe(roleKey && id !== "");
  });
  it.each(KEYS)("the transcript names a speaker %j by its id only when it is a scenario id", (id, scenarioId) => {
    if (id === "" || /[\n=,]/.test(id)) return;
    const md = renderTranscript({
      title: "t", meta: { mode: "mock", provider: "p", scenario: "s", date: "d", version: "1", summary: "x" },
      records: [{ kind: "dialogue", source: "scripted", speaker: id, role: id, text: "hi", atMs: 0 }], results: [],
    });
    const line = md.split("\n").find((l) => l.startsWith("**[SCRIPTED]")) ?? "";
    // a scenario id is printed as is; anything else goes through the Markdown escaper (which changes at least one character of a hostile id)
    if (scenarioId) expect(line.startsWith(`**[SCRIPTED] ${id}: hi`)).toBe(true);
    else expect(line.startsWith(`**[SCRIPTED] ${id}: hi`) && /^[a-z0-9_-]+$/.test(id)).toBe(false);
  });
  it.each(KEYS)("an earned-fact check request names the role %j only if it is a scenario id", (id, scenarioId) => {
    if (id === "" || /[\n=,]/.test(id)) return;
    const r = earnedCheckOf({ system: `intro\nEarned-fact check: role ${id}, fact 3.\nrest` });
    expect(r?.roleId ?? null).toBe(scenarioId ? id : null);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { starterOnly } from "./starter-copy.js";
import { cp, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { EventBody, SessionEvent } from "@acr/events";
import type { Rubric, Scenario } from "@acr/script";
import { loadEvaluationInput } from "../../evaluator/cli.js";
import { approveDraft, assignSplits, buildDraftRequest, draftProbes, excerptDraft, probeFileTotal, type DraftInput } from "../draft.js";
import { CalibrationInputError } from "../judge.js";
import { assignSplit, loadProbes } from "../probe-load.js";
import { drafterJudge, fridayReply, scriptedDrafter, targetOf, type Script } from "./fake-drafter.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const FRIDAY = path.join(REPO, "scenarios", "friday-escalation");
const EXTENDED = path.join(REPO, "scenarios", "friday-escalation-extended");
let dir: string;
let scn: string;
let scenario: Scenario;
let rubrics: Rubric[];
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acr-cal-"));
  scn = path.join(dir, "scn");
  await cp(FRIDAY, scn, { recursive: true, filter: starterOnly });
  ({ scenario, rubrics } = await loadEvaluationInput(scn));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const TIMEOUTS = { firstTokenTimeoutMs: 2_000, replyTimeoutMs: 2_000 };
const drafts = () => path.join(scn, "calibration", "drafts");
const listDrafts = () => readdir(drafts()).catch(() => [] as string[]);
/** Mode and content of a file from ONE open descriptor (no check-then-use on the path). */
async function readWithMode(file: string): Promise<{ mode: number; text: string }> {
  const fh = await open(file, "r");
  try { return { mode: (await fh.stat()).mode & 0o777, text: await fh.readFile("utf8") }; } finally { await fh.close(); }
}
async function dirMode(p: string): Promise<number> {
  const fh = await open(p, "r");
  try { return (await fh.stat()).mode & 0o777; } finally { await fh.close(); }
}
const input = (script: (req: Parameters<typeof targetOf>[0], i: number) => Script, extra: Partial<DraftInput> = {}) => {
  const p = scriptedDrafter(script);
  return { p, i: { dir: scn, scenario, rubrics, drafter: drafterJudge(p), primaryFamily: "gemma", allowSameFamily: false, subject: "delivery_lead", perLevel: 1, timeouts: TIMEOUTS, maxTokens: 3000, ...extra } as DraftInput };
};

describe("draftProbes", () => {
  it("writes one draft per level and per-level count under calibration/drafts, private, without split, never loaded by a run", async () => {
    const before = await loadProbes(scn, scenario, rubrics);
    const { p, i } = input(() => fridayReply(), { criterion: "discovery", perLevel: 2 });
    const r = await draftProbes(i);
    expect(r.problems).toEqual([]);
    expect(p.calls).toHaveLength(8);
    expect((await listDrafts()).sort()).toEqual([1, 2, 3, 4].flatMap((l) => [1, 2].map((n) => `draft-discovery-l${l}-${n}.yaml`)).sort());
    expect(r.written).toHaveLength(8);
    expect(await dirMode(drafts())).toBe(0o700);
    const { mode, text } = await readWithMode(path.join(drafts(), "draft-discovery-l3-2.yaml"));
    expect(mode).toBe(0o600);
    const d = parse(text) as Record<string, unknown>;
    expect(d).toMatchObject({ kind: "single", id: "draft-discovery-l3-2", criterion: "discovery", source: "drafted", drafter: "qwen3-30b-a3b", approved_by: null, approved_at: null, subject: "delivery_lead", expected: 3 });
    expect(d).not.toHaveProperty("split");
    expect((d.transcript as unknown[]).length).toBe(4);
    const after = await loadProbes(scn, scenario, rubrics);
    expect(after).toEqual(before);
  });
  it("covers every individual criterion when none is given (criteria x 4 levels x perLevel calls)", async () => {
    const { p, i } = input(() => fridayReply());
    const r = await draftProbes(i);
    const individual = rubrics.filter((x) => x.scope === "individual").flatMap((x) => x.criteria.map((c) => c.id));
    expect(p.calls).toHaveLength(individual.length * 4);
    expect(r.written).toHaveLength(individual.length * 4);
    expect(new Set(p.calls.map((c) => targetOf(c).criterion))).toEqual(new Set(individual));
  });
  it("continues numbering after existing drafts and probes, so an approved id never collides", async () => {
    await mkdir(drafts(), { recursive: true });
    await writeFile(path.join(drafts(), "draft-discovery-l1-1.yaml"), "x: 1\n");
    await writeFile(path.join(scn, "calibration", "discovery-l2-1.yaml"), "x: 1\n");
    const { i } = input(() => fridayReply(), { criterion: "discovery" });
    const r = await draftProbes(i);
    expect(r.written.map((f) => path.basename(f)).sort()).toEqual(["draft-discovery-l1-2.yaml", "draft-discovery-l2-2.yaml", "draft-discovery-l3-1.yaml", "draft-discovery-l4-1.yaml"]);
  });

  describe("the drafter family guard", () => {
    it("refuses a drafter of the primary judge's family, naming both families and not the model ids, and makes no call", async () => {
      const { p, i } = input(() => fridayReply(), { drafter: drafterJudge(scriptedDrafter(() => fridayReply()), "gemma-4-31b-secretish"), primaryFamily: "gemma" });
      await expect(draftProbes(i)).rejects.toThrow(CalibrationInputError);
      await expect(draftProbes(i)).rejects.toThrow(/drafter's model family \(gemma\) is the primary judge's family \(gemma\)/);
      await expect(draftProbes(i)).rejects.not.toThrow(/secretish/);
      expect(p.calls).toHaveLength(0);
      expect(await listDrafts()).toEqual([]);
    });
    it("allows the same family with allowSameFamily", async () => {
      const { i } = input(() => fridayReply(), { criterion: "discovery", drafter: drafterJudge(scriptedDrafter(() => fridayReply()), "gemma-4-31b"), allowSameFamily: true });
      expect((await draftProbes(i)).written).toHaveLength(4);
    });
    it("refuses when the primary family is unknown unless allowSameFamily", async () => {
      const { i } = input(() => fridayReply(), { criterion: "discovery", primaryFamily: null });
      await expect(draftProbes(i)).rejects.toThrow(/primary judge's model is not known/);
      expect((await draftProbes({ ...i, allowSameFamily: true })).written).toHaveLength(4);
    });
    it("refuses the mock provider as drafter", async () => {
      const { i } = input(() => fridayReply(), { criterion: "discovery" });
      const mock = { name: "mock", stream: i.drafter.provider.stream };
      await expect(draftProbes({ ...i, drafter: { ...i.drafter, provider: mock } })).rejects.toThrow(/mock/);
    });
  });

  describe("input checks", () => {
    it("refuses an unknown or group criterion, an unknown subject, an AI character as subject and per-level outside 1..3", async () => {
      const { p, i } = input(() => fridayReply());
      await expect(draftProbes({ ...i, criterion: "nope" })).rejects.toThrow(/criterion nope is not an individual criterion/);
      await expect(draftProbes({ ...i, criterion: "shared_understanding" })).rejects.toThrow(/not an individual criterion/);
      await expect(draftProbes({ ...i, subject: "nobody" })).rejects.toThrow(/subject nobody is not a player role/);
      await expect(draftProbes({ ...i, subject: "client_sponsor" })).rejects.toThrow(/subject client_sponsor is not a player role/);
      for (const perLevel of [0, 4, 1.5]) await expect(draftProbes({ ...i, perLevel })).rejects.toThrow(/per-level/);
      expect(p.calls).toHaveLength(0);
    });
    it("defaults the subject to the first player role by id", async () => {
      const { p, i } = input(() => fridayReply(), { criterion: "discovery", subject: undefined });
      await draftProbes(i);
      expect(p.calls[0]!.system).toContain("The subject is the player role account_manager");
    });
  });

  describe("the prompt", () => {
    it("names the scenario, the criterion, the target anchor verbatim, the scenes with participants and the roles' public persona", () => {
      const disc = rubrics.flatMap((r) => r.criteria).find((c) => c.id === "discovery")!;
      const req = buildDraftRequest(scenario, disc, 2, "delivery_lead", { maxTokens: 2500 });
      expect(req.maxTokens).toBe(2500);
      expect(req.system).toContain(scenario.meta.title);
      expect(req.system).toContain(scenario.meta.context.trim());
      expect(req.system).toContain(disc.description.trim());
      expect(req.system).toContain(disc.levels[2].anchor.trim());
      expect(req.system).not.toContain(disc.levels[3].anchor.trim());
      expect(req.system).toMatch(/s2_client_call.*delivery_lead, account_manager, client_sponsor/);
      expect(req.system).toContain("Priya Raman");
      expect(req.system).toMatch(/4 to 8 lines/);
      expect(req.system).toMatch(/exactly level 2 and no higher/);
      expect(req.system).toContain('{"transcript":[{"scene":');
      expect(targetOf(req)).toEqual({ criterion: "discovery", level: 2 });
    });
    it("never contains a hidden fact, private fact, earned_when condition, brief, knowledge or facilitator note (both Friday scenarios)", async () => {
      for (const s of [FRIDAY, EXTENDED]) {
        const { scenario: sc, rubrics: rb } = await loadEvaluationInput(s);
        const secrets: string[] = [sc.meta.facilitator_notes];
        for (const role of Object.values(sc.roles)) {
          if (role.type === "npc") secrets.push(...role.hidden, ...Object.values(role.earned_when ?? {}), ...role.knowledge, ...role.goals, ...role.guardrails);
          else secrets.push(...role.private_facts, role.brief);
        }
        const nonEmpty = secrets.map((x) => x.trim()).filter((x) => x.length > 0);
        expect(nonEmpty.length).toBeGreaterThan(5);
        const players = Object.values(sc.roles).filter((r) => r.type === "player").map((r) => r.id);
        for (const c of rb.filter((r) => r.scope === "individual").flatMap((r) => r.criteria)) {
          for (const level of [1, 2, 3, 4] as const) {
            for (const subject of players) {
              const req = buildDraftRequest(sc, c, level, subject, { maxTokens: 3000 });
              const whole = [req.system, ...req.messages.map((m) => m.content)].join("\n");
              for (const secret of nonEmpty) expect(whole.includes(secret), `${s} ${c.id} l${level}: ${secret.slice(0, 40)}`).toBe(false);
            }
          }
        }
      }
    });
  });

  describe("replies that are refused", () => {
    const line = (scene: string, role: string, text: string) => ({ scene, role, text });
    const reply = (lines: unknown[]) => JSON.stringify({ transcript: lines });
    const ok = [line("s2_client_call", "client_sponsor", "Hello."), line("s2_client_call", "delivery_lead", "Hi there."), line("s2_client_call", "delivery_lead", "Tell me more.")];
    const cases: [string, Script, RegExp][] = [
      ["garbage", "no json at all \u001b[31m", /draft draft-discovery-l1-1: the reply held no JSON object/],
      ["no transcript", JSON.stringify({ lines: [] }), /needs a transcript list/],
      ["more than 8 lines", reply(Array.from({ length: 9 }, (_, k) => line("s2_client_call", k % 2 ? "delivery_lead" : "client_sponsor", `Line ${k}.`))), /more than 8 lines/],
      ["an invented scene", reply([...ok, line("s9_moon", "delivery_lead", "Hi.")]), /unknown scene s9_moon/],
      ["an invented role", reply([...ok, line("s2_client_call", "ceo", "Hi.")]), /unknown role ceo/],
      ["a speaker outside the scene", reply([...ok, line("s2_client_call", "tech_lead", "Hi.")]), /tech_lead is not a participant of scene s2_client_call/],
      ["a subject with one line", reply([line("s2_client_call", "client_sponsor", "Hello."), line("s2_client_call", "delivery_lead", "Hi.")]), /delivery_lead needs at least 2 lines/],
      ["a hidden fact", reply([...ok, line("s2_client_call", "client_sponsor", "I would accept a phased delivery after go-live if the risk is explained well.")]), /contains a hidden fact of client_sponsor/],
      ["a prototype key", `{"transcript":[{"scene":"s2_client_call","role":"delivery_lead","text":"a","__proto__":{"x":1}},{"scene":"s2_client_call","role":"delivery_lead","text":"b"}]}`, /prototype key/],
      ["an extra field", reply([{ ...ok[1], mood: "x" }, ok[2]]), /transcript\.0 .*[Uu]nrecognized key/],
      ["an over-long line", reply([...ok, line("s2_client_call", "delivery_lead", "x".repeat(2001))]), /transcript\.3\.text/],
      ["a huge reply", "x".repeat(70_000), /longer than 65536 characters/],
      ["a provider failure", new Error("upstream \u001b[2J exploded"), /the drafter failed: model error: upstream ·\[2J exploded/],
      ["a hang", "hang", /the drafter failed: .*(timeout|deadline)/],
    ];
    it.each(cases)("refuses %s: nothing is written for it, the next draft still is, and the reason is printable", async (_name, bad, re) => {
      const { i } = input((_req, k) => (k === 0 ? bad : fridayReply()), { criterion: "discovery", timeouts: { firstTokenTimeoutMs: 100, replyTimeoutMs: 150 } });
      const r = await draftProbes(i);
      expect(r.problems).toHaveLength(1);
      expect(r.problems[0]).toMatch(re);
      expect(r.problems[0]).toMatch(/^draft draft-discovery-l1-1: /);
      // eslint-disable-next-line no-control-regex
      expect(r.problems[0]).not.toMatch(/[\u0000-\u001f]/);
      expect((await listDrafts()).sort()).toEqual(["draft-discovery-l2-1.yaml", "draft-discovery-l3-1.yaml", "draft-discovery-l4-1.yaml"]);
    });
    it("never prints the hidden fact or the line that held it", async () => {
      const fact = "I would accept a phased delivery after go-live if the risk is explained well.";
      const { i } = input(() => reply([...ok, line("s2_client_call", "client_sponsor", fact)]), { criterion: "discovery" });
      const r = await draftProbes(i);
      expect(r.problems).toHaveLength(4);
      for (const m of r.problems) expect(m.toLowerCase()).not.toContain("phased delivery");
    });
  });

  it("refuses a reply with bidi overrides or zero-width characters, writing nothing for it and never printing them", async () => {
    for (const bad of ["Approve \u202Eti esaelp\u202C now.", "zero\u200Bwidth", "isolate \u2066x\u2069", "bom \uFEFF here", "tag \u{E0041}\u{E0042} chars", "soft\u00adhyphen"]) {
      await rm(drafts(), { recursive: true, force: true });
      const { i } = input((_req, k) => (k === 0 ? fridayReply(bad) : fridayReply()), { criterion: "discovery" });
      const r = await draftProbes(i);
      expect(r.problems).toEqual(["draft draft-discovery-l1-1: the reply contains hidden or bidirectional control characters"]);
      expect(await listDrafts()).not.toContain("draft-discovery-l1-1.yaml");
    }
  });
  it("the loader refuses a probe line with a bidi override, naming the line, and prints it made safe", async () => {
    const disc = await readFile(path.join(scn, "calibration", "disc-l1.yaml"), "utf8");
    await writeFile(path.join(scn, "calibration", "trojan.yaml"), disc.replace("id: disc-l1", "id: trojan").replace("I will tell the team", "I will \u202Etell\u202C the team"));
    const r = await loadProbes(scn, scenario, rubrics);
    expect(r.errors).toEqual([expect.stringMatching(/^trojan\.yaml: transcript\.1\.text transcript line 2 contains hidden or bidirectional control characters$/)]);
    expect(r.errors.join("")).not.toMatch(/[\u202A-\u202E]/);
  });
  it("writes text exactly as given, YAML-escaped by the library (no raw interpolation)", async () => {
    const hostile = 'He said: "yes" \n- injected: true\n# not a comment {a: 1}';
    const { i } = input(() => fridayReply(hostile), { criterion: "discovery" });
    const r = await draftProbes(i);
    const d = parse(await readFile(r.written[0]!, "utf8")) as { transcript: { text: string }[]; injected?: unknown };
    expect(d.transcript[1]!.text).toBe(hostile);
    expect(d.injected).toBeUndefined();
  });
  it("stops on abort and keeps the drafts written so far", async () => {
    const ac = new AbortController();
    const { p, i } = input((_r, k) => { if (k === 1) ac.abort(); return fridayReply(); }, { criterion: "discovery", signal: ac.signal });
    const r = await draftProbes(i);
    expect(p.calls).toHaveLength(2);
    expect(r.written).toHaveLength(1);
    expect(r.problems.at(-1)).toMatch(/aborted: 3 drafts not written/);
  });
  it("refuses a drafts directory that is a symbolic link, and writes nothing through it", async () => {
    const elsewhere = path.join(dir, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, drafts());
    const { p, i } = input(() => fridayReply(), { criterion: "discovery" });
    await expect(draftProbes(i)).rejects.toThrow(/calibration\/drafts must be a directory, not a symbolic link/);
    expect(p.calls).toHaveLength(0);
    expect(await readdir(elsewhere)).toEqual([]);
  });
});

// ---- excerpt -------------------------------------------------------------------------------------------------------

/** A Friday session log: s1 (seq 2..5), s2 (seq 7..12); seq 1 started, 6 exit s1, 13 exit s2, 14 ended. */
function fridayLog(over: Partial<Record<number, string>> = {}): SessionEvent[] {
  const items: EventBody[] = [
    { type: "session.started", scenarioId: "esc-scope-creep-01", version: "1", roles: {} },
    { type: "scene.entered", sceneId: "s1_huddle", participants: ["delivery_lead", "tech_lead", "account_manager"] },
    { type: "utterance", roleId: "tech_lead", text: over[3] ?? "The module is a lot of work.", channel: "text" },
    { type: "utterance", roleId: "delivery_lead", text: over[4] ?? "How much work exactly?", channel: "text" },
    { type: "utterance", roleId: "delivery_lead", text: over[5] ?? "And what is the risk to go-live?", channel: "voice" },
    { type: "scene.exited", sceneId: "s1_huddle", reason: "facilitator_advance" },
    { type: "scene.entered", sceneId: "s2_client_call", participants: ["delivery_lead", "account_manager", "client_sponsor"] },
    { type: "utterance", roleId: "client_sponsor", text: over[8] ?? "We need the module before go-live.", channel: "text" },
    { type: "utterance", roleId: "delivery_lead", text: over[9] ?? "What does Finance need it for?", channel: "text" },
    { type: "utterance", roleId: "client_sponsor", text: over[10] ?? "The daily tie-out.", channel: "text" },
    { type: "utterance", roleId: "delivery_lead", text: over[11] ?? "So the need is the daily tie-out, not the whole module?", channel: "text" },
    { type: "utterance", roleId: "account_manager", text: over[12] ?? "Agreed.", channel: "text" },
    { type: "scene.exited", sceneId: "s2_client_call", reason: "facilitator_advance" },
    { type: "session.ended", reason: "script_complete" },
  ];
  return items.map((b, k) => ({ ...b, seq: k + 1, ts: 1_800_000_000_000 + k * 1000, sessionId: "s1" }) as SessionEvent);
}

describe("excerptDraft", () => {
  const ex = (o: Partial<Parameters<typeof excerptDraft>[0]> = {}) => excerptDraft({ log: fridayLog(), scenario, rubrics, from: 7, to: 12, subject: "delivery_lead", criterion: "discovery", id: "excerpt-disc-01", dir: scn, ...o });
  it("builds a draft from the utterances in the seq range, with each line's scene, and no level or approval", async () => {
    const r = await ex({ from: 2, to: 12 });
    expect(path.basename(r.file)).toBe("excerpt-disc-01.yaml");
    const { mode, text } = await readWithMode(r.file);
    expect(mode).toBe(0o600);
    const d = parse(text) as Record<string, unknown>;
    expect(d).toMatchObject({ kind: "single", id: "excerpt-disc-01", criterion: "discovery", source: "excerpt", drafter: null, approved_by: null, approved_at: null, subject: "delivery_lead" });
    expect(d).not.toHaveProperty("expected");
    expect(d).not.toHaveProperty("split");
    expect(d.transcript).toEqual([
      { scene: "s1_huddle", role: "tech_lead", text: "The module is a lot of work." },
      { scene: "s1_huddle", role: "delivery_lead", text: "How much work exactly?" },
      { scene: "s1_huddle", role: "delivery_lead", text: "And what is the risk to go-live?" },
      { scene: "s2_client_call", role: "client_sponsor", text: "We need the module before go-live." },
      { scene: "s2_client_call", role: "delivery_lead", text: "What does Finance need it for?" },
      { scene: "s2_client_call", role: "client_sponsor", text: "The daily tie-out." },
      { scene: "s2_client_call", role: "delivery_lead", text: "So the need is the daily tie-out, not the whole module?" },
      { scene: "s2_client_call", role: "account_manager", text: "Agreed." },
    ]);
  });
  it.each([
    ["a subject with fewer than 2 lines", { from: 7, to: 9 }, /delivery_lead has 1 line in seq 7 to 9 \(at least 2 are needed\)/],
    ["from after to", { from: 9, to: 7 }, /--from must not be after --to/],
    ["a seq outside the log", { from: 7, to: 99 }, /seq 7 to 99 is not inside the log \(seq 1 to 14\)/],
    ["a non-integer seq", { from: 0, to: 3 }, /seq numbers are whole numbers from 1/],
    ["an unsafe id", { id: "../x" }, /--id must be 1 to 58 characters/],
    ["a long id", { id: "a".repeat(59) }, /--id must be 1 to 58 characters/],
    ["an unknown criterion", { criterion: "nope" }, /criterion nope is not an individual criterion/],
    ["an AI character as subject", { subject: "client_sponsor" }, /subject client_sponsor is not a player role/],
    ["a log of another scenario", { log: fridayLog().map((e) => (e.type === "session.started" ? { ...e, scenarioId: "other" } : e)) }, /the log is of scenario other, not esc-scope-creep-01/],
  ] as const)("refuses %s and writes nothing", async (_n, o, re) => {
    await expect(ex(o as never)).rejects.toThrow(CalibrationInputError);
    await expect(ex(o as never)).rejects.toThrow(re);
    expect(await listDrafts()).toEqual([]);
  });
  it("refuses a line spoken outside any scene (between scene.exited and the next scene.entered)", async () => {
    const log = fridayLog();
    log.splice(6, 0, { type: "utterance", roleId: "delivery_lead", text: "between scenes", channel: "text" } as SessionEvent);
    log.forEach((e, k) => { e.seq = k + 1; e.ts = k; e.sessionId = "s1"; });
    await expect(ex({ log, from: 2, to: 13 })).rejects.toThrow(/the line at seq 7 was spoken outside any scene/);
  });
  it("handles a log of 150 000 events (no argument-spread limit on the seq range)", async () => {
    const head = fridayLog().slice(0, 12);
    const filler = Array.from({ length: 150_000 }, () => ({ type: "facilitator.alert", level: "info", message: "tick" }));
    const log = [...head, ...filler].map((e, k) => ({ ...e, seq: k + 1, ts: k, sessionId: "s1" }) as SessionEvent);
    const r = await ex({ log, from: 7, to: 12 });
    expect(path.basename(r.file)).toBe("excerpt-disc-01.yaml");
    await expect(ex({ log, from: 7, to: 150_013, id: "excerpt-disc-02" })).rejects.toThrow(/seq 7 to 150013 is not inside the log \(seq 1 to 150012\)/);
  });
  it("refuses more than 80 lines", async () => {
    const base = fridayLog().slice(0, 7);
    const lines = Array.from({ length: 81 }, (_, k) => ({ type: "utterance", roleId: k % 2 ? "delivery_lead" : "client_sponsor", text: `line ${k}`, channel: "text" }));
    const log = [...base, ...lines].map((e, k) => ({ ...e, seq: k + 1, ts: k, sessionId: "s1" }) as SessionEvent);
    await expect(ex({ log, from: 8, to: 88 })).rejects.toThrow(/81 lines in seq 8 to 88: at most 80/);
  });
  it("refuses an excerpt with a hidden fact, naming the role only", async () => {
    const fact = "Would accept a phased delivery after go-live if the risk is explained well";
    const err = await ex({ log: fridayLog({ 10: `Honestly? ${fact}.` }) }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(CalibrationInputError);
    expect((err as Error).message).toBe("excerpt contains a hidden fact of client_sponsor: choose another range");
    expect(await listDrafts()).toEqual([]);
  });
  it("refuses an excerpt line with hidden or bidirectional control characters, never printing them, and writes nothing", async () => {
    const err = (await ex({ log: fridayLog({ 9: "What does \u202EFinance\u202C need it for?" }) }).catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(CalibrationInputError);
    expect(err.message).toMatch(/the line at seq 9 contains hidden or bidirectional control characters/);
    expect(err.message).not.toMatch(/[\u202A-\u202E]/);
    expect(await listDrafts()).toEqual([]);
  });
  it("catches a hidden fact smuggled with tag characters in an excerpt, without printing it", async () => {
    const fact = "Would accept a phased delivery after go-live if the risk is explained well";
    const smuggled = [...fact].map((c) => `${c}\u{E0020}`).join("");
    const err = (await ex({ log: fridayLog({ 10: `Honestly? ${smuggled}.` }) }).catch((e: Error) => e)) as Error;
    expect(err.message).toBe("excerpt contains a hidden fact of client_sponsor: choose another range");
    expect(await listDrafts()).toEqual([]);
  });
  it("refuses an existing draft id (exclusive create) and leaves it unchanged", async () => {
    await ex();
    const before = await readFile(path.join(drafts(), "excerpt-disc-01.yaml"), "utf8");
    await expect(ex({ from: 2, to: 12 })).rejects.toThrow(/draft excerpt-disc-01 already exists/);
    expect(await readFile(path.join(drafts(), "excerpt-disc-01.yaml"), "utf8")).toBe(before);
  });
  it("keeps hostile text from the log out of its messages", async () => {
    const log = fridayLog();
    (log[2] as { roleId: string }).roleId = "evil\u001b[2Jrole";
    const err = (await ex({ log, from: 2, to: 5 }).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/unknown role evil·\[2Jrole/);
  });
});

// ---- approve -------------------------------------------------------------------------------------------------------

describe("approveDraft", () => {
  const NOW = () => new Date("2026-10-07T12:34:56.000Z");
  async function drafted(): Promise<void> {
    const { i } = input(() => fridayReply(), { criterion: "discovery" });
    await draftProbes(i);
  }
  const existing = async () => (await loadProbes(scn, scenario, rubrics)).probes;
  const approve = async (o: Partial<Parameters<typeof approveDraft>[0]> = {}) => approveDraft({ dir: scn, draftId: "draft-discovery-l2-1", by: "Kamal", scenario, rubrics, existing: await existing(), now: NOW, ...o });

  it("approves a drafted probe: approver, ISO time, split, final id without the prefix; the draft is removed and the loader loads it", async () => {
    await drafted();
    const n = (await existing()).length;
    const r = await approve();
    expect(r.file).toBe(path.join(scn, "calibration", "discovery-l2-1.yaml"));
    expect(r.draftRemoved).toBe(true);
    const { mode, text } = await readWithMode(r.file);
    expect(mode).toBe(0o600);
    expect(parse(text)).toMatchObject({ id: "discovery-l2-1", source: "drafted", drafter: "qwen3-30b-a3b", approved_by: "Kamal", approved_at: "2026-10-07T12:34:56.000Z", expected: 2, split: assignSplit("discovery-l2-1", n + 1) });
    expect(await listDrafts()).not.toContain("draft-discovery-l2-1.yaml");
    const after = await loadProbes(scn, scenario, rubrics);
    expect(after.errors).toEqual([]);
    expect(after.probes.map((p) => p.id)).toContain("discovery-l2-1");
  });
  it("lets --expected override a drafted level and --id choose the final id", async () => {
    await drafted();
    const r = await approve({ expected: 1, finalId: "disc-drafted-07" });
    expect(parse(await readFile(r.file, "utf8"))).toMatchObject({ id: "disc-drafted-07", expected: 1 });
  });
  it("requires the human rating for an excerpt and keeps an existing split", async () => {
    const x = await excerptDraft({ log: fridayLog(), scenario, rubrics, from: 7, to: 12, subject: "delivery_lead", criterion: "discovery", id: "excerpt-disc-01", dir: scn });
    await expect(approve({ draftId: "excerpt-disc-01" })).rejects.toThrow(/an excerpt needs --expected/);
    await writeFile(x.file, `${await readFile(x.file, "utf8")}split: holdout\n`);
    const r = await approve({ draftId: "excerpt-disc-01", expected: "not_observed" });
    expect(parse(await readFile(r.file, "utf8"))).toMatchObject({ id: "excerpt-disc-01", source: "excerpt", drafter: null, expected: "not_observed", split: "holdout", approved_by: "Kamal" });
  });
  it.each([["../x"], ["/etc/passwd"], ["a".repeat(59)], [""], ["Draft-X"]])("refuses the unsafe draft id %j", async (draftId) => {
    await expect(approve({ draftId })).rejects.toThrow(/--draft must be 1 to 58 characters/);
  });
  it("refuses an unknown draft, a bad approver name and a bad final id", async () => {
    await expect(approve({ draftId: "draft-nope" })).rejects.toThrow(/there is no draft draft-nope/);
    await drafted();
    for (const by of ["", "   ", "x".repeat(121), "evil\u001b[2J", "a\nb"]) await expect(approve({ by })).rejects.toThrow(/--by must be 1 to 120 printable characters/);
    await expect(approve({ finalId: "../up" })).rejects.toThrow(/--id must be 1 to 58 characters/);
    expect(await listDrafts()).toContain("draft-discovery-l2-1.yaml");
  });
  it("never overwrites an existing probe, and keeps the draft", async () => {
    await drafted();
    await writeFile(path.join(scn, "calibration", "discovery-l2-1.yaml"), "kept: true\n");
    await expect(approve({ existing: [] })).rejects.toThrow(/a probe discovery-l2-1 already exists/);
    expect(await readFile(path.join(scn, "calibration", "discovery-l2-1.yaml"), "utf8")).toBe("kept: true\n");
    expect(await listDrafts()).toContain("draft-discovery-l2-1.yaml");
  });
  it("refuses a draft edited into an invalid probe with the full problem list, and writes nothing", async () => {
    await drafted();
    const f = path.join(drafts(), "draft-discovery-l2-1.yaml");
    const d = parse(await readFile(f, "utf8")) as { transcript: { scene: string; role: string }[] };
    d.transcript[0]!.scene = "s9_moon";
    d.transcript[1]!.role = "tech_lead";
    await writeFile(f, JSON.stringify(d));
    const err = (await approve().catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(CalibrationInputError);
    expect(err.message).toMatch(/unknown scene s9_moon/);
    expect(err.message).toMatch(/tech_lead is not a participant of scene s2_client_call/);
    expect(await readdir(path.join(scn, "calibration"))).not.toContain("discovery-l2-1.yaml");
  });
  it("refuses a schema-invalid draft, a prototype key, a non-draft source and a draft whose id does not match its file", async () => {
    await mkdir(drafts(), { recursive: true });
    const put = (id: string, text: string) => writeFile(path.join(drafts(), `${id}.yaml`), text);
    await put("d-bad", "kind: single\nid: d-bad\nsource: drafted\n");
    await expect(approve({ draftId: "d-bad", expected: 2 })).rejects.toThrow(/d-bad: not a valid probe:[\s\S]*criterion/);
    await put("d-proto", "kind: single\nid: d-proto\n__proto__: { x: 1 }\n");
    await expect(approve({ draftId: "d-proto" })).rejects.toThrow(/prototype key/);
    await drafted();
    const text = await readFile(path.join(drafts(), "draft-discovery-l2-1.yaml"), "utf8");
    await put("d-hand", text.replace("source: drafted", "source: handwritten").replace("id: draft-discovery-l2-1", "id: d-hand"));
    await expect(approve({ draftId: "d-hand" })).rejects.toThrow(/source must be drafted or excerpt/);
    await put("d-other", text);
    await expect(approve({ draftId: "d-other" })).rejects.toThrow(/the draft's id draft-discovery-l2-1 does not match its file name d-other/);
  });
  it("refuses a hand-edited draft with a bidi override or a zero-width character (the schema re-validates)", async () => {
    await drafted();
    const f = path.join(drafts(), "draft-discovery-l2-1.yaml");
    const d = parse(await readFile(f, "utf8")) as { transcript: { text: string }[] };
    d.transcript[1]!.text = "We can \u202Eod ti\u202C\u200B today.";
    await writeFile(f, JSON.stringify(d));
    const err = (await approve().catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(CalibrationInputError);
    expect(err.message).toMatch(/transcript\.1\.text transcript line 2 contains hidden or bidirectional control characters/);
    expect(err.message).not.toMatch(/[\u200B\u202A-\u202E]/);
    expect(await readdir(path.join(scn, "calibration"))).not.toContain("discovery-l2-1.yaml");
  });
  it("refuses a draft over the size cap (one capped read, EFBIG) and --expected on a contrast draft", async () => {
    await mkdir(drafts(), { recursive: true });
    await writeFile(path.join(drafts(), "d-big.yaml"), `kind: single\nid: d-big\n# ${"x".repeat(130 * 1024)}\n`);
    await expect(approve({ draftId: "d-big" })).rejects.toThrow(/draft d-big cannot be read \(EFBIG\)/);
    const contrast = await readFile(path.join(scn, "calibration", "listening-contrast-01.yaml"), "utf8");
    // the starter probe is already drafted and approved (R26): turn it back into an unapproved excerpt draft
    const conDraft = contrast.replace("id: listening-contrast-01", "id: d-con").replace(/^source: drafted\ndrafter: .*\napproved_by: .*\napproved_at: .*\n/m, "source: excerpt\n").replace(/^split: .*\n/m, "");
    expect(conDraft).toMatch(/^source: excerpt$/m);
    expect(conDraft).not.toMatch(/drafter|approved_by|approved_at/);
    await writeFile(path.join(drafts(), "d-con.yaml"), conDraft);
    await expect(approve({ draftId: "d-con", expected: 2 })).rejects.toThrow(/--expected does not apply to a contrast probe/);
    const ok = await approve({ draftId: "d-con", by: "Owner B" });
    expect(parse(await readFile(ok.file, "utf8"))).toMatchObject({ id: "d-con", kind: "contrast", source: "excerpt", drafter: null, approved_by: "Owner B" });
  });
  it("does not follow a draft that is a symbolic link", async () => {
    await drafted();
    const real = path.join(dir, "real.yaml");
    await cp(path.join(drafts(), "draft-discovery-l2-1.yaml"), real);
    await symlink(real, path.join(drafts(), "draft-link.yaml"));
    await expect(approve({ draftId: "draft-link" })).rejects.toThrow(/draft draft-link cannot be read \(ELOOP\)|symbolic link/);
  });
});

// ---- assign-splits -------------------------------------------------------------------------------------------------

describe("assignSplits", () => {
  it("fills only a missing split, keeps comments, leaves files with a split byte-identical, and reports each change", async () => {
    const cal = path.join(scn, "calibration");
    const names = (await readdir(cal)).filter((n) => n.endsWith(".yaml") && n !== "targets.yaml");
    const before = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await readFile(path.join(cal, n), "utf8")] as const)));
    const disc = before["disc-l1.yaml"]!;
    await writeFile(path.join(cal, "nosplit-a.yaml"), `# keep me\n${disc.replace("id: disc-l1", "id: nosplit-a").replace("split: tune\n", "")}`);
    await writeFile(path.join(cal, "broken.yaml"), "kind: [unclosed\n");
    await mkdir(path.join(cal, "drafts"));
    await writeFile(path.join(cal, "drafts", "draft-x.yaml"), "id: draft-x\n");
    const r = await assignSplits(scn);
    expect(r.changed).toEqual([path.join(cal, "nosplit-a.yaml")]);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/^broken\.yaml: /);
    for (const [n, text] of Object.entries(before)) expect(await readFile(path.join(cal, n), "utf8")).toBe(text);
    expect(await readFile(path.join(cal, "broken.yaml"), "utf8")).toBe("kind: [unclosed\n");
    expect(await readFile(path.join(cal, "drafts", "draft-x.yaml"), "utf8")).toBe("id: draft-x\n");
    const { mode, text } = await readWithMode(path.join(cal, "nosplit-a.yaml"));
    expect(mode).toBe(0o600);
    expect(text.startsWith("# keep me\n")).toBe(true);
    const total = names.length + 1; // the probe files and the new one; the broken file does not parse, so it does not count
    expect((parse(text) as { split: string }).split).toBe(assignSplit("nosplit-a", total));
    expect(text.indexOf("split:")).toBeLessThan(text.indexOf("transcript:"));
    expect((await readdir(cal)).filter((n) => n.includes(".tmp"))).toEqual([]);
    expect((await loadProbes(scn, scenario, rubrics)).probes.map((p) => p.id)).toContain("nosplit-a");
    const again = await assignSplits(scn);
    expect(again.changed).toEqual([]);
  });
  it("fills a null split, and reports (without touching) a split that is neither tune nor holdout", async () => {
    const cal = path.join(scn, "calibration");
    const disc = await readFile(path.join(cal, "disc-l1.yaml"), "utf8");
    await writeFile(path.join(cal, "nullsplit.yaml"), disc.replace("id: disc-l1", "id: nullsplit").replace("split: tune", "split: null"));
    // a string is shown quoted (so an empty one is visible), anything else as its value
    const values: [string, string][] = [["maybe", '"maybe"'], ['""', '""'], ["TUNE", '"TUNE"'], ["3", "3"], ["true", "true"], ["[tune]", '["tune"]'], ["{a: 1}", '{"a":1}']];
    const odd: Record<string, string> = {};
    for (const [k, [v]] of values.entries()) {
      odd[`odd-${k}.yaml`] = disc.replace("id: disc-l1", `id: odd-${k}`).replace("split: tune", `split: ${v}`);
      await writeFile(path.join(cal, `odd-${k}.yaml`), odd[`odd-${k}.yaml`]!);
    }
    const r = await assignSplits(scn);
    expect(r.changed).toEqual([path.join(cal, "nullsplit.yaml")]);
    expect(r.problems).toEqual(values.map(([, shown], k) => `odd-${k}.yaml: split ${shown} is neither tune nor holdout: not changed`));
    for (const [name, text] of Object.entries(odd)) expect(await readFile(path.join(cal, name), "utf8")).toBe(text);
    const filled = await readFile(path.join(cal, "nullsplit.yaml"), "utf8");
    expect((parse(filled) as { split: string }).split).toBe(assignSplit("nullsplit", await probeFileTotal(scn)));
    expect(filled).not.toContain("split: null");
  });
  it("removes its temp file and reports the file when the rename fails (a directory took the file's place)", async () => {
    const cal = path.join(scn, "calibration");
    const disc = await readFile(path.join(cal, "disc-l1.yaml"), "utf8");
    await writeFile(path.join(cal, "racy.yaml"), disc.replace("id: disc-l1", "id: racy").replace("split: tune\n", ""));
    const r = await assignSplits(scn, { beforeRename: async (file) => { await rm(file); await mkdir(path.join(file, "inside"), { recursive: true }); } });
    expect(r.changed).toEqual([]);
    expect(r.problems).toEqual([expect.stringMatching(/^racy\.yaml: cannot be rewritten \((EISDIR|ENOTEMPTY|EEXIST|EPERM)\)$/)]);
    expect((await readdir(cal)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
  it("does not touch a symbolic link or a file without a usable id", async () => {
    const cal = path.join(scn, "calibration");
    const outside = path.join(dir, "outside.yaml");
    await writeFile(outside, "kind: single\nid: outside\n");
    await symlink(outside, path.join(cal, "outside.yaml"));
    await writeFile(path.join(cal, "noid.yaml"), "kind: single\n");
    const r = await assignSplits(scn);
    expect(r.changed).toEqual([]);
    expect(r.problems).toEqual(expect.arrayContaining([expect.stringMatching(/^outside\.yaml: symbolic links are not followed/), expect.stringMatching(/^noid\.yaml: no usable id/)]));
    expect(await readFile(outside, "utf8")).toBe("kind: single\nid: outside\n");
  });
});

// ---- one split-total rule for approve and assign-splits ------------------------------------------------------------

describe("the split total shared by approve and assign-splits", () => {
  /** The scenario with `valid` parseable probe files in calibration/ (the 8 starter probes plus copies) and one broken file. */
  async function withProbes(valid: number): Promise<string> {
    const cal = path.join(scn, "calibration");
    const disc = await readFile(path.join(cal, "disc-l1.yaml"), "utf8");
    for (let k = 1; k <= valid - 8; k++) await writeFile(path.join(cal, `copy-${k}.yaml`), disc.replace("id: disc-l1", `id: copy-${k}`));
    await writeFile(path.join(cal, "broken.yaml"), "kind: [unclosed\n");
    return cal;
  }
  // 38 valid files: the probe approved or added makes 39 (50/50); 39 valid files: it makes 40 (70/30). A broken file never counts.
  it.each([[38, 39], [39, 40]])("with %i valid probe files, both give the split of a set of %i for the same id", async (valid, total) => {
    const id = Array.from({ length: 400 }, (_, k) => `disc-split-${k}`).find((x) => assignSplit(x, 39) !== assignSplit(x, 40))!;
    const cal = await withProbes(valid);
    expect(await probeFileTotal(scn)).toBe(valid);
    // approve: the new probe is not on disk yet, so it is counted on top
    const { i } = input(() => fridayReply(), { criterion: "discovery" });
    await draftProbes(i);
    const approved = await approveDraft({ dir: scn, draftId: "draft-discovery-l2-1", by: "Kamal", finalId: id, scenario, rubrics, existing: [], now: () => new Date(0) });
    const viaApprove = (parse(await readFile(approved.file, "utf8")) as { split: string }).split;
    // assign-splits: the same probe without a split, already on disk, is counted as one of the files
    const text = (await readFile(approved.file, "utf8")).replace(/^split: .*\n/m, "");
    await rm(approved.file);
    await writeFile(path.join(cal, `${id}.yaml`), text);
    const r = await assignSplits(scn);
    expect(r.changed).toEqual([path.join(cal, `${id}.yaml`)]);
    const viaAssign = (parse(await readFile(path.join(cal, `${id}.yaml`), "utf8")) as { split: string }).split;
    expect(viaApprove).toBe(assignSplit(id, total));
    expect(viaAssign).toBe(viaApprove);
  });
});

// ---- R29: approve checks its directories; a failed write leaves no truncated file -------------------------------------

describe("R29 hardening", () => {
  const NOW = () => new Date("2026-10-07T12:34:56.000Z");
  const drafted = async () => { const { i } = input(() => fridayReply(), { criterion: "discovery" }); await draftProbes(i); };
  const approve = (o: Partial<Parameters<typeof approveDraft>[0]> = {}) => approveDraft({ dir: scn, draftId: "draft-discovery-l2-1", by: "Kamal", scenario, rubrics, existing: [], now: NOW, ...o });
  const cal = () => path.join(scn, "calibration");

  it("approve refuses a calibration/drafts that is a symbolic link, and neither reads nor deletes the draft behind it", async () => {
    await drafted();
    const elsewhere = path.join(dir, "elsewhere");
    await rename(drafts(), elsewhere);
    await symlink(elsewhere, drafts());
    await expect(approve()).rejects.toThrow(/calibration\/drafts must be a directory, not a symbolic link or a file/);
    expect(await readdir(elsewhere)).toContain("draft-discovery-l2-1.yaml");
    expect(await readdir(cal())).not.toContain("discovery-l2-1.yaml");
  });
  it("approve refuses a calibration/ that is a symbolic link, and writes nothing through it", async () => {
    await drafted();
    const elsewhere = path.join(dir, "elsewhere-cal");
    await rename(cal(), elsewhere);
    await symlink(elsewhere, cal());
    await expect(approve()).rejects.toThrow(/^calibration must be a directory, not a symbolic link or a file/);
    expect(await readdir(elsewhere)).not.toContain("discovery-l2-1.yaml");
    expect(await readdir(path.join(elsewhere, "drafts"))).toContain("draft-discovery-l2-1.yaml");
  });
  it("approve refuses a calibration/drafts that is a file", async () => {
    await mkdir(cal(), { recursive: true });
    await writeFile(drafts(), "not a directory\n");
    await expect(approve()).rejects.toThrow(/calibration\/drafts must be a directory/);
  });

  describe("a write that fails midway (ENOSPC) removes the truncated file", () => {
    type Proto = { write: (...a: unknown[]) => Promise<{ bytesWritten: number }> };
    let proto: Proto; let origWrite: Proto["write"];
    beforeEach(async () => {
      const fh = await open(path.join(dir, "probe-handle"), "w");
      proto = Object.getPrototypeOf(fh) as Proto; origWrite = proto.write;
      await fh.close();
    });
    afterEach(() => { proto.write = origWrite; });
    /** Every write writes its first 10 bytes, then fails with ENOSPC. */
    const failMidway = () => {
      proto.write = async function (this: unknown, buf: unknown, off: unknown, len: unknown) {
        await origWrite.call(this, buf, off, Math.min(Number(len ?? 10), 10));
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      };
    };
    it("draft: reports the error and leaves no draft file", async () => {
      const { i } = input(() => fridayReply(), { criterion: "discovery" });
      await mkdir(drafts(), { recursive: true });
      failMidway();
      const r = await draftProbes(i);
      proto.write = origWrite;
      expect(r.written).toEqual([]);
      expect(r.problems).toHaveLength(4);
      for (const p of r.problems) expect(p).toMatch(/cannot be written \(ENOSPC\)/);
      expect(await listDrafts()).toEqual([]);
    });
    it("excerpt: rethrows and leaves no draft file", async () => {
      await mkdir(drafts(), { recursive: true });
      failMidway();
      const err = await excerptDraft({ log: fridayLog(), scenario, rubrics, from: 7, to: 12, subject: "delivery_lead", criterion: "discovery", id: "excerpt-disc-01", dir: scn }).catch((e: unknown) => e);
      proto.write = origWrite;
      expect((err as NodeJS.ErrnoException).code).toBe("ENOSPC");
      expect(await listDrafts()).toEqual([]);
    });
    it("approve: refuses, leaves no probe file and keeps the draft", async () => {
      await drafted();
      failMidway();
      const err = await approve().catch((e: unknown) => e);
      proto.write = origWrite;
      expect(err).toBeInstanceOf(CalibrationInputError);
      expect((err as Error).message).toBe("calibration/discovery-l2-1.yaml cannot be written (ENOSPC)");
      expect(await readdir(cal())).not.toContain("discovery-l2-1.yaml");
      expect(await listDrafts()).toContain("draft-discovery-l2-1.yaml");
    });
  });
});

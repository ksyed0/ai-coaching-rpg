/**
 * GOLDEN (US-0061, characterisation): records the CURRENT output of the evaluator and the review tool for sessions WITHOUT AI roles, as
 * sha256 hashes, so that later slice 2b-3c changes can prove byte identity. This file is recorded once on unchanged code and must never be
 * re-recorded by a later task: a red golden test is a regression to fix, not a fixture to refresh.
 *
 * Re-record (only for a deliberate, reviewed change to no-AI output): GOLDEN_RECORD=1 pnpm --filter @acr/runtime exec vitest run src/evaluator/__tests__/golden.test.ts
 *
 * Determinism: fixed nonce for in-process runs (the CLI has no nonce hook, so its random nonce is normalised to the same text), fixed
 * event timestamps (T0), the review tool's fixed clock, temp and repo paths replaced by <dir> and <repo> before hashing, sorted file
 * lists. Every date in the output derives from the event timestamps via toISOString (UTC), so the test needs no TZ (verified under
 * TZ=Asia/Kolkata and LANG=de_DE.UTF-8).
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import type { ChatRequest } from "@acr/adapters";
import type { SessionEvent } from "@acr/events";
import type { Rubric, Scenario } from "@acr/script";
import { createScriptedEvaluator } from "../../demo/eval-mock.js";
import { loadReview } from "../../review/store.js";
import { renderReviewIndex } from "../../review/index-view.js";
import { makeRunner } from "../../review/__tests__/fixtures.js";
import { runEvaluate, loadEvaluationInput } from "../cli.js";
import { parseEvalConfig, type EvalConfig } from "../config.js";
import { evaluateSession, type EvaluationResult } from "../evaluate.js";
import type { EvaluatorInfo } from "../report-model.js";
import { renderReports, writeReports } from "../report-write.js";
import { summaryLines } from "../summary.js";
import { verifyReportFiles } from "../verify.js";
import { build, sampleRubrics, sampleScenario } from "./fixtures.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "golden-no-ai.json");
const NONCE = "golden0nce";

type Entry = { label: string; sha256: string };
type Golden = Record<string, Entry>;
const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

type Provider = { name: string; calls: ChatRequest[]; stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<string> };
/** Wraps a provider so that every request it receives is kept (before the reply, so a failing call is recorded too). */
function recording(name: string, inner: (req: ChatRequest, signal?: AbortSignal) => AsyncIterable<string>): Provider {
  const calls: ChatRequest[] = [];
  return { name, calls, async *stream(req, signal) { calls.push(req); yield* inner(req, signal); } };
}
const roleOf = (req: ChatRequest): string => /role id "(\w+)"/.exec(req.system)?.[1] ?? "group";
const crit = (id: string, score: number, seq: number, quote: string) => ({ id, score, rationale: `Because ${id}.`, confidence: "high", evidence: [{ seq, quote }] });

// ---- run (a): friday-escalation, all three players, scripted evaluator ------------------------------------------------------------
const FRIDAY = path.join(REPO, "scenarios", "friday-escalation");
const SC1 = "s1_huddle"; const SC2 = "s2_client_call"; const SC3 = "s3_internal_wrap";
const FRIDAY_EVENTS = (silent: string[] = []): SessionEvent[] => {
  const say = (at: number, roleId: string, text: string): [number, never] | null => (silent.includes(roleId) ? null : [at, { type: "utterance", roleId, text, channel: "text" } as never]);
  const lines = [
    say(10, "delivery_lead", "Okay, Priya's email is in. First reactions on the request from the client?"),
    say(20, "tech_lead", "My worry is the ingestion layer. Anything we add now competes with go-live."),
    say(30, "account_manager", "I would rather not say no outright. The renewal is in play, so a refusal lands badly."),
    say(40, "delivery_lead", "So what if we offer a phased module after go-live, scoped and priced?"),
    say(50, "tech_lead", "I can live with that. The phased version is roughly half the work."),
    say(60, "account_manager", "Agreed. Position: phase two after go-live, priced as a change request."),
  ];
  const call = [
    say(310, "delivery_lead", "Thanks for taking the call, Priya. We understand the reconciliation module matters to Finance."),
    say(320, "account_manager", "We would like to offer it as a phased module, delivered three weeks after go-live."),
    say(330, "client_sponsor", "Three weeks is too long for me. My CFO wants the tie-out working on day one."),
    say(340, "delivery_lead", "A reduced first cut on day one is possible if we agree what the tie-out must cover."),
    say(350, "client_sponsor", "That works if the daily loads are covered. Send me the scope in writing today."),
    say(360, "account_manager", "I will send the scope and the change request price before the end of the day."),
  ];
  const wrap = [
    say(610, "delivery_lead", "Recap: first cut on day one, full module three weeks later. I own the scope note."),
    say(620, "tech_lead", "I will size the first cut tonight and flag anything that touches the ingestion layer."),
  ];
  const keep = (xs: ([number, never] | null)[]): [number, never][] => xs.filter((x): x is [number, never] => x !== null);
  return build([
    [0, { type: "session.started", scenarioId: "esc-scope-creep-01", version: "1.2", roles: {} }],
    [1, { type: "scene.entered", sceneId: SC1, participants: ["delivery_lead", "tech_lead", "account_manager"] }],
    [2, { type: "inject.fired", injectId: "email_from_priya", sceneId: SC1, to: ["delivery_lead", "tech_lead", "account_manager"], content: "Email from Priya Raman: a small reconciliation module is a must-have before go-live." }],
    ...keep(lines),
    [200, { type: "gm.decision", sceneId: SC1, condition: "the team has stated a single agreed position on the request", verdict: true, reasoning: "they agreed a phased module" }],
    [300, { type: "scene.exited", sceneId: SC1, reason: "gm_detects" }],
    [301, { type: "scene.entered", sceneId: SC2, participants: ["delivery_lead", "account_manager", "client_sponsor"] }],
    ...keep(call),
    [400, { type: "scene.exited", sceneId: SC2, reason: "gm_detects" }],
    [401, { type: "scene.entered", sceneId: SC3, participants: ["delivery_lead", "tech_lead", "account_manager"] }],
    ...keep(wrap),
    [700, { type: "scene.exited", sceneId: SC3, reason: "time_box_elapsed" }],
    [701, { type: "session.ended", reason: "script_complete" }],
  ] as never, "gold-a");
};

// ---- run (b): sampleScenario, long log, trimmed transcript ------------------------------------------------------------------------
const QUOTE = "what Finance needs, what it costs, who owns it and when it lands";
function longEvents(): SessionEvent[] {
  const topics = ["ingestion layer", "go-live date", "daily tie-out", "phased module", "price", "timeline", "scope", "owner", "risk"];
  const items: [number, never][] = [];
  let at = 10;
  for (const [i, t] of topics.entries()) {
    for (const who of ["alice", "bob"]) {
      const text = `Point ${i + 1} from ${who}: on the ${t} I want us to be explicit about ${QUOTE}, so nobody is surprised later.`;
      items.push([at, { type: "utterance", roleId: who, text, channel: "text" } as never]); at += 10;
    }
  }
  return build([
    [0, { type: "session.started", scenarioId: "mini-01", version: "1.0", roles: { alice: { kind: "player" }, bob: { kind: "player" }, npc1: { kind: "npc" } } }],
    [1, { type: "scene.entered", sceneId: "s1", participants: ["alice", "bob"] }],
    ...items.slice(0, 12),
    [150, { type: "scene.exited", sceneId: "s1", reason: "time_box_elapsed" }],
    [151, { type: "scene.entered", sceneId: "s2", participants: ["alice", "bob", "npc1"] }],
    [152, { type: "inject.fired", injectId: "i1", sceneId: "s2", to: ["alice"], content: "Priya emails." }],
    [160, { type: "utterance", roleId: "npc1", text: "Thanks for calling. Can you confirm the module for go-live, and what it would cost us in the first quarter?", channel: "text" } as never],
    ...items.slice(12).map(([a, b]) => [a + 160, b] as [number, never]),
    [300, { type: "gm.decision", sceneId: "s2", condition: "a plan is agreed", verdict: true, reasoning: "they agreed" }],
    [310, { type: "scene.exited", sceneId: "s2", reason: "gm_detects" }],
    [311, { type: "session.ended", reason: "script_complete" }],
  ] as never, "gold-b");
}
/** The seq of the first utterance by `role` (a quote must come from one of that role's own lines). */
const firstSeq = (events: SessionEvent[], role: string): number => events.find((e) => e.type === "utterance" && e.roleId === role)!.seq;
const providerB = (events: SessionEvent[]): Provider => recording("golden-b", async function* (req) {
  const r = roleOf(req);
  if (r === "group") {
    yield JSON.stringify({ criteria: [crit("shared_understanding", 3, firstSeq(events, "bob"), QUOTE)], talking_points: ["Compare the first position with the final terms."], notable_moments: [{ seq: firstSeq(events, "alice"), quote: QUOTE, note: "Ownership named." }] });
  } else {
    const q = firstSeq(events, r);
    yield JSON.stringify({ criteria: [crit("discovery", 3, q, QUOTE), crit("listening", 2, q, QUOTE), crit("negotiation", 3, q, QUOTE)], strengths: ["Clear about ownership."], development_points: ["Name the price earlier."], next_actions: [{ lo: "LO1", action: "Ask one more open question." }] });
  }
});
const CAL_OK: EvaluatorInfo["calibration"] = {
  state: "ok",
  summary: {
    schema: "acr.calibration.summary/1", scenarioId: "mini-01", rubricHash: "h1", variant: "v1", judge: { label: "golden judge", model: "golden-model" }, ranAt: "2026-01-02T03:04:05.000Z",
    probes: { total: 12, tune: 8, holdout: 4 }, exact: { n: 30, of: 40 }, bias: 0.1, contrast: { ordered: 5, of: 5, probes: 5 }, usable: { n: 40, of: 40 }, label: "PASS",
  },
};

// ---- run (c): friday-escalation, two players silent, account_manager's call fails ----------------------------------------------
const providerC = (events: SessionEvent[]): Provider => recording("golden-c", async function* (req) {
  const r = roleOf(req);
  if (r === "account_manager") throw new Error("golden provider failure");
  const seq = events.find((e) => e.type === "utterance" && e.roleId === "account_manager")!.seq;
  yield JSON.stringify({ criteria: [crit("shared_understanding", 2, seq, "I would rather not say no outright")], talking_points: ["Ask who owned the price."], notable_moments: [] });
});

// ---- the recording ----------------------------------------------------------------------------------------------------------------
type Run = { id: string; scenarioDir: string; events: SessionEvent[]; scenario: Scenario; rubrics: Rubric[]; cfg: EvalConfig; info: EvaluatorInfo; provider: () => Provider };

async function cfgOf(chars?: number): Promise<EvalConfig> {
  const c = parseEvalConfig({});
  if (!c.ok) throw new Error("config");
  const { ok: _ok, ...cfg } = c; void _ok;
  if (chars !== undefined) cfg.transcriptChars = chars; // the environment value is clamped to >= 5,000 (config.ts), so set it on the parsed object
  return cfg;
}

/** sampleScenario() and sampleRubrics() as a scenario package on disk, so that run (b) can go through `--scenario <dir>` too. */
async function writeMiniScenario(dir: string, scenario: Scenario, rubrics: Rubric[]): Promise<string> {
  await mkdir(path.join(dir, "roles"), { recursive: true });
  await mkdir(path.join(dir, "rubrics"), { recursive: true });
  await writeFile(path.join(dir, "scenario.yaml"), stringify(scenario.meta));
  await writeFile(path.join(dir, "script.yaml"), stringify({ scenes: scenario.script.scenes }));
  for (const r of Object.values(scenario.roles)) await writeFile(path.join(dir, "roles", `${r.id}.yaml`), stringify(r));
  for (const r of rubrics) await writeFile(path.join(dir, "rubrics", `${r.id}.yaml`), stringify(r));
  return dir;
}

async function record(out: Golden): Promise<void> {
  const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "acr-golden-")));
  // The CLI scrubs os.tmpdir() to "<tmp>" itself (so a path may read "/private<tmp>/acr-golden-xyz" on macOS), and the CLI picks a random
  // nonce for the transcript delimiters (no hook), so those two are normalised here as well.
  const scrub = (s: string): string =>
    s.split(tmp).join("<dir>").replace(/(?:\/private)?<tmp>\/acr-golden-[A-Za-z0-9]+/g, "<dir>").split(REPO).join("<repo>")
      .replace(/<<<(END )?TRANSCRIPT [0-9a-f]{16}>>>/g, `<<<$1TRANSCRIPT ${NONCE}>>>`);
  const put = (key: string, label: string, text: string) => { out[key] = { label, sha256: sha(scrub(text)) }; };
  try {
    const fa = await loadEvaluationInput(FRIDAY);
    const eventsA = FRIDAY_EVENTS();
    const eventsC = FRIDAY_EVENTS(["delivery_lead", "tech_lead"]);
    const eventsB = longEvents();
    const mini = { scenario: sampleScenario(), rubrics: sampleRubrics() as unknown as Rubric[] };
    const runs: Run[] = [
      { id: "a", scenarioDir: FRIDAY, events: eventsA, scenario: fa.scenario, rubrics: fa.rubrics, cfg: await cfgOf(), info: { provider: "mock", scripted: true, calibration: { state: "not_calibrated" } },
        provider: () => { const s = createScriptedEvaluator(eventsA, fa.scenario, fa.rubrics); return recording(s.name, (req, sig) => s.stream(req, sig)); } },
      { id: "b", scenarioDir: "", events: eventsB, ...mini, cfg: await cfgOf(1_500), info: { provider: "golden provider", model: "golden-model", variant: "v1", rubricHash: "h1", calibration: CAL_OK }, provider: () => providerB(eventsB) },
      { id: "c", scenarioDir: FRIDAY, events: eventsC, scenario: fa.scenario, rubrics: fa.rubrics, cfg: await cfgOf(), info: { provider: "golden provider", model: "golden-model", variant: "v1", rubricHash: "h1", calibration: { state: "not_calibrated" } }, provider: () => providerC(eventsC) },
    ];
    for (const r of runs) {
      const k = `run.${r.id}`;
      // 1. in process: evaluateSession with the recording provider
      const provider = r.provider();
      const result: EvaluationResult = await evaluateSession({ events: r.events, scenario: r.scenario, rubrics: r.rubrics, provider, config: r.cfg, nonce: NONCE });
      if (r.id === "b") expect(result.trimmed).not.toBeNull();
      if (r.id === "c") {
        expect(result.participants.map((p) => `${p.roleId}:${p.status}`).sort()).toEqual(["account_manager:failed", "delivery_lead:insufficient_evidence", "tech_lead:insufficient_evidence"]);
        expect(result.group.status).toBe("ok");
      }
      provider.calls.forEach((req, i) => put(`${k}.requests[${i}]`, `the request the provider received, call ${i + 1} of ${provider.calls.length}`, JSON.stringify(req)));
      put(`${k}.requests.count`, "number of provider calls", String(provider.calls.length));
      const rendered = renderReports(result, r.info);
      for (const name of [...rendered.files.keys()].sort()) put(`${k}.reports['${name}']`, `rendered report file ${name}`, rendered.files.get(name)!);
      put(`${k}.summary`, "summaryLines(result) joined by newline", summaryLines(result).join("\n"));

      // 2. the CLI: runEvaluate --json - on the same log, provider by the test hook
      const cdir = path.join(tmp, `cli-${r.id}`);
      const logFile = path.join(tmp, `${r.id}.jsonl`);
      await writeFile(logFile, r.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
      const scenarioDir = r.scenarioDir || (await writeMiniScenario(path.join(tmp, "mini-scenario"), r.scenario, r.rubrics));
      let so = ""; let se = "";
      const cliProvider = r.provider();
      const code = await runEvaluate({ argv: [logFile, "--scenario", scenarioDir, "--out", cdir, "--json", "-"], stdout: { write: (c) => (so += c) }, stderr: { write: (c) => (se += c) }, env: {}, repoRoot: REPO, cwd: tmp, provider: cliProvider });
      expect(code.exitCode, `${r.id}: the CLI run must reach the reports (stderr: ${scrub(se).slice(0, 300)})`).toBe(r.id === "c" ? 1 : 0);
      put(`${k}.cli.exitCode`, "runEvaluate exit code", String(code.exitCode));
      put(`${k}.cli.stdout`, "runEvaluate stdout with --json -", so);
      put(`${k}.cli.stderr`, "runEvaluate stderr (the narration)", se);
      cliProvider.calls.forEach((req, i) => put(`${k}.cli.requests[${i}]`, `the request the CLI's provider received, call ${i + 1}`, JSON.stringify(req)));
      const cfiles = (await readdir(path.join(cdir, r.events[0]!.sessionId))).sort();
      put(`${k}.cli.files`, "file names written by the CLI", cfiles.join("\n"));
      for (const f of cfiles) put(`${k}.cli.reports['${f}']`, `file ${f} written by the CLI`, await readFile(path.join(cdir, r.events[0]!.sessionId, f), "utf8"));

      // 3. the written directory: verifyReportFiles, then the review tool
      const root = path.join(tmp, `review-${r.id}`);
      const w = await writeReports(result, { outDir: root, evaluator: r.info });
      const verified = await verifyReportFiles(w.dir, r.events, r.scenario);
      expect(verified.problems, `${r.id}: verifyReportFiles`).toEqual([]);
      put(`${k}.verify`, "JSON.stringify(verifyReportFiles(...))", JSON.stringify(verified));
      const run = makeRunner(root);
      const rel = path.relative(root, w.dir);
      const must = async (argv: string[]) => { const x = await run(argv); if (x.code !== 0) throw new Error(`review ${argv.slice(0, 3).join(" ")} failed (${x.code}): ${x.err}`); return x; };
      await must(["open", rel, "--by", "kamal"]);
      const index = async (a: Parameters<typeof renderReviewIndex>[1]) => renderReviewIndex(await loadReview(w.dir), a, []);
      put(`${k}.review.index.facilitator.opened`, "facilitator review index right after open", await index({ audience: "facilitator" }));
      const first = result.participants.find((p) => p.status === "ok")?.roleId;
      if (first) {
        const resolve = async (subject: string) => {
          const sv = (await loadReview(w.dir)).view.subjects.get(subject)!;
          for (const c of sv.criteria.filter((x) => x.status === "needs_review")) await must(["accept", rel, subject, c.id, "--by", "kamal"]);
          if ((await loadReview(w.dir)).view.subjects.get(subject)!.summaryStale) await must(["accept", rel, subject, "--summary", "--by", "kamal"]);
        };
        for (const s of [first, "group"]) { await resolve(s); await must(["release", rel, s, "--by", "kamal"]); }
        put(`${k}.review.index.facilitator.released`, `facilitator review index after releasing ${first} and group`, await index({ audience: "facilitator" }));
        put(`${k}.review.index.participant`, `participant (${first}) review index after release`, await index({ audience: "participant", role: first }));
        const dest = path.join(tmp, `export-${r.id}`);
        await must(["export", rel, "group", "--for", `participant:${first}`, "--to", dest, "--by", "kamal"]);
        for (const f of (await readdir(dest)).sort()) put(`${k}.review.export.group['${f}']`, `participant export of the group report for ${first}, file ${f}`, await readFile(path.join(dest, f), "utf8"));
      } else put(`${k}.review.noScoredPlayer`, "no player was scored in this run, so nothing was released or exported", "none");
    }
  } finally { await rm(tmp, { recursive: true, force: true }); }
}

describe("golden evaluator output for sessions without AI roles", () => {
  const drift: string[] = [];
  it("matches the recorded hashes (GOLDEN_RECORD=1 re-records)", async () => {
    const got: Golden = {};
    await record(got);
    if (process.env.GOLDEN_RECORD === "1") {
      const sorted = Object.fromEntries(Object.keys(got).sort().map((k) => [k, got[k]!]));
      await writeFile(FIXTURE, `${JSON.stringify(sorted, null, 2)}\n`);
      return;
    }
    const want = JSON.parse(await readFile(FIXTURE, "utf8")) as Golden;
    for (const k of Object.keys(want)) {
      if (!got[k]) drift.push(`MISSING ${k} (${want[k]!.label})`);
      else if (got[k]!.sha256 !== want[k]!.sha256) drift.push(`DRIFTED ${k} (${want[k]!.label})`);
    }
    for (const k of Object.keys(got)) if (!want[k]) drift.push(`NEW ${k} (${got[k]!.label})`);
    if (drift.length) throw new Error(`golden output for sessions without AI roles changed in ${drift.length} place(s):\n${drift.join("\n")}`);
    expect(Object.keys(got).length).toBe(Object.keys(want).length);
  }, 120_000);
});

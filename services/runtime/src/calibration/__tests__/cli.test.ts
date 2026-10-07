import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CALIBRATE_USAGE, plannedCalls, runCalibrate } from "../cli.js";
import { loadProbes } from "../probe-load.js";
import { loadScenario, loadRubrics } from "@acr/script";
import type { Judge } from "../judge.js";
import { fakeJudge, type FakeJudge } from "./fake-judge.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const FRIDAY = path.join(REPO, "scenarios", "friday-escalation");
let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-cal-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const io = () => { const out: string[] = [], err: string[] = []; return { out, err, stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) } }; };
const criteria = ["discovery", "listening", "negotiation", "commercial_judgement", "stakeholder_management", "team_alignment", "role_clarity"];
const good = (): FakeJudge => fakeJudge(criteria, ({ transcript, role }) => ({
  discovery: transcript.includes("consider it done") ? 1 : transcript.includes("daily summary report") ? 4 : 3,
  listening: role === "delivery_lead" ? 4 : 1,
  negotiation: transcript.includes("Of course, we will absorb it") || role === "account_manager" ? 1 : 4,
}));
const judge = (p: FakeJudge, label = "primary"): Judge => ({ label, model: `fake-model-${label}`, family: "fake", provider: p });
type Extra = { judges?: Judge[]; signal?: AbortSignal };
const run = (argv: string[], extra: Extra = {}, env: NodeJS.ProcessEnv = {}) => {
  const o = io();
  return runCalibrate({ argv, stdout: o.stdout, stderr: o.stderr, env, repoRoot: REPO, cwd: dir, ...extra }).then((r) => ({ ...r, ...o, outText: o.out.join(""), errText: o.err.join("") }));
};
const SCN = ["--scenario", "scenarios/friday-escalation"];
const exists = (p: string) => stat(p).then(() => true, () => false);

/** A copy of the Friday scenario whose calibration directory holds exactly these probe files. */
async function scenarioWith(probes: Record<string, string>): Promise<string> {
  const scn = path.join(dir, "scn");
  await cp(FRIDAY, scn, { recursive: true });
  await rm(path.join(scn, "calibration"), { recursive: true, force: true });
  await mkdir(path.join(scn, "calibration"));
  for (const [name, text] of Object.entries(probes)) await writeFile(path.join(scn, "calibration", name), text);
  return scn;
}
const line = (role: string, text: string) => `  - { scene: s1_huddle, role: ${role}, text: "${text}" }`;
const single = (id: string, lines: string[], extra = "") => [`kind: single`, `id: ${id}`, `criterion: discovery`, `source: handwritten`, `split: tune`, `subject: delivery_lead`, `expected: 2`, extra, `transcript:`, ...lines].filter(Boolean).join("\n") + "\n";

describe("pnpm calibrate: the mock refusal", () => {
  it("refuses the mock provider when no judge is configured, and writes nothing", async () => {
    for (const env of [{}, { MODEL_PROVIDER: "mock" }]) {
      const r = await run([...SCN, "--out", path.join(dir, "out")], {}, env);
      expect(r.exitCode).toBe(2);
      expect(r.errText).toMatch(/^error: MODEL_PROVIDER is mock/m);
      expect(r.run).toBeUndefined();
    }
    expect(await exists(path.join(dir, "out"))).toBe(false);
  });
  it("still refuses a mock primary when a second judge is given with --judge", async () => {
    const r = await run([...SCN, "--out", path.join(dir, "out"), "--judge", "second,holo3-35b-a3b-jangtq4,http://127.0.0.1:1337/v1"], {}, { MODEL_PROVIDER: "mock" });
    expect(r.exitCode).toBe(2);
    expect(r.errText).toMatch(/mock/);
    expect(await exists(path.join(dir, "out"))).toBe(false);
  });
});

describe("pnpm calibrate: runs", () => {
  it("runs the starter set against injected judges and writes a report and summary", async () => {
    const r = await run([...SCN, "--out", dir], { judges: [judge(good())] });
    expect(r.exitCode).toBe(0);
    expect(r.outText).toMatch(/primary/);
    expect(r.outText).toMatch(/# Calibration: esc-scope-creep-01/);
    expect(r.outText).toMatch(/report written to .*calibration-report\.md/);
    const files = await readdir(path.join(dir, "esc-scope-creep-01"));
    expect(files).toContain("fake-model-primary-v1.json");
    expect(r.run?.judges).toHaveLength(1);
    expect(r.run?.judges[0]!.outcomes).toHaveLength(8);
  });
  it("accepts the explicit run subcommand", async () => {
    const r = await run(["run", ...SCN, "--out", dir, "--only", "disc-l1"], { judges: [judge(good())] });
    expect(r.exitCode).toBe(0);
    expect(r.run?.probeCount).toBe(1);
  });
  it("runs a second judge blind and compares them", async () => {
    const a = good(), b = good();
    const r = await run([...SCN, "--out", dir, "--only", "disc-l1,disc-l3"], { judges: [judge(a), judge(b, "second")] });
    expect(r.exitCode).toBe(0);
    expect(r.run?.comparison?.pairs).toBeGreaterThan(0);
    expect(r.run?.judges.map((j) => j.judge.label)).toEqual(["primary", "second"]);
    // blind: neither judge's requests carry anything from the other judge
    for (const req of b.calls) expect(JSON.stringify(req)).not.toMatch(/fake-model-primary|Because discovery/);
    // a subset run (--only) never writes a summary file
    expect((await readdir(path.join(dir, "esc-scope-creep-01"))).filter((f) => f.endsWith(".json"))).toEqual([]);
  });
  it("--strict exits 1 when a judge FAILs; without it the exit code stays 0", async () => {
    const flat = () => fakeJudge(criteria, () => Object.fromEntries(criteria.map((c) => [c, 3])));
    const plain = await run([...SCN, "--out", dir], { judges: [judge(flat())] });
    expect(plain.run?.judges[0]!.label.label).toBe("FAIL");
    expect(plain.exitCode).toBe(0);
    expect((await run([...SCN, "--out", dir, "--strict"], { judges: [judge(flat())] })).exitCode).toBe(1);
    expect((await run([...SCN, "--out", dir, "--strict", "--only", "disc-l1"], { judges: [judge(good())] })).exitCode).not.toBe(1);
  });
  it("records an unreachable judge as unusable, keeps it in the report and still runs the other judge", async () => {
    const down = fakeJudge(criteria, () => ({ discovery: 3 }), () => true);
    const second = good();
    const r = await run([...SCN, "--out", dir], { judges: [judge(down), judge(second, "second")] });
    expect(r.exitCode).toBe(0);
    const [a, b] = r.run!.judges;
    expect(a!.metrics.usability.unusable).toBe(a!.metrics.usability.slots);
    expect(a!.label.label).toBe("WARN");
    expect(b!.outcomes).toHaveLength(8);
    expect(second.calls.length).toBeGreaterThan(0);
    expect(r.outText).toMatch(/usable 0 of/);
  });
  it("keeps partial results when a judge goes down mid-run", async () => {
    const flaky = fakeJudge(criteria, () => ({ discovery: 3 }), (role) => role === "account_manager");
    const r = await run([...SCN, "--out", dir], { judges: [judge(flaky)] });
    expect(r.exitCode).toBe(0);
    expect(r.outText).toMatch(/usable \d+ of \d+ answers/);
    expect(r.run!.judges[0]!.metrics.usability.unusable).toBeGreaterThan(0);
  });
  it("reports a judge whose run throws, keeps its outcomes so far, writes the run and still runs the next judge", async () => {
    const p = good();
    let n = 0;
    const exploding: Judge = { label: "primary", model: "fake-model-primary", family: "fake", get provider() { if (++n > 2) throw new Error("boom sk-live-SECRET-0001"); return p; } };
    const r = await run([...SCN, "--out", dir], { judges: [exploding, judge(good(), "second")] }, { LOCAL_API_KEY: "sk-live-SECRET-0001" });
    expect(r.exitCode).toBe(0);
    expect(r.errText).toMatch(/judge primary: run failed: boom \[redacted\]/);
    expect(r.errText + r.outText).not.toContain("sk-live-SECRET-0001");
    expect(r.run!.judges[0]!.outcomes).toHaveLength(2);
    expect(r.run!.judges[0]!.warnings.join(" ")).toMatch(/partial: 2 of 8/);
    expect(r.run!.judges[1]!.outcomes).toHaveLength(8);
    const runs = (await readdir(path.join(dir, "esc-scope-creep-01"), { withFileTypes: true })).filter((e) => e.isDirectory());
    expect(runs).toHaveLength(1);
    expect(await readFile(path.join(dir, "esc-scope-creep-01", runs[0]!.name, "calibration.json"), "utf8")).toMatch(/acr\.calibration\/1/);
  });
  it("stops cleanly on abort: completed probes are kept and written, later judges are not run", async () => {
    const ac = new AbortController();
    let calls = 0;
    const stopping = fakeJudge(criteria, () => { if (++calls === 3) ac.abort(); return { discovery: 3, listening: 3, negotiation: 3 }; });
    const second = good();
    const r = await run([...SCN, "--out", dir], { judges: [judge(stopping), judge(second, "second")], signal: ac.signal });
    const kept = r.run!.judges[0]!.outcomes.length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(8);
    expect(second.calls).toHaveLength(0);
    expect(r.run!.judges).toHaveLength(1);
    expect(r.errText).toMatch(/aborted/);
    expect((await readdir(path.join(dir, "esc-scope-creep-01"), { withFileTypes: true })).some((e) => e.isDirectory())).toBe(true);
  });
  it("--criteria probe narrows the rubric to the probe's criterion", async () => {
    const p = good();
    const r = await run([...SCN, "--out", dir, "--only", "disc-l2", "--criteria", "probe"], { judges: [judge(p)] });
    expect(r.exitCode).toBe(0);
    expect(p.calls.length).toBeGreaterThan(0);
    for (const c of p.calls) expect(c.system).not.toContain('Criterion id "negotiation"');
    const all = good();
    await run([...SCN, "--out", dir, "--only", "disc-l2"], { judges: [judge(all)] });
    expect(all.calls[0]!.system).toContain('Criterion id "negotiation"');
  });
});

describe("pnpm calibrate: the planned call count", () => {
  it("counts every player with at least 2 lines, scored or not, times repeat times judges, and prints it before running", async () => {
    // delivery_lead is scored, account_manager speaks twice but is not scored, tech_lead speaks once
    const scn = await scenarioWith({ "count-01.yaml": single("count-01", [
      line("delivery_lead", "What problem is the module meant to solve for finance?"), line("account_manager", "Let us just agree today."),
      line("delivery_lead", "Who uses the reconciliation output each day?"), line("account_manager", "Fine, but say yes."), line("tech_lead", "The pipeline is fragile."),
    ]) });
    const a = good(), b = good();
    expect(path.relative(dir, scn)).toBe("scn"); // --scenario relative to the cwd (the temp dir), not the repository
    const r = await run(["--scenario", "scn", "--out", dir, "--repeat", "2"], { judges: [judge(a), judge(b, "second")] });
    expect(r.exitCode).toBe(0);
    expect(r.outText).toMatch(/planned: 8 model calls \(1 probe, repeat 2, 2 judges/);
    expect(r.outText.indexOf("planned:")).toBeLessThan(r.outText.indexOf("# Calibration"));
    expect(a.calls.length + b.calls.length).toBe(8);
  });
  it("plannedCalls is the per-probe player count x repeat x judges: exact counts on the starter set", async () => {
    // By hand: the 6 single probes each have one player with 2+ lines (delivery_lead; client_sponsor is an AI character and does not count),
    // listening-contrast-01 has delivery_lead and account_manager (tech_lead speaks once), negotiation-contrast-01 has delivery_lead and
    // account_manager (client_sponsor again not counted): 6 + 2 + 2 = 10 calls per run. Counting AI characters too would give 17.
    const scenario = await loadScenario(FRIDAY);
    const { rubrics } = await loadRubrics(FRIDAY, scenario);
    const { probes } = await loadProbes(FRIDAY, scenario, rubrics);
    expect(probes).toHaveLength(8);
    expect(plannedCalls(probes, scenario, 1, 1)).toBe(10);
    expect(plannedCalls(probes, scenario, 3, 2)).toBe(60);
    expect(plannedCalls(probes.filter((p) => p.id === "listening-contrast-01"), scenario, 1, 1)).toBe(2);
    expect(plannedCalls(probes.filter((p) => p.id === "disc-l2"), scenario, 5, 1)).toBe(5);
    const r = await run([...SCN, "--out", dir, "--repeat", "2"], { judges: [judge(good())] });
    expect(r.outText).toMatch(/planned: 20 model calls \(8 probes, repeat 2, 1 judge;/);
  });
  it("never counts an AI character, however often it speaks", async () => {
    const scn = await scenarioWith({ "npc-01.yaml": single("npc-01", [
      line("client_sponsor", "We need the module."), line("delivery_lead", "What is it for?"), line("client_sponsor", "Finance."),
      line("client_sponsor", "By Friday."), line("delivery_lead", "Who reads its output?"),
    ]) });
    const a = good();
    const r = await run(["--scenario", scn, "--out", dir], { judges: [judge(a)] });
    expect(r.outText).toMatch(/planned: 1 model call \(1 probe, repeat 1, 1 judge;/);
    expect(a.calls).toHaveLength(1);
  });
});

describe("pnpm calibrate: output", () => {
  it("--json - prints only the run as JSON on stdout, narration on stderr, with secrets scrubbed", async () => {
    const secret = "sk-live-SECRET-4242";
    const scn = await scenarioWith({ "sec-01.yaml": single("sec-01", [
      line("delivery_lead", `My key is ${secret} so what does finance need?`), line("client_sponsor", "The module."), line("delivery_lead", "Why that module?"),
    ]) });
    const r = await run(["--scenario", scn, "--out", dir, "--json", "-"], { judges: [judge(good())] }, { LOCAL_API_KEY: secret });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.outText) as { schema: string; judges: unknown[] };
    expect(parsed.schema).toBe("acr.calibration/1");
    expect(r.outText).not.toContain(secret);
    expect(r.outText).toContain("[redacted]");
    expect(r.errText).toMatch(/planned:/);
    expect(r.errText).not.toContain(secret);
  });
  it("--json <file> writes the run exclusively with a private mode, and refuses an existing file", async () => {
    const file = path.join(dir, "run.json");
    const r = await run([...SCN, "--out", dir, "--only", "disc-l1", "--json", file], { judges: [judge(good())] });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(await readFile(file, "utf8")).schema).toBe("acr.calibration/1");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const again = await run([...SCN, "--out", dir, "--only", "disc-l1", "--json", file], { judges: [judge(good())] });
    expect(again.exitCode).toBe(2);
    expect(again.errText).toMatch(/already exists/);
  });
  it("prints each probe problem on its own line, and hostile text in a message never reaches the terminal", async () => {
    const scn = await scenarioWith({ "a.yaml": "kind: single\nid: a\n", "b.yaml": "kind: nope\n" });
    const r = await run(["--scenario", scn, "--out", dir], { judges: [judge(good())] });
    expect(r.exitCode).toBe(2);
    const lines = r.errText.split("\n");
    expect(lines[0]).toMatch(/^error: the probes are invalid \(2 problems\):$/);
    expect(lines.filter((l) => l.startsWith("  - "))).toHaveLength(2);
    expect(r.errText).not.toContain("⏎");
    const p = good();
    let n = 0;
    const hostile = "boom \u001b[2J\u202eevil\u200b\u061c\u2028tail";
    const exploding: Judge = { label: "primary", model: "fake-model-primary", family: "fake", get provider() { if (++n > 1) throw new Error(hostile); return p; } };
    const h = await run([...SCN, "--out", dir], { judges: [exploding] });
    const failLine = h.err.find((l) => l.includes("run failed"))!;
    expect(failLine).toMatch(/^judge primary: run failed: boom /);
    expect(failLine.trimEnd().split("\n")).toHaveLength(1);
    expect(failLine).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u061c\u200b-\u200f\u2028-\u202e]/);
  });
  it("prints at most 25 lines of the report summary, made printable", async () => {
    const r = await run([...SCN, "--out", dir], { judges: [judge(good()), judge(good(), "second")] });
    const start = r.out.findIndex((s) => s.startsWith("# Calibration"));
    const end = r.out.findIndex((s) => s.startsWith("report written to"));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end - start).toBeLessThanOrEqual(26);
    for (const s of r.out) expect(s).not.toMatch(/[\u0000-\u0009\u000b-\u001f​-‏‪-‮]/);
  });
});

describe("pnpm calibrate: usage and input errors", () => {
  it("--help prints the usage and exits 0", async () => {
    const r = await run(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.outText).toContain(CALIBRATE_USAGE);
  });
  it("rejects bad options with exit 2", async () => {
    const j = { judges: [judge(good())] };
    for (const argv of [
      [...SCN, "--repeat", "99"], [...SCN, "--repeat", "0"], [...SCN, "--repeat", "1.5"], [...SCN, "--repeat", "two"],
      [...SCN, "--only", "nope"], [...SCN, "--only", ""], [...SCN, "--only", ","],
      [...SCN, "--criteria", "some"], [...SCN, "--variant", "v2"], [...SCN, "--variant", "../x"],
      ["--bogus"], [], ["--scenario", "no/such/dir"], ["--scenario", "sc\u0007enarios"], [...SCN, "--out", "a\u0000b"], [...SCN, "--json", "x\u001b"], [...SCN, "--json", ""],
    ]) {
      const r = await run(argv, j);
      expect(r.exitCode, JSON.stringify(argv)).toBe(2);
      expect(r.errText, JSON.stringify(argv)).toMatch(/^error: /);
    }
    expect(await readdir(dir)).toEqual([]);
  });
  it("refuses the label primary for --judge, a probe listed twice in --only, a file as --scenario and a --json file in a missing directory", async () => {
    const localEnv = { MODEL_PROVIDER: "local", LOCAL_BASE_URL: "http://127.0.0.1:3/v1", NPC_MODEL: "gemma-4-31b" };
    const prim = await run([...SCN, "--judge", "primary,m1,http://127.0.0.1:1/v1"], {}, localEnv);
    expect(prim.exitCode).toBe(2);
    expect(prim.errText).toMatch(/label primary is taken/);
    const twice = await run([...SCN, "--out", dir, "--only", "disc-l1,disc-l1"], { judges: [judge(good())] });
    expect(twice.exitCode).toBe(2);
    expect(twice.errText).toMatch(/--only lists a probe twice/);
    await writeFile(path.join(dir, "file.txt"), "x");
    const file = await run(["--scenario", "file.txt", "--out", dir], { judges: [judge(good())] });
    expect(file.exitCode).toBe(2);
    expect(file.errText).toMatch(/is not a directory/);
    const missing = await run(["--scenario", "no/such/dir"], { judges: [judge(good())] });
    expect(missing.errText).toMatch(/does not exist/);
    const p = good();
    const json = await run([...SCN, "--out", dir, "--json", path.join(dir, "nope", "run.json")], { judges: [judge(p)] });
    expect(json.exitCode).toBe(2);
    expect(json.errText).toMatch(/--json: the directory .* does not exist/);
    expect(p.calls).toHaveLength(0);
  });
  it("allows at most one --judge and never echoes a bad spec", async () => {
    const two = await run([...SCN, "--judge", "b,m1,http://127.0.0.1:1/v1", "--judge", "c,m2,http://127.0.0.1:2/v1"], {}, { MODEL_PROVIDER: "local", LOCAL_BASE_URL: "http://127.0.0.1:3/v1", NPC_MODEL: "gemma-4-31b" });
    expect(two.exitCode).toBe(2);
    expect(two.errText).toMatch(/at most one --judge/);
    const bad = await run([...SCN, "--judge", "b,m,http://h/v1?token=sk-SECRET-9"], {}, { MODEL_PROVIDER: "local", LOCAL_BASE_URL: "http://127.0.0.1:3/v1", NPC_MODEL: "gemma-4-31b" });
    expect(bad.exitCode).toBe(2);
    expect(bad.errText).not.toContain("sk-SECRET-9");
  });
  it("handles subcommands: run is the default, the reserved ones are not available yet, anything else is refused", async () => {
    for (const name of ["draft", "excerpt", "approve", "assign-splits"]) {
      const r = await run([name, ...SCN], { judges: [judge(good())] });
      expect(r.exitCode).toBe(2);
      expect(r.errText).toContain(`error: subcommand "${name}" is not available yet`);
    }
    for (const argv of [["bogus", ...SCN], ["run", "extra", ...SCN], ["run", "run", ...SCN]]) {
      const r = await run(argv, { judges: [judge(good())] });
      expect(r.exitCode, JSON.stringify(argv)).toBe(2);
    }
  });
  it("fails the run with every probe problem listed, before any model call", async () => {
    const scn = await scenarioWith({ "a.yaml": "kind: single\nid: a\n", "b.yaml": "kind: nope\n" });
    const p = good();
    const r = await run(["--scenario", scn, "--out", dir], { judges: [judge(p)] });
    expect(r.exitCode).toBe(2);
    expect(r.errText).toMatch(/a\.yaml/);
    expect(r.errText).toMatch(/b\.yaml/);
    expect(p.calls).toHaveLength(0);
  });
  it("refuses a scenario without probes", async () => {
    const scn = await scenarioWith({});
    const r = await run(["--scenario", scn, "--out", dir], { judges: [judge(good())] });
    expect(r.exitCode).toBe(2);
    expect(r.errText).toMatch(/no probes/);
  });
  it("reports a YAML warning in a probe as a probe error, never on process stderr", async () => {
    const scn = await scenarioWith({ "w.yaml": "kind: single\nid: w\nexpected: !!js/function 'x'\n" });
    const emit = vi.spyOn(process, "emitWarning");
    try {
      const r = await run(["--scenario", scn, "--out", dir], { judges: [judge(good())] });
      expect(r.exitCode).toBe(2);
      expect(r.errText).toMatch(/w\.yaml: .*Unresolved tag/);
      expect(emit).not.toHaveBeenCalled();
    } finally { emit.mockRestore(); }
  });
});

describe("pnpm calibrate: summary files are replaced only by a complete run", () => {
  const summary = () => path.join(dir, "esc-scope-creep-01", "fake-model-primary-v1.json");
  async function baseline(): Promise<string> {
    expect(await exists(summary())).toBe(false);
    const r = await run([...SCN, "--out", dir], { judges: [judge(good())] });
    expect(r.exitCode).toBe(0);
    expect(r.outText).toMatch(/summaries updated: fake-model-primary-v1\.json/);
    return readFile(summary(), "utf8");
  }
  const runDirs = async () => (await readdir(path.join(dir, "esc-scope-creep-01"), { withFileTypes: true })).filter((e) => e.isDirectory()).length;

  it("a first-ever complete run creates the summary, and a later complete run replaces it", async () => {
    const before = await baseline();
    expect(JSON.parse(before).probes.total).toBe(8);
    const flat = fakeJudge(criteria, () => Object.fromEntries(criteria.map((c) => [c, 3])));
    await run([...SCN, "--out", dir], { judges: [judge(flat)] });
    const after = JSON.parse(await readFile(summary(), "utf8"));
    expect(after.label).toBe("FAIL");
    expect(await readFile(summary(), "utf8")).not.toBe(before);
  });
  it.each([
    ["subset (--only)", ["--only", "disc-l1"], () => ({ judges: [judge(good())] })],
    ["one criterion (--criteria probe)", ["--criteria", "probe"], () => ({ judges: [judge(good())] })],
    ["no usable answers", [], () => ({ judges: [judge(fakeJudge(criteria, () => ({ discovery: 3 }), () => true))] })],
    ["run failed", [], () => {
      const p = good();
      let n = 0;
      const j: Judge = { label: "primary", model: "fake-model-primary", family: "fake", get provider() { if (++n > 2) throw new Error("boom"); return p; } };
      return { judges: [j] };
    }],
    ["aborted", [], () => {
      const ac = new AbortController();
      let calls = 0;
      const j = fakeJudge(criteria, () => { if (++calls === 3) ac.abort(); return { discovery: 3 }; });
      return { judges: [judge(j)], signal: ac.signal };
    }],
  ] as [string, string[], () => Extra][])("leaves the summary untouched when the run is %s, and still writes the run", async (reason, argv, extra) => {
    const before = await baseline();
    const r = await run([...SCN, "--out", dir, ...argv], extra());
    expect(r.errText + r.outText).toContain(`summary for fake-model-primary not updated: ${reason}`);
    expect(await readFile(summary(), "utf8")).toBe(before);
    expect(await runDirs()).toBe(2);
  });
  it("never creates a summary file for a skipped judge", async () => {
    const r = await run([...SCN, "--out", dir, "--only", "disc-l1,disc-l2"], { judges: [judge(good())] });
    expect(r.exitCode).toBe(0);
    expect(await exists(summary())).toBe(false);
    expect(await runDirs()).toBe(1);
  });
  it("updates the complete judge's summary and skips only the other one", async () => {
    const down = fakeJudge(criteria, () => ({ discovery: 3 }), () => true);
    const r = await run([...SCN, "--out", dir], { judges: [judge(good()), judge(down, "second")] });
    expect(r.errText + r.outText).toContain("summary for fake-model-second not updated: no usable answers");
    expect(await exists(summary())).toBe(true);
    expect(await exists(path.join(dir, "esc-scope-creep-01", "fake-model-second-v1.json"))).toBe(false);
  });
});

describe("pnpm calibrate: files on disk and write failures", () => {
  it("scrubs a secret a judge put in a rationale from every file and from the output", async () => {
    const secret = "sk-live-RATIONALE-777";
    const leaky = fakeJudge(criteria, () => ({ discovery: 3, listening: 3, negotiation: 3 }), undefined, undefined, (id) => `Because ${id} and ${secret}.`);
    const r = await run([...SCN, "--out", dir, "--json", path.join(dir, "run.json")], { judges: [judge(leaky)] }, { LOCAL_API_KEY: secret });
    expect(r.exitCode).toBe(0);
    expect(r.outText + r.errText).not.toContain(secret);
    const files: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) await walk(f); else files.push(f);
      }
    };
    await walk(dir);
    expect(files.filter((f) => f.endsWith("calibration-report.md") || f.endsWith("calibration.json") || f.endsWith("-v1.json") || f.endsWith("run.json"))).toHaveLength(4);
    for (const f of files) expect(await readFile(f, "utf8"), f).not.toContain(secret);
    const json = await readFile(files.find((f) => f.endsWith("calibration.json"))!, "utf8");
    expect(json).toContain("[redacted]");
  });
  it("exits 1 when the run cannot be written", async () => {
    await writeFile(path.join(dir, "out"), "a file where the data directory should be");
    const r = await run([...SCN, "--out", path.join(dir, "out"), "--only", "disc-l1"], { judges: [judge(good())] });
    expect(r.exitCode).toBe(1);
    expect(r.errText).toMatch(/^error: cannot write the results: /m);
  });
  it("exits 1 and names the run directory it wrote when only the summaries fail", async () => {
    const out = path.join(dir, "cal-out");
    await mkdir(path.join(out, "esc-scope-creep-01", "fake-model-primary-v1.json", "occupied"), { recursive: true });
    const r = await run([...SCN, "--out", out], { judges: [judge(good())] });
    expect(r.exitCode).toBe(1);
    const msg = r.err.find((l) => l.startsWith("error: "))!;
    expect(msg).toMatch(/^error: the run was written to cal-out\/esc-scope-creep-01\/[0-9T-]+Z?[^/ ]* but the summaries could not be updated: calibration summary: could not replace esc-scope-creep-01\/fake-model-primary-v1\.json/);
    expect(msg).not.toContain("<tmp>");
    expect(msg).not.toContain(dir);
  });
});

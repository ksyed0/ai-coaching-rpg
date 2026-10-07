import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRubrics, loadScenario } from "@acr/script";
import { parseEvalConfig } from "../../evaluator/config.js";
import { loadProbes } from "../probe-load.js";
import { runJudge, MAX_REPEAT } from "../runner.js";
import type { ChatRequest } from "@acr/adapters";
import { fakeJudge, UNREACHABLE, type FakeJudge } from "./fake-judge.js";
import type { Probe } from "../probe-schema.js";
import type { Judge } from "../judge.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const cfgParsed = parseEvalConfig({}); if (!cfgParsed.ok) throw new Error("cfg");
const cfg = cfgParsed;
const dir = path.join(REPO, "scenarios/friday-escalation");

async function setup() {
  const scenario = await loadScenario(dir);
  const { rubrics } = await loadRubrics(dir, scenario);
  const { probes } = await loadProbes(dir, scenario, rubrics);
  const ids = rubrics.filter((r) => r.scope === "individual").flatMap((r) => r.criteria.map((c) => c.id));
  return { scenario, rubrics, probes, ids };
}
const judgeOf = (provider: Judge["provider"]): Judge => ({ label: "primary", model: "fake", family: "fake", provider });

describe("runJudge", () => {
  it("scores each probe through the real evaluator and records observed levels", async () => {
    const { scenario, rubrics, probes, ids } = await setup();
    const provider = fakeJudge(ids, ({ transcript }) => (transcript.includes("consider it done") ? { discovery: 1 } : { discovery: 3 }));
    const out = await runJudge(judgeOf(provider), probes.filter((p) => p.id === "disc-l1"), scenario, rubrics, cfg, { repeat: 1, allCriteria: true });
    expect(out).toHaveLength(1);
    const o = out[0]!;
    expect(o.kind).toBe("single");
    if (o.kind === "single") expect(o.runs).toEqual([1]);
    expect(o.evidence[0]!.quotes.length).toBeGreaterThan(0);
  });
  it("scores every player of a contrast probe and maps them by role", async () => {
    const { scenario, rubrics, probes, ids } = await setup();
    const provider = fakeJudge(ids, ({ role }) => ({ listening: role === "delivery_lead" ? 4 : 1 }));
    const out = await runJudge(judgeOf(provider), probes.filter((p) => p.id === "listening-contrast-01"), scenario, rubrics, cfg, { repeat: 1, allCriteria: true });
    const o = out[0]!;
    expect(o.kind === "contrast" && o.runs[0]).toEqual({ delivery_lead: 4, account_manager: 1 });
  });
  it("records an unreachable judge as unusable, not as a score", async () => {
    const { scenario, rubrics, probes, ids } = await setup();
    const provider = fakeJudge(ids, () => ({}), () => true);
    const out = await runJudge(judgeOf(provider), probes.filter((p) => p.id === "disc-l1"), scenario, rubrics, cfg, { repeat: 1, allCriteria: true });
    const o = out[0]!;
    expect(o.kind === "single" && o.runs[0]).toBe("failed");
    // failed for the right reason: the judge threw its own error, not a prompt-format break
    expect(provider.unreachable.length).toBeGreaterThan(0);
    expect(provider.unreachable[0]).toBe(UNREACHABLE);
    expect(provider.unexpected).toEqual([]);
  });
  it("repeats, filters with --only and caps repeat", async () => {
    const { scenario, rubrics, probes, ids } = await setup();
    const provider = fakeJudge(ids, () => ({ discovery: 2 }));
    const out = await runJudge(judgeOf(provider), probes, scenario, rubrics, cfg, { repeat: 2, only: ["disc-l2"], allCriteria: true });
    expect(out).toHaveLength(1);
    expect(out[0]!.kind === "single" && out[0]!.runs).toEqual([2, 2]);
    await expect(runJudge(judgeOf(provider), probes, scenario, rubrics, cfg, { repeat: MAX_REPEAT + 1, allCriteria: true })).rejects.toThrow(/repeat/);
    await expect(runJudge(judgeOf(provider), probes, scenario, rubrics, cfg, { repeat: 1, only: ["missing"], allCriteria: true })).rejects.toThrow(/missing/);
  });
  it("narrows the rubric to the probe's criterion when allCriteria is false", async () => {
    const { scenario, rubrics, probes, ids } = await setup();
    const provider = fakeJudge(ids, () => ({ discovery: 2 }));
    await runJudge(judgeOf(provider), probes.filter((p) => p.id === "disc-l2"), scenario, rubrics, cfg, { repeat: 1, allCriteria: false });
    const system = provider.calls[0]!.system;
    // The learning-objective lines name other criterion ids, so assert on the criteria listing, not the whole prompt.
    expect(system).toContain('Criterion id "discovery"');
    expect(system).toContain('use exactly these ids): discovery.');
    expect(system).not.toContain('Criterion id "negotiation"');
  });
  it("lists every individual criterion when allCriteria is true", async () => {
    const { scenario, rubrics, probes, ids } = await setup();
    const provider = fakeJudge(ids, () => ({ discovery: 2 }));
    await runJudge(judgeOf(provider), probes.filter((p) => p.id === "disc-l2"), scenario, rubrics, cfg, { repeat: 1, allCriteria: true });
    for (const id of ids) expect(provider.calls[0]!.system).toContain(`Criterion id "${id}"`);
  });

  it("never sends a group request, even when the rubrics include the group rubric", async () => {
    const { scenario, rubrics, probes, ids } = await setup();
    expect(rubrics.some((r) => r.scope === "group")).toBe(true);
    const provider = fakeJudge(ids, () => ({ discovery: 2 }));
    await runJudge(judgeOf(provider), probes.filter((p) => p.id === "disc-l2"), scenario, rubrics, cfg, { repeat: 1, allCriteria: true });
    expect(provider.unexpected).toEqual([]);
    expect(provider.calls.length).toBeGreaterThan(0);
  });

  it("rejects --only that selects nothing", async () => {
    const { scenario, rubrics, probes, ids } = await setup();
    const provider = fakeJudge(ids, () => ({ discovery: 2 }));
    await expect(runJudge(judgeOf(provider), probes, scenario, rubrics, cfg, { repeat: 1, only: [], allCriteria: true })).rejects.toThrow(/selected no probes/);
    expect(provider.calls).toHaveLength(0);
  });

  describe("capped and dropped", () => {
    it("counts a 4 backed only by a short quote as capped, summed over roles and repeats", async () => {
      const { scenario, rubrics, probes, ids } = await setup();
      const provider = fakeJudge(ids, () => ({ listening: 4 }), undefined, (l) => l.slice(0, 9));
      const out = await runJudge(judgeOf(provider), probes.filter((p) => p.id === "listening-contrast-01"), scenario, rubrics, cfg, { repeat: 2, allCriteria: true });
      const o = out[0]!;
      expect(o.kind === "contrast" && o.runs).toEqual([{ delivery_lead: 2, account_manager: 2 }, { delivery_lead: 2, account_manager: 2 }]);
      expect(o.capped).toBe(4); // 2 roles x 2 repeats
      expect(o.dropped).toBe(0);
      expect(provider.unexpected).toEqual([]);
    });
    it("counts an invented quote as dropped, summed over roles and repeats", async () => {
      const { scenario, rubrics, probes, ids } = await setup();
      const provider = fakeJudge(ids, () => ({ listening: 1 }), undefined, () => "an invented sentence nobody ever said in this call");
      const out = await runJudge(judgeOf(provider), probes.filter((p) => p.id === "listening-contrast-01"), scenario, rubrics, cfg, { repeat: 2, allCriteria: true });
      expect(out[0]!.dropped).toBe(4);
      expect(out[0]!.capped).toBe(0);
    });
    it("counts nothing when quotes are real and strong", async () => {
      const { scenario, rubrics, probes, ids } = await setup();
      const provider = fakeJudge(ids, () => ({ discovery: 2 }));
      const out = await runJudge(judgeOf(provider), probes.filter((p) => p.id === "disc-l2"), scenario, rubrics, cfg, { repeat: 1, allCriteria: true });
      expect([out[0]!.capped, out[0]!.dropped]).toEqual([0, 0]);
    });
  });

  describe("planned call count", () => {
    it("is the players with at least 2 lines in the transcript times repeat, scored or not", async () => {
      const { scenario, rubrics, probes, ids } = await setup();
      const base = probes.find((p) => p.id === "disc-l1")!;
      const scene = base.transcript[0]!.scene;
      const probe: Probe = { ...base, transcript: [...base.transcript, { scene, role: "account_manager", text: "I am here as well." }, { scene, role: "account_manager", text: "And I have a second line." }] };
      const speakers = new Set(["delivery_lead", "account_manager"].filter((r) => probe.transcript.filter((l) => l.role === r).length >= 2));
      expect(speakers.has("account_manager")).toBe(true);
      const provider = fakeJudge(ids, () => ({ discovery: 2 }));
      await runJudge(judgeOf(provider), [probe], scenario, rubrics, cfg, { repeat: 2, allCriteria: true });
      expect(provider.calls).toHaveLength(speakers.size * 2);
    });
  });

  describe("abort", () => {
    /** Wraps a judge so the signal aborts while the call chosen by `at` is in flight. */
    function abortAt(inner: FakeJudge, ctrl: AbortController, at: (req: ChatRequest, n: number) => boolean): FakeJudge {
      let n = 0;
      return { ...inner, stream: (req: ChatRequest) => { n++; if (at(req, n)) ctrl.abort(); return inner.stream(req); } };
    }
    async function callsPerRun(probe: Probe): Promise<number> {
      const { scenario, rubrics, ids } = await setup();
      const p = fakeJudge(ids, () => ({ discovery: 2, listening: 2 }));
      await runJudge(judgeOf(p), [probe], scenario, rubrics, cfg, { repeat: 1, allCriteria: true });
      return p.calls.length;
    }

    it("drops a half-finished contrast probe instead of recording failed slots", async () => {
      const { scenario, rubrics, probes, ids } = await setup();
      const probe = probes.find((p) => p.id === "listening-contrast-01")!;
      const ctrl = new AbortController();
      const provider = abortAt(fakeJudge(ids, () => ({ listening: 3 })), ctrl, (_r, n) => n === 1);
      const out = await runJudge(judgeOf(provider), [probe], scenario, rubrics, cfg, { repeat: 1, allCriteria: true, signal: ctrl.signal });
      expect(out).toEqual([]);
    });
    it("keeps probes finished before the abort and drops the one in flight", async () => {
      const { scenario, rubrics, probes, ids } = await setup();
      const [first, second] = [probes.find((p) => p.id === "disc-l1")!, probes.find((p) => p.id === "disc-l2")!];
      const marker = second.transcript[0]!.text;
      expect(first.transcript.some((l) => l.text === marker)).toBe(false);
      const ctrl = new AbortController();
      const provider = abortAt(fakeJudge(ids, () => ({ discovery: 3 })), ctrl, (r) => r.messages.some((m) => m.content.includes(marker)));
      const out = await runJudge(judgeOf(provider), [first, second], scenario, rubrics, cfg, { repeat: 1, allCriteria: true, signal: ctrl.signal });
      expect(out.map((o) => o.probeId)).toEqual(["disc-l1"]);
      expect(out[0]!.kind === "single" && out[0]!.runs).toEqual([3]);
    });
    it("drops the probe when the abort lands in repeat 2 of 2", async () => {
      const { scenario, rubrics, probes, ids } = await setup();
      const probe = probes.find((p) => p.id === "disc-l1")!;
      const n = await callsPerRun(probe);
      const ctrl = new AbortController();
      const provider = abortAt(fakeJudge(ids, () => ({ discovery: 3 })), ctrl, (_r, i) => i === n + 1);
      const out = await runJudge(judgeOf(provider), [probe], scenario, rubrics, cfg, { repeat: 2, allCriteria: true, signal: ctrl.signal });
      expect(out).toEqual([]);
    });
    it("drops the probe when the abort lands during the last call of the last repeat", async () => {
      const { scenario, rubrics, probes, ids } = await setup();
      const probe = probes.find((p) => p.id === "disc-l1")!;
      const n = await callsPerRun(probe);
      const ctrl = new AbortController();
      const provider = abortAt(fakeJudge(ids, () => ({ discovery: 3 })), ctrl, (_r, i) => i === 2 * n);
      const out = await runJudge(judgeOf(provider), [probe], scenario, rubrics, cfg, { repeat: 2, allCriteria: true, signal: ctrl.signal });
      expect(out).toEqual([]);
    });
  });
});

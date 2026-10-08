import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatRequest } from "@acr/adapters";
import { loadRubrics, loadScenario, type Rubric, type Scenario } from "@acr/script";
import { evaluateSession } from "../../evaluator/evaluate.js";
import { parseEvalConfig } from "../../evaluator/config.js";
import { loadProbes } from "../probe-load.js";
import { buildProbeEvents } from "../probe-events.js";
import { scoredRoles, type Probe } from "../probe-schema.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const parsed = parseEvalConfig({});
if (!parsed.ok) throw new Error("config");
const config = parsed;

async function setup(): Promise<{ scenario: Scenario; rubrics: Rubric[]; probes: Probe[] }> {
  const dir = path.join(REPO, "scenarios/friday-escalation");
  const scenario = await loadScenario(dir);
  const { rubrics } = await loadRubrics(dir, scenario);
  const loaded = await loadProbes(dir, scenario, rubrics);
  expect(loaded.errors).toEqual([]);
  // individual rubrics only: calibration never makes the group call
  return { scenario, rubrics: rubrics.filter((r) => r.scope === "individual"), probes: loaded.probes };
}

/** A scripted judge: scores the probe's criterion 1 and quotes either the role's own first line or an invented sentence. */
function judge(probe: Probe, rubrics: Rubric[], quoteOf: (role: string, ownFirstLine: string) => string) {
  const individual = rubrics.filter((r) => r.scope === "individual").flatMap((r) => r.criteria.map((c) => c.id));
  return {
    name: "scripted",
    async *stream(req: ChatRequest): AsyncIterable<string> {
      const role = /score only the participant with role id "(\w+)"/i.exec(req.system)?.[1];
      if (!role) throw new Error("only participant calls are expected");
      const text = req.messages.map((m) => m.content).join("\n");
      const line = new RegExp(`^#(\\d+) \\S+ ${role} \\(player\\): (.*)$`, "m").exec(text);
      if (!line) throw new Error(`no line of ${role} in the request`);
      const criteria = individual.map((id) =>
        id === probe.criterion
          ? { id, score: 1, rationale: "The participant's own first line.", confidence: "high", evidence: [{ seq: Number(line[1]), quote: quoteOf(role, line[2]!.slice(0, 60)) }] }
          : { id, score: null, rationale: "", confidence: "low", evidence: [] },
      );
      yield JSON.stringify({ criteria, strengths: [], development_points: [], next_actions: [] });
    },
  };
}

describe("Friday probes through the real evaluator", () => {
  it("every scored role gets an ok evaluation whose quote is verified and none dropped", async () => {
    const { scenario, rubrics, probes } = await setup();
    expect(probes.length).toBeGreaterThanOrEqual(8);
    for (const probe of probes) {
      const r = await evaluateSession({ events: buildProbeEvents(probe, scenario), scenario, rubrics, provider: judge(probe, rubrics, (role) => probe.transcript.find((l) => l.role === role)!.text.slice(0, 60)), config, nonce: "abc123" });
      expect(r.failures, probe.id).toEqual([]);
      for (const role of scoredRoles(probe)) {
        const p = r.participants.find((x) => x.roleId === role);
        expect(p?.status, `${probe.id}/${role}`).toBe("ok");
        const c = p!.criteria.find((x) => x.id === probe.criterion);
        expect(c?.evidence, `${probe.id}/${role}`).toHaveLength(1);
        expect(c?.droppedQuotes, `${probe.id}/${role}`).toBe(0);
      }
    }
  });

  it("drops a quote the judge invented", async () => {
    const { scenario, rubrics, probes } = await setup();
    const probe = probes.find((p) => p.id === "disc-l1")!;
    const r = await evaluateSession({
      events: buildProbeEvents(probe, scenario), scenario, rubrics, config, nonce: "abc123",
      provider: judge(probe, rubrics, () => "an invented sentence nobody ever said in this call"),
    });
    const c = r.participants.find((x) => x.roleId === "delivery_lead")!.criteria.find((x) => x.id === "discovery")!;
    expect(c.evidence).toHaveLength(0);
    expect(c.droppedQuotes).toBe(1);
    expect(c.flags.join(" ")).toMatch(/could not be verified/);
  });
});

import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario } from "@acr/script";
import { parseSessionLog } from "../../evaluator/log-reader.js";
import { buildTranscript, renderTranscript } from "../../evaluator/transcript.js";
import { buildProbeEvents, PROBE_T0 } from "../probe-events.js";
import type { Probe } from "../probe-schema.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const probe: Probe = {
  kind: "single", id: "p1", criterion: "discovery", source: "handwritten", drafter: null, approved_by: null, approved_at: null, split: "tune",
  subject: "delivery_lead", expected: 1,
  transcript: [
    { scene: "s2_client_call", role: "client_sponsor", text: "Can you confirm by Friday?" },
    { scene: "s2_client_call", role: "delivery_lead", text: "Yes, we can do that." },
    { scene: "s2_client_call", role: "delivery_lead", text: "Consider it done." },
    { scene: "s3_internal_wrap", role: "tech_lead", text: "Okay, wrapping up." },
  ],
};

describe("buildProbeEvents", () => {
  it("builds a log the real evaluator reader and transcript accept, with scenes and an end", async () => {
    const scenario = await loadScenario(path.join(REPO, "scenarios/friday-escalation"));
    const events = buildProbeEvents(probe, scenario);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events[0]!.type).toBe("session.started");
    expect(events.at(-1)!.type).toBe("session.ended");
    expect(events.filter((e) => e.type === "scene.entered")).toHaveLength(2);
    // round-trips through the production reader
    const text = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    expect(parseSessionLog(text)).toHaveLength(events.length);
    const t = buildTranscript(events, scenario);
    expect(t.counts["delivery_lead"]).toBe(2);
    expect(renderTranscript(t, 60_000).text).toContain("Consider it done.");
    expect(t.complete).toBe(true);
  });
  it("uses only the roles that speak in each scene as participants", async () => {
    const scenario = await loadScenario(path.join(REPO, "scenarios/friday-escalation"));
    const entered = buildProbeEvents(probe, scenario).filter((e) => e.type === "scene.entered");
    expect((entered[0] as { participants: string[] }).participants.sort()).toEqual(["client_sponsor", "delivery_lead"]);
  });
  it("places scene.exited after the last utterance of each scene and at the end, before session.ended", async () => {
    const scenario = await loadScenario(path.join(REPO, "scenarios/friday-escalation"));
    const events = buildProbeEvents(probe, scenario);
    expect(events.map((e) => e.type)).toEqual([
      "session.started", "scene.entered", "utterance", "utterance", "utterance",
      "scene.exited", "scene.entered", "utterance", "scene.exited", "session.ended",
    ]);
    const exits = events.filter((e) => e.type === "scene.exited") as { sceneId: string }[];
    expect(exits.map((e) => e.sceneId)).toEqual(["s2_client_call", "s3_internal_wrap"]);
  });
  it("emits two scene.entered events when a scene appears twice non-consecutively", async () => {
    const scenario = await loadScenario(path.join(REPO, "scenarios/friday-escalation"));
    const again: Probe = {
      ...probe,
      transcript: [
        ...probe.transcript,
        { scene: "s2_client_call", role: "delivery_lead", text: "One more thing." },
      ],
    };
    const events = buildProbeEvents(again, scenario);
    const entered = events.filter((e) => e.type === "scene.entered") as { sceneId: string }[];
    expect(entered.map((e) => e.sceneId)).toEqual(["s2_client_call", "s3_internal_wrap", "s2_client_call"]);
    expect(events.filter((e) => e.type === "scene.exited")).toHaveLength(3);
  });
  it("steps each event 10 seconds after the previous and uses the probe session id", async () => {
    const scenario = await loadScenario(path.join(REPO, "scenarios/friday-escalation"));
    const events = buildProbeEvents(probe, scenario);
    expect(events[0]!.ts).toBe(PROBE_T0);
    events.forEach((e, i) => {
      expect(e.ts).toBe(PROBE_T0 + i * 10_000);
      expect(e.sessionId).toBe("probe-p1");
    });
  });
});

import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadScenario } from "@acr/script";
import type { SessionEvent } from "@acr/events";
import { REPO_ROOT } from "../../main.js";
import { CHECKS, CHECK_IDS, CheckFailure, Recorder, UNSAFE_CHARS, buildMarkers, def, ensure, findInjectLeaks, findMarkers, logShapeProblems, missingMarkers, sceneTrace, skipReason } from "../checks.js";

const rec = (kind: "mock" | "live" | "url", over: Partial<ConstructorParameters<typeof Recorder>[0]> = {}) => new Recorder({ kind, now: () => 0, ...over });

describe("the check catalogue", () => {
  it("has unique ids F-01..F-29 in order, each with a title", () => {
    expect(CHECK_IDS).toEqual(Array.from({ length: 29 }, (_, i) => `F-${String(i + 1).padStart(2, "0")}`));
    expect(CHECKS.every((c) => c.title.length > 10)).toBe(true);
    expect(() => def("F-99")).toThrow(/unknown check/);
  });
  it("skips scripted checks in live mode and everything but the external subset with --url", () => {
    expect(skipReason(def("F-12"), "live")).toBe("skipped (live mode)");
    expect(skipReason(def("F-12"), "url")).toBe("skipped (needs in-process server)");
    expect(skipReason(def("F-24"), "live")).toBeNull();
    expect(skipReason(def("F-24"), "url")).toBe("skipped (needs in-process server)");
    expect(skipReason(def("F-01"), "url")).toBeNull();
    expect(skipReason(def("F-12"), "mock")).toBeNull();
  });
});

describe("the pinned mode-skip sets", () => {
  it("lists literally which checks are skipped in --url and in --live mode (re-kinding a check must be a conscious change)", () => {
    const skipped = (kind: "live" | "url") => CHECKS.filter((c) => skipReason(c, kind) !== null).map((c) => c.id);
    expect(skipped("url")).toEqual(["F-07", "F-10", "F-11", "F-12", "F-13", "F-14", "F-19", "F-23", "F-24", "F-26", "F-28", "F-29"]);
    expect(skipped("live")).toEqual(["F-07", "F-12", "F-13", "F-19"]);
    expect(CHECKS.filter((c) => skipReason(c, "mock") !== null)).toEqual([]);
  });
});

describe("Recorder", () => {
  it("records pass, fail (CheckFailure text) and error (other throws), and continues", async () => {
    const r = rec("mock");
    expect(await r.run("F-01", () => "fine")).toBe(true);
    expect(await r.run("F-02", () => { ensure(false, "evidence of failure"); return ""; })).toBe(false);
    expect(await r.run("F-03", () => { throw new Error("socket exploded"); })).toBe(false);
    const out = r.ordered();
    expect(out.find((x) => x.id === "F-01")).toMatchObject({ status: "passed", details: "fine" });
    expect(out.find((x) => x.id === "F-02")).toMatchObject({ status: "failed", details: "evidence of failure" });
    expect(out.find((x) => x.id === "F-03")).toMatchObject({ status: "failed", details: "error: socket exploded" });
  });
  it("skips a check whose prerequisite did not pass, never hiding it", async () => {
    const r = rec("mock");
    await r.run("F-01", () => { throw new CheckFailure("no"); });
    let ran = false;
    expect(await r.run("F-04", () => { ran = true; return "x"; }, ["F-01"])).toBe(false);
    expect(ran).toBe(false);
    // Mock mode must run every check: a dependent that cannot run is a failure, never a quiet skip.
    expect(r.ordered().find((x) => x.id === "F-04")).toMatchObject({ status: "failed", details: "did not run (prerequisite failed: F-01)" });
    const live = rec("live");
    await live.run("F-01", () => { throw new CheckFailure("no"); });
    await live.run("F-04", () => "x", ["F-01"]);
    expect(live.ordered().find((x) => x.id === "F-04")).toMatchObject({ status: "failed", details: "did not run (prerequisite failed: F-01)" });
    expect(live.ordered().find((x) => x.id === "F-12")).toMatchObject({ status: "skipped", details: "skipped (live mode)" }); // the intended mode skip stays
  });
  it("leaves a bypassed check unrecorded, so finish() reports it", async () => {
    const r = rec("mock", { bypass: new Set(["F-05"]) });
    expect(await r.run("F-05", () => "x")).toBe(false);
    expect(r.status("F-05")).toBeUndefined();
    r.finish("prerequisite failed");
    expect(r.ordered().find((x) => x.id === "F-05")).toMatchObject({ status: "failed", details: "did not run (prerequisite failed)" });
  });
  it("pre-skips inapplicable checks and never runs their body", async () => {
    const r = rec("url");
    let ran = false;
    expect(await r.run("F-24", () => { ran = true; return "x"; })).toBe(false);
    expect(ran).toBe(false);
    expect(r.status("F-24")).toBe("skipped");
    expect(r.applicable("F-24")).toBe(false);
    expect(r.applicable("F-01")).toBe(true);
  });
  it("forces a failure after running the body, and tells the caller via onResult", async () => {
    const seen: string[] = [];
    const r = rec("mock", { forceFail: new Set(["F-05"]), onResult: (x) => seen.push(`${x.id}:${x.status}`) });
    expect(await r.run("F-05", () => "would pass")).toBe(false);
    expect(r.ordered().find((x) => x.id === "F-05")).toMatchObject({ status: "failed", details: "forced failure (test hook)" });
    expect(seen).toContain("F-05:failed");
  });
  it("rethrows when the run was aborted, so the caller can stop", async () => {
    let aborted = false;
    const r = rec("mock", { aborted: () => aborted });
    aborted = true;
    await expect(r.run("F-01", () => { throw new Error("run aborted"); })).rejects.toThrow("run aborted");
  });
  it("finish() records every unrun check with the reason (failed in every mode; only mode skips are skipped), in catalogue order", async () => {
    const m = rec("mock");
    m.finish("run aborted");
    expect(m.ordered().every((x) => x.status === "failed" && x.details === "did not run (run aborted)")).toBe(true);
    const r = rec("live");
    await r.run("F-02", () => "ok");
    r.finish("run aborted");
    expect(r.ordered().find((x) => x.id === "F-01")).toMatchObject({ status: "failed", details: "did not run (run aborted)" });
    const out = r.ordered();
    expect(out.map((x) => x.id)).toEqual([...CHECK_IDS]);
    expect(out.find((x) => x.id === "F-02")?.status).toBe("passed");
  });
});

describe("markers", () => {
  it("are derived from the shipped scenario, all really exist in it, and cover each secret class", async () => {
    const scenario = await loadScenario(path.join(REPO_ROOT, "scenarios", "friday-escalation"));
    const m = buildMarkers(scenario);
    expect(missingMarkers(scenario, m)).toEqual([]);
    expect(Object.keys(m.secretsByRole).sort()).toEqual(["account_manager", "delivery_lead", "tech_lead"]);
    expect(m.secretsByRole.delivery_lead!.join("|")).toContain("6 person-weeks");
    expect(m.rubric).toContain("individual_delivery_v2");
    expect(m.hidden.join("|")).toContain("phased delivery after go-live if the risk");
    expect(m.npcInternals.length).toBeGreaterThan(3);
  });
  it("missingMarkers reports a marker that is not in the scenario (so a stale marker cannot make an audit vacuous)", async () => {
    const scenario = await loadScenario(path.join(REPO_ROOT, "scenarios", "friday-escalation"));
    const m = buildMarkers(scenario);
    m.rubric.push("THIS-TEXT-IS-NOT-IN-THE-SCENARIO");
    expect(missingMarkers(scenario, m)).toEqual(["THIS-TEXT-IS-NOT-IN-THE-SCENARIO"]);
  });
  it("findMarkers returns de-duplicated, shortened hits and ignores empty markers", () => {
    expect(findMarkers("a SECRET b SECRET", ["SECRET", "SECRET", "", "nope"])).toEqual(["SECRET"]);
    expect(findMarkers("x".repeat(100), ["x".repeat(60)])[0]!.endsWith("…")).toBe(true);
  });
});

describe("log helpers", () => {
  const ev = (seq: number, over: Partial<SessionEvent> = {}): SessionEvent => ({ type: "facilitator.alert", level: "info", message: "m", seq, ts: seq, sessionId: "s", ...over } as SessionEvent);
  it("accepts a clean log and names the problems in a broken one", () => {
    expect(logShapeProblems([ev(1), ev(2), ev(3)], "s")).toEqual([]);
    expect(logShapeProblems([ev(1), ev(3)], "s")).toEqual(["event 2 has seq 3"]);
    expect(logShapeProblems([ev(1), ev(2, { sessionId: "other" })], "s")).toEqual(["event 2 has a different sessionId"]);
    expect(logShapeProblems([ev(1), ev(2, { ts: undefined as unknown as number })], "s")).toEqual(["event 2 has no numeric ts"]);
    expect(logShapeProblems([ev(1, { ts: 9 }), ev(2, { ts: 3 })], "s")).toEqual(["event 2 goes back in time"]);
  });
  it("sceneTrace keeps only scene boundaries and the end", () => {
    const events = [
      ev(1, { type: "scene.entered", sceneId: "a", participants: [] } as Partial<SessionEvent>),
      ev(2), ev(3, { type: "scene.exited", sceneId: "a", reason: "gm_detects" } as Partial<SessionEvent>),
      ev(4, { type: "session.ended", reason: "script_complete" } as Partial<SessionEvent>),
    ];
    expect(sceneTrace(events)).toEqual(["entered:a", "exited:a:gm_detects", "ended:script_complete"]);
  });
  it("findInjectLeaks matches multi-line inject content in its JSON-escaped form and can fail (positive control)", () => {
    const scenes = [{ id: "s", title: "t", goal: "g", participants: ["a", "b"], time_box_minutes: 1, exit_when: { any_of: ["time_box_elapsed"] },
      injects: [{ id: "private", to: ["a"], content: "line one\nline two \"quoted\"" }, { id: "public", to: ["a", "b"], content: "everyone\nsees" }] }] as unknown as Parameters<typeof findInjectLeaks>[2];
    const inboxWithLeak = JSON.stringify([{ type: "event", event: { type: "inject.fired", content: "line one\nline two \"quoted\"" } }]);
    expect(findInjectLeaks(inboxWithLeak, "b", scenes)).toEqual(["private"]); // the old raw-string comparison could never match this
    expect(findInjectLeaks(inboxWithLeak, "a", scenes)).toEqual([]);
    expect(findInjectLeaks(JSON.stringify([{ content: "everyone\nsees" }]), "b", scenes)).toEqual([]);
  });
  it("UNSAFE_CHARS matches control, C1 and bidi characters only", () => {
    for (const c of ["\u001b", "\u0007", "\n", "\u0085", "‮", "⁦"]) expect(UNSAFE_CHARS.test(c)).toBe(true);
    expect(UNSAFE_CHARS.test("plain ✓ text · ⏎")).toBe(false);
  });
});

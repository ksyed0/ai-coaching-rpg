import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { initialState, reduce, type SessionEvent } from "@acr/events";
import { loadScenario } from "@acr/script";
import { FakeClock } from "../clock.js";
import { JsonlEventLog, MemoryEventLog } from "../event-log.js";
import { SessionEngine } from "../session-engine.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
const dirs: string[] = [];
const logs: JsonlEventLog[] = [];
afterEach(async () => { for (const l of logs.splice(0)) await l.close().catch(() => undefined); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const tmp = async (): Promise<string> => { const d = await mkdtemp(path.join(os.tmpdir(), "acr-endnow-")); dirs.push(d); return d; };
const fold = (e: SessionEvent[]) => e.reduce((s, x) => reduce(s, x), initialState());
const types = (e: SessionEvent[]): string[] => e.map((x) => x.type);

async function started() {
  const scenario = await loadScenario(fixture);
  const dir = await tmp();
  const log = new JsonlEventLog("x", dir, { sync: false });
  logs.push(log);
  const clock = new FakeClock(1_000_000);
  const engine = new SessionEngine({ scenario, log, clock });
  await engine.start({});
  return { scenario, dir, log, clock, engine };
}
const fileEvents = async (dir: string): Promise<SessionEvent[]> => (await readFile(path.join(dir, "x.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as SessionEvent);

describe("SessionEngine.endNow (US-0059)", () => {
  it("endNow appends scene.exited, the alert, then session.ended last", async () => {
    const { engine, log } = await started();
    await engine.endNow({ actor: "Dana", message: "Thanks all" });
    const all = await log.all();
    expect(types(all).slice(-3)).toEqual(["scene.exited", "facilitator.alert", "session.ended"]);
    const [exited, alert, ended] = all.slice(-3) as [Extract<SessionEvent, { type: "scene.exited" }>, Extract<SessionEvent, { type: "facilitator.alert" }>, Extract<SessionEvent, { type: "session.ended" }>];
    expect(exited.reason).toBe("facilitator_end");
    expect(alert.message).toContain("Dana");
    expect(ended).toMatchObject({ reason: "facilitator_end", message: "Thanks all" });
    expect(engine.state.status).toBe("ended");
    expect(engine.state.currentScene).toBeNull();
  });

  it("without a message session.ended has no message key", async () => {
    const { engine, log } = await started();
    await engine.endNow({ actor: "Dana" });
    const ended = (await log.all()).at(-1)!;
    expect(ended.type).toBe("session.ended");
    expect(Object.hasOwn(ended, "message")).toBe(false);
  });

  it("refused before the start (not_started), during an interrupted opening (starting) and after the end (ended); each refusal appends nothing", async () => {
    const scenario = await loadScenario(fixture);
    const log = new MemoryEventLog("s");
    const idle = new SessionEngine({ scenario, log, clock: new FakeClock(0) });
    await expect(idle.endNow({ actor: "D" })).rejects.toMatchObject({ code: "not_started" });
    expect(await log.all()).toHaveLength(0);

    const log2 = new MemoryEventLog("s2");
    const real = log2.append.bind(log2);
    let n = 0;
    log2.append = (body, ts) => { n++; return n === 2 ? Promise.reject(Object.assign(new Error("closed"), { code: "closed" })) : real(body, ts); };
    const opening = new SessionEngine({ scenario, log: log2, clock: new FakeClock(0) });
    await expect(opening.start({})).rejects.toMatchObject({ code: "closed" });
    expect(opening.startIncomplete).toBe(true);
    await expect(opening.endNow({ actor: "D" })).rejects.toMatchObject({ code: "starting" });
    expect(await log2.all()).toHaveLength(1);

    const { engine, log: log3 } = await started();
    await engine.endNow({ actor: "D" });
    const count = (await log3.all()).length;
    await expect(engine.endNow({ actor: "D" })).rejects.toMatchObject({ code: "ended" });
    expect(await log3.all()).toHaveLength(count);
  });

  it("two endNow calls in flight give one session.ended; the second rejects with ended", async () => {
    const { engine, log } = await started();
    const a = engine.endNow({ actor: "A" });
    const b = engine.endNow({ actor: "B" });
    await a;
    await expect(b).rejects.toMatchObject({ code: "ended" });
    expect(types(await log.all()).filter((t) => t === "session.ended")).toHaveLength(1);
  });

  it("say, recordGmVerdict, recordGmNoVerdict, recordFactEarned, alert and tick queued behind endNow append nothing after session.ended", async () => {
    const { engine, log, clock } = await started();
    const sceneId = engine.state.currentScene!.id;
    const roleId = engine.currentScene()!.participants[0]!;
    const end = engine.endNow({ actor: "A" });
    clock.advance(10 * 60_000);
    const queued = [
      engine.say(roleId, "late", "text").catch(() => "refused"),
      engine.recordGmVerdict("c", true, "r", { expectSceneId: sceneId }),
      engine.recordGmNoVerdict("c", "empty", 1),
      engine.recordFactEarned(roleId, 1, "r"),
      engine.alert("late"),
      engine.tick(),
    ];
    await end;
    await Promise.all(queued);
    const all = await log.all();
    expect(all.at(-1)!.type).toBe("session.ended");
    expect(types(all).filter((t) => t === "session.ended")).toHaveLength(1);
  });
});

describe("endNow restore repair (US-0059)", () => {
  async function cutAfter(keep: (e: SessionEvent) => boolean) {
    const { scenario, dir, log, engine } = await started();
    await engine.endNow({ actor: "Dana", message: "Bye" });
    await log.close();
    const lines = (await readFile(path.join(dir, "x.jsonl"), "utf8")).split("\n").filter(Boolean);
    const kept: string[] = [];
    for (const l of lines) { if (!keep(JSON.parse(l) as SessionEvent)) break; kept.push(l); }
    await writeFile(path.join(dir, "x.jsonl"), kept.join("\n") + "\n");
    return { scenario, dir };
  }
  const restoreOn = (scenario: Awaited<ReturnType<typeof started>>["scenario"], dir: string) => {
    const log = new JsonlEventLog("x", dir, { sync: false });
    logs.push(log);
    return { log, engine: new SessionEngine({ scenario, log, clock: new FakeClock(2_000_000) }) };
  };

  for (const [label, lastKept] of [["scene.exited", "scene.exited"], ["the alert", "facilitator.alert"]] as const) {
    it(`a cut after ${label} restores as running with repair end_session/facilitator_end; markResumed ends it with no message and the live state equals the fold of the file`, async () => {
      const { scenario, dir } = await cutAfter((e) => {
        if (e.type === "session.ended") return false;
        if (lastKept === "scene.exited" && e.type === "facilitator.alert" && e.message.includes("ended now")) return false;
        return true;
      });
      const { engine } = restoreOn(scenario, dir);
      const out = await engine.restore();
      expect(out.kind).toBe("running");
      if (out.kind !== "running") return;
      expect(out.info.repairs).toEqual([{ kind: "end_session", reason: "facilitator_end" }]);
      const notes = await engine.markResumed(out.info);
      expect(notes.repairs[0]).toMatch(/closing message .* lost/);
      const all = await fileEvents(dir);
      const ended = all.at(-1)!;
      expect(ended).toMatchObject({ type: "session.ended", reason: "facilitator_end" });
      expect(Object.hasOwn(ended, "message")).toBe(false);
      const lostAlert = all.filter((e) => e.type === "facilitator.alert").at(-1) as Extract<SessionEvent, { type: "facilitator.alert" }>;
      expect(lostAlert.message).toContain("The facilitator had ended the session, so it ends now");
      expect(lostAlert.message).toContain("closing message to participants was lost");
      expect(engine.state).toEqual(fold(all));
    });
  }

  it("a cut before scene.exited restores the scene (nothing was ended)", async () => {
    const { scenario, dir } = await cutAfter((e) => e.type !== "scene.exited");
    const out = await restoreOn(scenario, dir).engine.restore();
    expect(out.kind).toBe("running");
    if (out.kind === "running") { expect(out.info.sceneId).not.toBeNull(); expect(out.info.repairs).toEqual([]); }
  });

  it("a complete facilitator_end log restores as ended", async () => {
    const { scenario, dir } = await cutAfter(() => true);
    const out = await restoreOn(scenario, dir).engine.restore();
    expect(out.kind).toBe("ended");
  });
});

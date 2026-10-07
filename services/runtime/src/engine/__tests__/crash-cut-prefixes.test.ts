import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { initialState, reduce, type SessionEvent, type SessionState } from "@acr/events";
import { loadScenario, type Scenario } from "@acr/script";
import { FakeClock } from "../clock.js";
import { JsonlEventLog } from "../event-log.js";
import { SessionEngine } from "../session-engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.join(here, "../../../../../scenarios/friday-escalation-extended");
const T0 = 1_000_000;
const MIN = 60_000;

const evs = async (f: string): Promise<SessionEvent[]> => (await readFile(f, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as SessionEvent);
const fold = (e: SessionEvent[]): SessionState => e.reduce((s, x) => reduce(s, x), initialState());

async function loadSc(): Promise<Scenario> {
  const sc = await loadScenario(ext);
  // make one timed inject address TWO AI characters (multi-step effect) and a player
  const s2 = sc.script.scenes[1]!;
  const inj = s2.injects!.find((i) => i.id === "cfo_ping")!;
  inj.to = ["client_sponsor", "delivery_lead", "cfo"];
  inj.effect = { goals_add: ["G-cfo-ping"], knowledge_add: ["K-cfo-ping"] };
  return sc;
}

async function drive(engine: SessionEngine, clock: FakeClock, sc: Scenario): Promise<void> {
  await engine.start({ delivery_lead: "p1" });
  let seen = "";
  for (let guard = 0; guard < 400 && engine.state.status === "running"; guard++) {
    const cur = engine.currentScene();
    if (cur && cur.id !== seen) {
      seen = cur.id;
      const idx = sc.script.scenes.findIndex((s) => s.id === cur.id);
      for (const p of cur.participants) await engine.say(p, `${p} in ${cur.id}`);
      await engine.alert("hello", "info");
      await engine.recordGmNoVerdict("c", "empty", 1);
      await engine.recordGmVerdict("c", false, "r");
      if (idx === 0) { await engine.command({ command: "fire_inject", injectId: "burn_report" }); await engine.command({ command: "set_npc_stance", roleId: "client_sponsor", goals: ["stance"] }); }
      if (idx === 1) {
        await engine.command({ command: "pause" }); clock.advance(2 * MIN); await engine.command({ command: "resume" });
        await engine.command({ command: "release_hidden", roleId: "client_sponsor", fact: 1 });
        await engine.command({ command: "whisper", roleId: "delivery_lead", text: "w" });
      }
      if (idx === 2) await engine.command({ command: "advance" });
    }
    clock.advance(MIN);
    await engine.tick();
  }
}

/** Invariants of a complete log (session ended). Returns problems. */
function check(all: SessionEvent[], sc: Scenario): string[] {
  const probs: string[] = [];
  const entered = all.filter((e) => e.type === "scene.entered").map((e) => (e as { sceneId: string }).sceneId);
  const want = sc.script.scenes.map((s) => s.id);
  if (JSON.stringify(entered) !== JSON.stringify(want)) probs.push(`scenes entered ${JSON.stringify(entered)}`);
  const inj = all.filter((e) => e.type === "inject.fired").map((e) => (e as { injectId: string }).injectId);
  if (new Set(inj).size !== inj.length) probs.push(`duplicate inject ${JSON.stringify(inj)}`);
  for (const s of sc.script.scenes) if (s.opening_inject && !inj.includes(s.opening_inject)) probs.push(`opening ${s.opening_inject} never fired`);
  const st = fold(all);
  if (st.status !== "ended") probs.push(`not ended: ${st.status}`);
  // every inject's effect reached each NPC it addresses
  for (const e of all) {
    if (e.type !== "inject.fired") continue;
    const scene = sc.script.scenes.find((s) => s.id === e.sceneId)!;
    const inject = scene.injects!.find((i) => i.id === e.injectId)!;
    for (const r of e.to) {
      if (sc.roles[r]?.type !== "npc") continue;
      for (const g of inject.effect?.goals_add ?? []) if (!st.npcs[r]?.goals.includes(g)) probs.push(`inject ${e.injectId} effect missing on ${r}`);
    }
  }
  for (const [id, r] of Object.entries(sc.roles)) if (r.type === "npc" && !st.npcs[id]) probs.push(`npc ${id} never initialised`);
  // nothing (but a final session.ended) between scene.exited and the next scene.entered other than resume bookkeeping
  return probs;
}

async function restartAndFinish(dir: string, sc: Scenario, at: number): Promise<{ probs: string[]; afterMark: number; repairs: string[] }> {
  const log = new JsonlEventLog("x", dir, { sync: false });
  const clock = new FakeClock(at);
  const eng = new SessionEngine({ scenario: sc, log, clock });
  const out = await eng.restore();
  const probs: string[] = [];
  let repairs: string[] = [];
  if (out.kind !== "running") return { probs: [`restore gave ${out.kind}`], afterMark: 0, repairs };
  const notes = await eng.markResumed(out.info);
  repairs = notes.repairs;
  const file = path.join(dir, "x.jsonl");
  const afterMark = (await evs(file)).length;
  try { expect(eng.state).toEqual(fold(await evs(file))); } catch { probs.push("live state != fold(file) after markResumed"); }
  if (eng.state.status === "running" && !eng.state.currentScene) probs.push("running with no scene after markResumed");
  if (eng.state.status === "running") {
    await eng.command({ command: "resume" }).catch((e) => probs.push(`resume failed ${(e as Error).message}`));
    for (let i = 0; i < 400 && eng.state.status === "running"; i++) { clock.advance(MIN); await eng.tick(); }
  }
  await log.close();
  probs.push(...check(await evs(file), sc));
  return { probs, afterMark, repairs };
}

/**
 * US-0018 review I-A: a crash may cut the log after ANY event, including in the middle of the resume's own completion. For every prefix
 * of a full session (every boundary) and every cut inside the completion that the first restart writes, a restart must rebuild the live
 * state from the file, have a scene, enter every scene exactly once in order, fire no inject twice, deliver every inject's effect to every
 * AI character it addresses, end the session, and leave nothing for a second restart to complete. (Ported from the reviewer's probe.)
 */
describe("exhaustive crash-cut prefixes", () => {
  it("every prefix of a full session resumes and completes; and every cut inside the resume completion too", async () => {
    const sc = await loadSc();
    const base = await mkdtemp(path.join(os.tmpdir(), "acr-prefix-"));
    try {
      const d0 = path.join(base, "full");
      await mkdir(d0);
      const log = new JsonlEventLog("x", d0, { sync: false });
      const clock = new FakeClock(T0);
      const eng = new SessionEngine({ scenario: sc, log, clock });
      await drive(eng, clock, sc);
      await log.close();
      const full = (await readFile(path.join(d0, "x.jsonl"), "utf8")).split("\n").filter(Boolean);
      expect(check(full.map((l) => JSON.parse(l) as SessionEvent), sc)).toEqual([]);
      const failures: string[] = [];
      const nested: string[] = [];
      let n = 0;
      for (let k = 1; k < full.length; k++) {
        const d = path.join(base, `k${k}`);
        await mkdir(d);
        await writeFile(path.join(d, "x.jsonl"), full.slice(0, k).join("\n") + "\n");
        // first restart; but also capture the post-markResumed log for nested cuts
        const dm = path.join(base, `m${k}`);
        await mkdir(dm);
        await writeFile(path.join(dm, "x.jsonl"), full.slice(0, k).join("\n") + "\n");
        {
          const l2 = new JsonlEventLog("x", dm, { sync: false });
          const e2 = new SessionEngine({ scenario: sc, log: l2, clock: new FakeClock(T0 + 10 * 3_600_000) });
          const o = await e2.restore();
          if (o.kind === "running") await e2.markResumed(o.info);
          await l2.close();
          // idempotency: a second restart on the completed log finds nothing to complete
          const l3 = new JsonlEventLog("x", dm, { sync: false });
          const e3 = new SessionEngine({ scenario: sc, log: l3, clock: new FakeClock(T0 + 11 * 3_600_000) });
          const o3 = await e3.restore();
          if (o3.kind === "running" && o3.info.repairs.length) failures.push(`k=${k}: second restart repairs ${JSON.stringify(o3.info.repairs)}`);
        }
        const r = await restartAndFinish(d, sc, T0 + 10 * 3_600_000);
        n++;
        const last = JSON.parse(full[k - 1]!) as SessionEvent;
        if (r.probs.length) failures.push(`k=${k} (last ${last.type}): ${r.probs.join("; ")}`);
        // nested: crash in the middle of the resume completion
        const mid = (await readFile(path.join(dm, "x.jsonl"), "utf8")).split("\n").filter(Boolean);
        for (let j = k + 1; j < mid.length; j++) {
          const dj = path.join(base, `k${k}j${j}`);
          await mkdir(dj);
          await writeFile(path.join(dj, "x.jsonl"), mid.slice(0, j).join("\n") + "\n");
          const rj = await restartAndFinish(dj, sc, T0 + 20 * 3_600_000);
          if (rj.probs.length) nested.push(`k=${k} (last ${last.type}) j=${j} (last ${(JSON.parse(mid[j - 1]!) as SessionEvent).type}): ${rj.probs.join("; ")}`);
        }
      }
      expect(n).toBe(full.length - 1);
      expect(failures).toEqual([]);
      expect(nested).toEqual([]);
    } finally { await rm(base, { recursive: true, force: true }); }
  }, 120_000);
});

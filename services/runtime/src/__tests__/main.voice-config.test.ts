import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bootstrap, type Runtime } from "../main.js";
import type { ChildMessage, ParentChannel } from "../host/parent-channel.js";
import { VOICE_NEEDS_MANAGED, VOICE_NEEDS_NOTICE_V3 } from "../host/voice-config.js";

// US-0070: the runtime's VOICE_ENABLED start refusals and the `ready.voice` field.
const here = path.dirname(fileURLToPath(import.meta.url));
const friday = path.join(here, "../../../../scenarios/friday-escalation");
const consentDir = path.join(here, "../../../../consent"); // holds notice-v1.md, notice-v2.md and the draft notice-v3.md
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
let parentTmp = "";
let savedTmp: string | undefined;
let tmp = "";
const runtimes: Runtime[] = [];
beforeAll(async () => { savedTmp = process.env.TMPDIR; parentTmp = await mkdtemp(path.join(os.tmpdir(), "acr-voicecfg-")); process.env.TMPDIR = parentTmp; });
afterAll(async () => { if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp; await rm(parentTmp, { recursive: true, force: true }); });
afterEach(async () => { for (const r of runtimes.splice(0)) await r.stop(); if (tmp) await rm(tmp, { recursive: true, force: true }); tmp = ""; });

function fakeParent() {
  const sent: ChildMessage[] = [];
  const parent: ParentChannel = { send(m) { sent.push(m); return true; }, onMessage() {}, onDisconnect() {} };
  return { parent, sent };
}
async function boot(env: NodeJS.ProcessEnv, parent: ParentChannel | null) {
  tmp = await mkdtemp(path.join(parentTmp, "run-"));
  const data = path.join(tmp, "sessions");
  const r = await bootstrap({
    env: { SCENARIO_DIR: friday, RUNTIME_PORT: "0", RUNTIME_HOST: "127.0.0.1", SESSION_ID: "v1", MODEL_PROVIDER: "mock", SESSION_DATA_DIR: data, ...env },
    root: tmp, consentDir, tickMs: 60_000, log: () => {}, warn: () => {}, parent,
  });
  if (r.ok) runtimes.push(r.runtime);
  return { r, data };
}
const filesIn = async (dir: string) => { try { return await readdir(dir); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; throw err; } };

describe("bootstrap and VOICE_ENABLED (US-0070)", () => {
  it("VOICE_ENABLED=1 without CONTROL_MANAGED refuses to start and opens no log", async () => {
    const { r, data } = await boot({ VOICE_ENABLED: "1", CONSENT_NOTICE_VERSION: "v3" }, null);
    expect(r).toEqual({ ok: false, errors: [VOICE_NEEDS_MANAGED] });
    expect(await filesIn(data)).toEqual([]);
  });

  it("VOICE_ENABLED=1 with CONTROL_MANAGED=1 and notice v2 refuses to start and opens no log", async () => {
    const { parent, sent } = fakeParent();
    const { r, data } = await boot({ VOICE_ENABLED: "1", CONTROL_MANAGED: "1", CONSENT_NOTICE_VERSION: "v2" }, parent);
    expect(r).toEqual({ ok: false, errors: [VOICE_NEEDS_NOTICE_V3] });
    expect(await filesIn(data)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("a bad TURN_END_MS refuses to start", async () => {
    const { parent } = fakeParent();
    const { r } = await boot({ VOICE_ENABLED: "1", CONTROL_MANAGED: "1", CONSENT_NOTICE_VERSION: "v3", TURN_END_MS: "5" }, parent);
    expect(r.ok).toBe(false);
  });

  it("F6: a text-only managed session starts whatever TURN_END_MS says (it is read only with VOICE_ENABLED=1)", async () => {
    const { parent, sent } = fakeParent();
    const { r } = await boot({ CONTROL_MANAGED: "1", CONSENT_NOTICE_VERSION: "v2", TURN_END_MS: "not-a-number" }, parent);
    expect(r.ok).toBe(true);
    expect((sent.find((m) => m.type === "ready") as Extract<ChildMessage, { type: "ready" }>).voice).toBeUndefined();
  });

  it("with notice v3 it starts and ready carries voice: true", async () => {
    const { parent, sent } = fakeParent();
    const { r } = await boot({ VOICE_ENABLED: "1", CONTROL_MANAGED: "1", CONSENT_NOTICE_VERSION: "v3" }, parent);
    expect(r.ok).toBe(true);
    const ready = sent.find((m) => m.type === "ready") as Extract<ChildMessage, { type: "ready" }>;
    expect(ready.voice).toBe(true);
    if (r.ok) expect(r.runtime.host.voiceEnabled).toBe(true);
  });

  it("ready is followed by voice_seats, and a seat change sends voice_seats again (coalesced); a saved choice sends voice_choice", async () => {
    const { parent, sent } = fakeParent();
    const { r } = await boot({ VOICE_ENABLED: "1", CONTROL_MANAGED: "1", CONSENT_NOTICE_VERSION: "v3" }, parent);
    if (!r.ok) throw new Error(r.errors.join("; "));
    const types = sent.map((m) => m.type);
    expect(types.indexOf("voice_seats")).toBe(types.indexOf("ready") + 1);
    expect(sent.find((m) => m.type === "voice_seats")).toEqual({ type: "voice_seats", paused: false, ended: false, holders: [], open: ["account_manager", "delivery_lead", "tech_lead"] });
    const host = r.runtime.host;
    host.join("tech_lead", "p1");
    host.giveConsent("tech_lead", "p1", "v3");
    host.optInVoice("tech_lead", "p1", "v3");
    await Promise.resolve();
    const seats = sent.filter((m) => m.type === "voice_seats");
    expect(seats).toHaveLength(2);
    // US-0071 (R8): an opt-in in the lobby is reported, but nothing records before the start.
    expect(seats[1]).toEqual({ type: "voice_seats", paused: false, ended: false, holders: [{ roleId: "tech_lead", participantId: "p1", recording: false, voiceChosen: true }], open: ["account_manager", "delivery_lead"] });
    expect(sent.filter((m) => m.type === "voice_choice")).toEqual([{ type: "voice_choice", roleId: "tech_lead", participantId: "p1", choice: "voice", at: expect.any(Number) }]);
  });

  it("VOICE_ENABLED unset: ready has no voice key", async () => {
    const { parent, sent } = fakeParent();
    const { r } = await boot({ CONTROL_MANAGED: "1", CONSENT_NOTICE_VERSION: "v3" }, parent);
    expect(r.ok).toBe(true);
    const ready = sent.find((m) => m.type === "ready")!;
    expect("voice" in ready).toBe(false);
    expect(sent.some((m) => m.type === "voice_seats" || m.type === "voice_choice")).toBe(false);
    if (r.ok) expect(r.runtime.host.voiceEnabled).toBe(false);
  });
});

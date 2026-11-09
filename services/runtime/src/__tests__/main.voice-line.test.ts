import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bootstrap, type Runtime } from "../main.js";
import type { ChildMessage, ParentChannel, ParentMessage } from "../host/parent-channel.js";

// US-0070 (Task 6): the parent channel's voice_line is answered exactly once, with voice_line_ack (the seq) or voice_line_refused.
const here = path.dirname(fileURLToPath(import.meta.url));
const friday = path.join(here, "../../../../scenarios/friday-escalation");
const consentDir = path.join(here, "../../../../consent");
const PLAYERS = ["account_manager", "delivery_lead", "tech_lead"];
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
let parentTmp = "";
let savedTmp: string | undefined;
const runtimes: Runtime[] = [];
beforeAll(async () => { savedTmp = process.env.TMPDIR; parentTmp = await mkdtemp(path.join(os.tmpdir(), "acr-voiceline-")); process.env.TMPDIR = parentTmp; });
afterAll(async () => { if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp; await rm(parentTmp, { recursive: true, force: true }); });
afterEach(async () => { vi.restoreAllMocks(); for (const r of runtimes.splice(0)) await r.stop(); });

async function boot() {
  const sent: ChildMessage[] = [];
  let handler: ((m: ParentMessage) => void) | undefined;
  const parent: ParentChannel = { send(m) { sent.push(m); return true; }, onMessage(fn) { handler = fn; }, onDisconnect() {} };
  const tmp = await mkdtemp(path.join(parentTmp, "run-"));
  const r = await bootstrap({
    env: { SCENARIO_DIR: friday, RUNTIME_PORT: "0", RUNTIME_HOST: "127.0.0.1", SESSION_ID: "vl", MODEL_PROVIDER: "mock", CONTROL_MANAGED: "1", CONSENT_NOTICE_VERSION: "v3", VOICE_ENABLED: "1", SESSION_DATA_DIR: path.join(tmp, "sessions") },
    root: tmp, consentDir, tickMs: 60_000, log: () => {}, warn: () => {}, parent,
  });
  if (!r.ok) throw new Error(r.errors.join("; "));
  runtimes.push(r.runtime);
  const host = r.runtime.host;
  for (const role of PLAYERS) { host.join(role, `p-${role}`); host.giveConsent(role, `p-${role}`, "v3"); }
  await host.start();
  host.optInVoice("tech_lead", "p-tech_lead", "v3");
  const answers = () => sent.filter((m) => m.type === "voice_line_ack" || m.type === "voice_line_refused");
  return { host, sent, answers, send: (m: ParentMessage) => handler!(m) };
}
const line = (segmentId: string, roleId = "tech_lead", participantId = `p-${roleId}`) => ({ type: "voice_line" as const, segmentId, roleId, participantId, text: "We can ship in May." });

describe("main and voice_line (US-0070)", () => {
  it("voice_line answers voice_line_ack with the seq of the recorded utterance", async () => {
    const b = await boot();
    b.send(line("seg1"));
    await vi.waitFor(() => expect(b.answers()).toHaveLength(1));
    const ack = b.answers()[0] as Extract<ChildMessage, { type: "voice_line_ack" }>;
    expect(ack).toEqual({ type: "voice_line_ack", segmentId: "seg1", seq: expect.any(Number) });
    expect(b.host.engine.state.transcript.find((u) => u.seq === ack.seq)).toMatchObject({ roleId: "tech_lead", channel: "voice" });
    await b.host.idle();
  });

  it("a refused line answers voice_line_refused with the code", async () => {
    const b = await boot();
    b.send(line("seg2", "account_manager"));
    b.send(line("seg3", "tech_lead", "someone-else"));
    await vi.waitFor(() => expect(b.answers()).toHaveLength(2));
    expect(b.answers()).toEqual([{ type: "voice_line_refused", segmentId: "seg2", code: "not_recording" }, { type: "voice_line_refused", segmentId: "seg3", code: "not_holder" }]);
  });

  it("an internal failure answers failed", async () => {
    const b = await boot();
    vi.spyOn(b.host, "onVoiceUtterance").mockRejectedValueOnce(new Error("boom"));
    b.send(line("seg4"));
    await vi.waitFor(() => expect(b.answers()).toHaveLength(1));
    expect(b.answers()[0]).toEqual({ type: "voice_line_refused", segmentId: "seg4", code: "failed" });
  });

  it("a handler that throws synchronously still answers failed", async () => {
    const b = await boot();
    vi.spyOn(b.host, "onVoiceUtterance").mockImplementationOnce(() => { throw new Error("sync"); });
    b.send(line("seg5"));
    await vi.waitFor(() => expect(b.answers()).toHaveLength(1));
    expect(b.answers()[0]).toEqual({ type: "voice_line_refused", segmentId: "seg5", code: "failed" });
  });

  it("every voice_line gets exactly one answer", async () => {
    const b = await boot();
    const ids = ["a1", "a2", "a3", "a4", "a5"];
    ids.forEach((id, i) => b.send(line(id, i % 2 === 0 ? "tech_lead" : "account_manager")));
    await vi.waitFor(() => expect(b.answers()).toHaveLength(5));
    expect(b.answers().map((a) => a.segmentId).sort()).toEqual(ids);
    await b.host.idle();
    expect(b.answers()).toHaveLength(5);
  });

  it("speech_activity, voice_notice and voice_alert are never answered", async () => {
    const b = await boot();
    const before = b.sent.length;
    b.send({ type: "speech_activity", roleId: "tech_lead", active: true });
    b.send({ type: "voice_notice", roleId: "tech_lead", participantId: "p-tech_lead", code: "empty" });
    b.send({ type: "voice_alert", code: "stt_failed" });
    await b.host.idle();
    expect(b.sent.slice(before).filter((m) => m.type.startsWith("voice_line"))).toEqual([]);
  });
});

describe("main routes voice_notice and voice_alert (US-0070, Task 10)", () => {
  it("a voice_notice reaches the host's notice listeners and a voice_alert appends the fixed facilitator alert", async () => {
    const b = await boot();
    const notices: string[] = [];
    b.host.onVoiceNotice((roleId, code) => notices.push(`${roleId}:${code}`));
    b.send({ type: "voice_notice", roleId: "tech_lead", participantId: "p-tech_lead", code: "empty" });
    b.send({ type: "voice_alert", code: "stt_unavailable" });
    expect(notices).toEqual(["tech_lead:empty"]);
    await vi.waitFor(() => expect(b.host.engine.state.lastSeq).toBeGreaterThan(0));
    await vi.waitFor(async () => {
      const r = b.host.engine.eventsAfter(0);
      expect(r.complete && [...r.events].some((e) => e.type === "facilitator.alert" && e.message.startsWith("Voice input is unavailable"))).toBe(true);
    });
  });
});

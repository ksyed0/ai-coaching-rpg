import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadScenario, type Scenario } from "@acr/script";
import { FakeClock } from "../clock.js";
import { openSession, type OpenedSession } from "../session-store.js";
import { VoiceChoices } from "../voice-file.js";

// US-0070: the session store gives the seats a voice record bound to the credentials' log identity, and removes it with the seats.
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
const NOTICE = { version: "v3", text: "Notice three." };
let scenario: Scenario;
let parentTmp = "";
let savedTmp: string | undefined;
let dir = "";
const open: OpenedSession[] = [];
beforeAll(async () => { savedTmp = process.env.TMPDIR; parentTmp = await mkdtemp(path.join(os.tmpdir(), "acr-storevoice-")); process.env.TMPDIR = parentTmp; scenario = await loadScenario(fixture); });
afterAll(async () => { if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp; await rm(parentTmp, { recursive: true, force: true }); });
beforeEach(async () => { dir = await mkdtemp(path.join(parentTmp, "d-")); });
afterEach(async () => { for (const o of open.splice(0)) await o.close(); });
const openIt = async (mode: "resume" | "fresh") => {
  const o = await openSession({ scenario, sessionId: "s", dataDir: dir, clock: new FakeClock(1_000), mode, now: () => new Date("2031-02-03T04:05:06Z"), joinCodes: true, consentNotice: NOTICE });
  open.push(o);
  return o;
};
const choose = (o: OpenedSession) => {
  const c = o.seats!.voiceFile!.read().choices;
  c.set("host", { participantId: "p", choice: "voice", noticeVersion: "v3", at: 1 });
  o.seats!.voiceFile!.write(c);
};

describe("session store and the voice record (US-0070)", () => {
  it("a resumed running session reads back the voice record written before the restart", async () => {
    const first = await openIt("resume");
    await first.engine.start({ host: "p" });
    first.seats!.credentials.issue("host", "Pat");
    first.seats!.persist();
    choose(first);
    expect(await readdir(dir)).toContain("s.voice.json");
    await first.close(); open.splice(open.indexOf(first), 1);
    const second = await openIt("resume");
    expect(second.outcome).toBe("resumed");
    const r = second.seats!.voiceFile!.read();
    expect(r.problem).toBeUndefined();
    expect(r.choices.choiceFor("host", "p")).toBe("voice");
  });

  it("a fresh start removes the old voice record with the other seat files", async () => {
    const first = await openIt("resume");
    choose(first);
    await first.close(); open.splice(open.indexOf(first), 1);
    await openIt("fresh");
    expect(await readdir(dir)).not.toContain("s.voice.json");
  });

  it("the voice record is written only while the session lock is held", async () => {
    const o = await openIt("resume");
    await rm(path.join(dir, "s.lock"));
    expect(() => o.seats!.voiceFile!.write(VoiceChoices.empty({ sessionId: "s", logIdentity: o.seats!.credentials.logIdentity }))).toThrow();
    expect(() => o.seats!.voiceFile!.remove()).toThrow();
    expect(await readdir(dir)).not.toContain("s.voice.json");
  });
});

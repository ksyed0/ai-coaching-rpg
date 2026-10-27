import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario } from "@acr/script";
import { MockModelProvider } from "@acr/adapters";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { PlayerCredentials } from "../../engine/credentials.js";
import { ConsentStore } from "../../engine/consent.js";
import type { Seats } from "../../engine/seats.js";
import { SessionHost } from "../session-host.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
const NAME = "QZXNAME1";

// Regression guard (AC-0283): nothing puts a display name in a prompt today, so this passes before and after US-0055. It runs a real
// round (start, a player line, an NPC reply, a Game Master judgement) so a future change that feeds names to a model fails here.
describe("display names and model prompts (US-0055)", () => {
  it("no prompt sent to an NPC or Game Master model contains a display name", async () => {
    const scenario = await loadScenario(fixture);
    const clock = new FakeClock(0);
    const engine = new SessionEngine({ scenario, log: new MemoryEventLog("s"), clock });
    const seats: Seats = { credentials: PlayerCredentials.create({ sessionId: "s", scenarioSha256: "d".repeat(64) }), consent: new ConsentStore({ version: "v1", text: "t" }), persist: vi.fn() };
    const npc = new MockModelProvider(["Hello host, lovely to be here"]);
    const gm = new MockModelProvider(['{"verdict": false, "reasoning": "not yet"}']);
    const lines: string[] = [];
    const host = new SessionHost({ scenario, engine, npcProvider: npc, gmProvider: gm, clock, seats, gmEveryN: 1, log: (m) => lines.push(m) });
    seats.credentials.issue("host", NAME);
    host.join("host", "participant-1");
    host.giveConsent("host", "participant-1", "v1");
    await host.start();
    await host.onPlayerUtterance("host", "Hi Sam, welcome");
    await host.idle();
    expect(npc.calls.length).toBeGreaterThan(0);
    expect(gm.calls.length).toBeGreaterThan(0);
    const prompts = JSON.stringify([...npc.calls, ...gm.calls]);
    expect(prompts).not.toContain(NAME);
    expect(lines.join("\n")).not.toContain(NAME);
  });
});

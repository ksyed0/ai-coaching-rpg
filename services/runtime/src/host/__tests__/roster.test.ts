import { describe, expect, it, vi } from "vitest";
import { PlayerCredentials } from "../../engine/credentials.js";
import { ConsentStore } from "../../engine/consent.js";
import type { Seats } from "../../engine/seats.js";
import { buildRoster } from "../roster.js";

const BIND = { sessionId: "s", scenarioSha256: "d".repeat(64) };
const seats = (): Seats => ({ credentials: PlayerCredentials.create(BIND), consent: new ConsentStore({ version: "v1", text: "t" }), persist: vi.fn() });

describe("buildRoster (US-0055)", () => {
  it("ready means joined and consented for the same participant", () => {
    const s = seats();
    s.credentials.issue("a", "Alice"); s.credentials.issue("b", "Bob"); s.credentials.issue("c", "Cy");
    s.consent.give("a", "p-a", "v1", 1);
    s.consent.give("b", "someone-else", "v1", 1); // consent by another participant does not count for the holder
    const r = buildRoster({ playerRoles: ["a", "b", "c"], assignments: { a: "p-a", b: "p-b" }, connected: new Set(["a"]), seats: s });
    expect(r.facilitator).toEqual([
      { roleId: "a", name: "Alice", joined: true, consented: true, connected: true },
      { roleId: "b", name: "Bob", joined: true, consented: false, connected: false },
      { roleId: "c", name: "Cy", joined: false, consented: false, connected: false },
    ]);
    expect(r.peers.map((p) => [p.roleId, p.ready])).toEqual([["a", true], ["b", false], ["c", false]]);
  });

  it("AI characters are not listed", () => {
    const r = buildRoster({ playerRoles: ["a"], assignments: { a: "p", guest: "ai" }, connected: new Set(["a", "guest"]) });
    expect(r.facilitator.map((e) => e.roleId)).toEqual(["a"]);
    expect(r.peers.map((e) => e.roleId)).toEqual(["a"]);
  });

  it("a terminal player has no name", () => {
    const s = seats();
    const r = buildRoster({ playerRoles: ["a"], assignments: { a: "p" }, connected: new Set(["a"]), seats: s });
    expect(r.facilitator[0]).not.toHaveProperty("name");
    expect(r.peers[0]).not.toHaveProperty("name");
    expect(buildRoster({ playerRoles: ["a"], assignments: {}, connected: new Set() }).peers[0]).not.toHaveProperty("name");
  });
});

import { describe, expect, it } from "vitest";
import { SILENT_DROP_LIMIT_PERIODS, silentDropEvidence } from "../lab.js";

// BUG-0003: F-23 judges the silent client by the pings it saw, with a tight limit measured from its first unanswered ping.
describe("silentDropEvidence (check F-23)", () => {
  const hb = 200;
  it("accepts the normal case: one unanswered ping, dropped one period later", () => {
    expect(silentDropEvidence({ pings: 1, sinceFirstPingMs: 210, heartbeatMs: hb })).toMatch(/1 unanswered ping and was dropped within 3 heartbeat periods of the first/);
  });
  it("accepts two pings and the limit itself", () => {
    expect(() => silentDropEvidence({ pings: 2, sinceFirstPingMs: 3 * hb, heartbeatMs: hb })).not.toThrow();
  });
  it("is the same for a fast and a paced run: the figure depends on pings, not on pacing", () => {
    expect(silentDropEvidence({ pings: 1, sinceFirstPingMs: 200, heartbeatMs: hb })).toBe(silentDropEvidence({ pings: 1, sinceFirstPingMs: 230, heartbeatMs: hb }));
  });
  it("fails when the client was never pinged", () => {
    expect(() => silentDropEvidence({ pings: 0, sinceFirstPingMs: 0, heartbeatMs: hb })).toThrow(/never pinged/);
  });
  it("fails when the server kept pinging a silent client", () => {
    expect(() => silentDropEvidence({ pings: 3, sinceFirstPingMs: 400, heartbeatMs: hb })).toThrow(/3 times/);
  });
  it("fails when the drop took 20 periods (the old limit was 25)", () => {
    expect(SILENT_DROP_LIMIT_PERIODS).toBe(3);
    expect(() => silentDropEvidence({ pings: 1, sinceFirstPingMs: 20 * hb, heartbeatMs: hb })).toThrow(/20\.0 heartbeat periods.*limit 3/);
  });
});

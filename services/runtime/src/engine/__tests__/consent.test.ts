import { describe, expect, it } from "vitest";
import { ConsentError, ConsentRecordError, ConsentStore } from "../consent.js";

const BIND = { sessionId: "s", scenarioSha256: "c".repeat(64) };
const NOTICE = { version: "v1", text: "notice" };

describe("ConsentStore (US-0053)", () => {
  it("test_give_records_participant_version_and_time", () => {
    const c = new ConsentStore(NOTICE);
    c.give("a", "p1", "v1", 5);
    expect(c.toRecord(BIND).entries.a).toEqual({ participantId: "p1", noticeVersion: "v1", at: 5 });
    expect(c.has("a", "p1")).toBe(true);
    expect(c.notice).toEqual(NOTICE);
  });

  it("test_give_with_another_version_throws_version_mismatch", () => {
    const c = new ConsentStore(NOTICE);
    try { c.give("a", "p1", "v2", 5); expect.unreachable(); } catch (e) { expect(e).toBeInstanceOf(ConsentError); expect((e as ConsentError).code).toBe("version_mismatch"); }
    expect(c.has("a", "p1")).toBe(false);
  });

  it("test_give_refuses_invalid_input_without_quoting_it", () => {
    const c = new ConsentStore(NOTICE);
    const cases: [string, string, string, number][] = [
      ["__proto__", "p1", "v1", 5], ["", "p1", "v1", 5], ["r".repeat(129), "p1", "v1", 5],
      ["a", "", "v1", 5], ["a", "p".repeat(129), "v1", 5],
      ["a", "p1", "v".repeat(65), 5],
      ["a", "p1", "v1", NaN], ["a", "p1", "v1", -1], ["a", "p1", "v1", Infinity],
    ];
    for (const [r, p, v, at] of cases) {
      try { c.give(r, p, v, at); expect.unreachable(); }
      catch (e) { expect(e).toBeInstanceOf(ConsentError); expect((e as ConsentError).code).toBe("invalid_input"); expect((e as Error).message).not.toContain("p1"); }
    }
    expect(c.snapshot()).toEqual({});
    expect(() => ConsentStore.fromRecord(JSON.parse(JSON.stringify(c.toRecord(BIND))), NOTICE, BIND)).not.toThrow();
  });

  it("test_has_is_false_for_a_different_participant_than_the_one_who_consented", () => {
    const c = new ConsentStore(NOTICE);
    c.give("a", "p1", "v1", 5);
    expect(c.has("a", "p2")).toBe(false);
    expect(c.has("b", "p1")).toBe(false);
    expect(c.withdraw("a")).toBe(true);
    expect(c.withdraw("a")).toBe(false);
    expect(c.has("a", "p1")).toBe(false);
  });

  it("test_fromRecord_drops_entries_under_another_notice_version", () => {
    const c = new ConsentStore(NOTICE);
    c.give("a", "p1", "v1", 5);
    const rec = JSON.parse(JSON.stringify(c.toRecord(BIND)));
    rec.entries.b = { participantId: "p2", noticeVersion: "v0", at: 1 };
    const back = ConsentStore.fromRecord(rec, NOTICE, BIND);
    expect(back.has("a", "p1")).toBe(true);
    expect(back.has("b", "p2")).toBe(false);
    expect(Object.keys(back.snapshot())).toEqual(["a"]);
    expect(ConsentStore.fromRecord(rec, { version: "v2", text: "t" }, BIND).snapshot()).toEqual({});
  });

  it("test_snapshot_carries_no_participant_id", () => {
    const c = new ConsentStore(NOTICE);
    c.give("a", "p1", "v1", 5);
    expect(c.snapshot()).toEqual({ a: { noticeVersion: "v1", at: 5 } });
    expect(JSON.stringify(c.snapshot())).not.toContain("p1");
  });

  it("test_fromRecord_refuses_an_own___proto___role_key", () => {
    const rec = JSON.parse(`{"v":1,"sessionId":"s","scenarioSha256":"${"c".repeat(64)}","entries":{"__proto__":{"participantId":"p","noticeVersion":"v1","at":1}}}`);
    expect(() => ConsentStore.fromRecord(rec, NOTICE, BIND)).toThrow(ConsentRecordError);
  });

  it("test_fromRecord_refuses_malformed_or_foreign_records_without_quoting_them", () => {
    const rec = new ConsentStore(NOTICE).toRecord(BIND);
    const bad: unknown[] = [
      null, { ...rec, extra: 1 }, { ...rec, v: 2 }, { ...rec, sessionId: "other" }, { ...rec, scenarioSha256: "d".repeat(64) },
      { ...rec, entries: { a: { participantId: "SECRETID", noticeVersion: "v1" } } },
      { ...rec, entries: { a: { participantId: "SECRETID", noticeVersion: "v1", at: "x" } } },
    ];
    for (const r of bad) {
      try { ConsentStore.fromRecord(r, NOTICE, BIND); expect.unreachable(); }
      catch (e) { expect(e).toBeInstanceOf(ConsentRecordError); expect((e as Error).message).not.toContain("SECRETID"); }
    }
  });
});

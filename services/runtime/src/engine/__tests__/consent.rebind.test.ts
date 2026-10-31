import { describe, expect, it } from "vitest";
import { ConsentStore, REBIND_PENDING } from "../consent.js";

const BIND = { sessionId: "s", scenarioSha256: "c".repeat(64) };
const NOTICE = { version: "v1", text: "notice" };

describe("ConsentStore rebind (US-0058)", () => {
  it("releaseForRebind then claimRebind binds the new participant and keeps the notice version", () => {
    const c = new ConsentStore(NOTICE);
    c.give("a", "old", "v1", 5);
    expect(c.releaseForRebind("a")).toBe(true);
    expect(c.isRebindPending("a")).toBe(true);
    expect(c.has("a", "old")).toBe(false);
    expect(c.has("a", "new")).toBe(false);
    expect(c.has("a", REBIND_PENDING)).toBe(false); // the placeholder never counts as a participant
    expect(c.hasEntry("a")).toBe(true);
    expect(c.claimRebind("a", "new", 99)).toBe(true);
    expect(c.has("a", "new")).toBe(true);
    expect(c.isRebindPending("a")).toBe(false);
    expect(c.toRecord(BIND).entries.a).toEqual({ participantId: "new", noticeVersion: "v1", at: 99 });
  });

  it("releaseForRebind without an entry is false, and claimRebind only works while pending", () => {
    const c = new ConsentStore(NOTICE);
    expect(c.releaseForRebind("a")).toBe(false);
    expect(c.isRebindPending("a")).toBe(false);
    expect(c.claimRebind("a", "p", 1)).toBe(false);
    c.give("a", "p1", "v1", 1);
    expect(c.claimRebind("a", "p2", 2)).toBe(false); // not pending: the holder's consent is not taken over
    expect(c.has("a", "p1")).toBe(true);
  });

  it("claimRebind refuses invalid input and the placeholder itself, leaving the seat pending", () => {
    const c = new ConsentStore(NOTICE);
    c.give("a", "p1", "v1", 1);
    c.releaseForRebind("a");
    expect(c.claimRebind("a", "", 1)).toBe(false);
    expect(c.claimRebind("a", "p".repeat(129), 1)).toBe(false);
    expect(c.claimRebind("a", REBIND_PENDING, 1)).toBe(false);
    expect(c.claimRebind("a", "p2", Number.NaN)).toBe(false);
    expect(c.isRebindPending("a")).toBe(true);
  });

  it("a rebind is persisted and survives a restart", () => {
    const c = new ConsentStore(NOTICE);
    c.give("a", "old", "v1", 5);
    c.releaseForRebind("a");
    const json = JSON.parse(JSON.stringify(c.toRecord(BIND)));
    const back = ConsentStore.fromRecord(json, NOTICE, BIND);
    expect(back.isRebindPending("a")).toBe(true);
    expect(back.claimRebind("a", "new", 7)).toBe(true);
    const again = ConsentStore.fromRecord(JSON.parse(JSON.stringify(back.toRecord(BIND))), NOTICE, BIND);
    expect(again.has("a", "new")).toBe(true);
  });

  it("a pending marker survives a newer notice version (it is not a consent under the old text, and dropping it would lose the rebind)", () => {
    const c = new ConsentStore(NOTICE);
    c.give("a", "old", "v1", 5);
    c.releaseForRebind("a");
    const back = ConsentStore.fromRecord(JSON.parse(JSON.stringify(c.toRecord(BIND))), { version: "v2", text: "n" }, BIND);
    expect(back.isRebindPending("a")).toBe(true);
    expect(back.snapshot().a?.noticeVersion).toBe("v1");
  });

  it("give and adopt refuse the placeholder as a participant", () => {
    const c = new ConsentStore(NOTICE);
    expect(() => c.give("a", REBIND_PENDING, "v1", 1)).toThrow();
    expect(() => c.adopt("a", REBIND_PENDING, "v1", 1)).toThrow();
    expect(c.hasEntry("a")).toBe(false);
  });

  it("entryOf and restoreEntry put an entry back exactly", () => {
    const c = new ConsentStore(NOTICE);
    c.give("a", "p1", "v1", 5);
    const before = c.entryOf("a");
    c.releaseForRebind("a");
    c.restoreEntry("a", before);
    expect(c.has("a", "p1")).toBe(true);
    c.restoreEntry("a", undefined);
    expect(c.hasEntry("a")).toBe(false);
  });
});

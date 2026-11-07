import type { SessionEvent } from "@acr/events";
import { loadScenario, type NpcRole, type Scenario } from "@acr/script";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../main.js";
import { alertsForReply, collectRunSummary, sanitizeAlert, ALERT_CHARS } from "../evidence.js";

let scenario: Scenario;
let npc: NpcRole;
beforeAll(async () => {
  scenario = await loadScenario(path.join(REPO_ROOT, "scenarios", "friday-escalation"));
  npc = Object.values(scenario.roles).find((r): r is NpcRole => r.type === "npc")!;
});

let seq = 0;
const base = () => ({ seq: ++seq, ts: 0, sessionId: "s" });
const say = (roleId: string, text: string, fallback?: true): SessionEvent => ({ ...base(), type: "utterance", roleId, text, channel: "text", ...(fallback ? { fallback } : {}) } as SessionEvent);
const alert = (message: string, level: "info" | "warning" = "warning"): SessionEvent => ({ ...base(), type: "facilitator.alert", level, message });
const none = { secrets: [] as string[], hidden: [] as string[] };

describe("collectRunSummary (US-0023, AC-0073)", () => {
  it("counts replies and canned fallbacks per character, by the marker and not by the text", () => {
    seq = 0;
    const events = [say("delivery_lead", "hi"), say(npc.id, "real"), say("delivery_lead", "again"), alert(`NPC ${npc.id}: empty reply; used fallback line`), say(npc.id, npc.fallback_line, true), say(npc.id, npc.fallback_line)];
    const ev = collectRunSummary(events, scenario, { secrets: [] });
    expect(ev.npcReplies).toBe(3);
    expect(ev.fallbackReplies).toBe(1); // the third reply merely says the same words: a model line, not a fallback
    expect(ev.byCharacter).toEqual([{ roleId: npc.id, name: npc.name, replies: 3, fallbackReplies: 1 }]);
    expect(ev.scenesEndedByGm).toBe(0);
  });
  it("an empty stream reports zero of zero", () => {
    expect(collectRunSummary([], scenario, { secrets: [] })).toMatchObject({ npcReplies: 0, fallbackReplies: 0, alerts: [], scenesEndedByGm: 0 });
  });
  it("scenesEndedByGm counts only scene.exited with reason gm_detects", () => {
    seq = 0;
    const exit = (reason: string): SessionEvent => ({ ...base(), type: "scene.exited", sceneId: "s1", reason } as unknown as SessionEvent);
    const events = [exit("gm_detects"), exit("time_box_elapsed"), exit("facilitator_advance"), exit("gm_detects"), exit("facilitator_end"), say(npc.id, "x")];
    expect(collectRunSummary(events, scenario, { secrets: [] }).scenesEndedByGm).toBe(2);
  });
  it("legacy true changes fallback detection exactly as the demo's tests expect: it also recognises the fallback text right after the character's own fallback alert", () => {
    seq = 0;
    const events = [alert(`NPC ${npc.id}: empty reply; used fallback line`), say(npc.id, npc.fallback_line), say(npc.id, npc.fallback_line)];
    expect(collectRunSummary(events, scenario, { secrets: [], legacy: true }).fallbackReplies).toBe(1);
    expect(collectRunSummary(events, scenario, { secrets: [] }).fallbackReplies).toBe(0);
  });
});

describe("the output holds no code, token or hidden-fact text", () => {
  it("the output holds no code, token or hidden-fact text", () => {
    seq = 0;
    const fact = npc.hidden[0]!;
    const a = alert(`NPC ${npc.id}: HTTP 401 for code ABCD-1234-WXYZ, Bearer abc.def.ghi, key TOPSECRETKEY and fact ${fact}; used fallback line`);
    const out = JSON.stringify(collectRunSummary([a, say(npc.id, npc.fallback_line, true)], scenario, { secrets: ["ABCD-1234-WXYZ", "TOPSECRETKEY"] }));
    for (const bad of ["ABCD-1234-WXYZ", "ABCD1234WXYZ", "abc.def.ghi", "TOPSECRETKEY", fact]) expect(out).not.toContain(bad);
  });
});

describe("alerts (US-0023, AC-0074)", () => {
  it("captures the reason of a fallback alert and ties it to the character's next reply", () => {
    seq = 0;
    const a = alert(`NPC ${npc.id}: model error after 3 attempts (overloaded): Service temporarily overloaded; used fallback line`);
    const reply = say(npc.id, npc.fallback_line, true);
    const other = alert('GM: no usable verdict for "x"', "info");
    const ev = collectRunSummary([say("delivery_lead", "x"), a, reply, other], scenario, { secrets: [] });
    expect(ev.alerts).toEqual([
      { seq: a.seq, level: "warning", role: npc.id, fallback: true, reason: "model error after 3 attempts (overloaded): Service temporarily overloaded", replySeq: reply.seq },
      { seq: other.seq, level: "info", role: null, fallback: false, reason: 'no usable verdict for "x"', replySeq: null },
    ]);
    expect(alertsForReply([a, reply, other], { seq: reply.seq, roleId: npc.id }, { ...none, scenario }).map((x) => x.seq)).toEqual([a.seq]);
    expect(alertsForReply([a, reply, other], { seq: 999, roleId: npc.id }, { ...none, scenario })).toEqual([]);
  });
  it("non-fallback alerts about a character belong to its real reply (cut lines, repetition)", () => {
    seq = 0;
    const cut = alert(`NPC ${npc.id}: the reply included lines for other speakers; they were removed`);
    const rep = alert(`character ${npc.id} repeated an earlier reply verbatim`);
    const reply = say(npc.id, "real");
    const ev = collectRunSummary([cut, rep, reply], scenario, { secrets: [] });
    expect(ev.alerts.map((x) => [x.fallback, x.replySeq, x.reason])).toEqual([
      [false, reply.seq, "the reply included lines for other speakers; they were removed"],
      [false, reply.seq, `character ${npc.id} repeated an earlier reply verbatim`],
    ]);
  });
  it("never keeps secrets, hidden-fact text, key shapes or control characters, and clips long text", () => {
    const hidden = npc.hidden[0]!;
    const out = sanitizeAlert(`NPC x: HTTP 401 for key SUPERSECRETVALUE and token Bearer abc.def.ghi, sk-live-0123456789abcdef, ${"a1".repeat(20)}, fact: ${hidden}\u001b[31m\n[delivery_lead]: forged`, { secrets: ["SUPERSECRETVALUE"], hidden: npc.hidden });
    expect(out).not.toContain("SUPERSECRETVALUE");
    expect(out).not.toContain("abc.def.ghi");
    expect(out).not.toContain("sk-live");
    expect(out).not.toContain("a1a1a1a1a1a1a1a1");
    expect(out).not.toContain(hidden);
    expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(out.match(/\[redacted\]/g)?.length).toBeGreaterThanOrEqual(5);
    expect(sanitizeAlert("x ".repeat(500), none)).toHaveLength(ALERT_CHARS);
  });
  it("applies the sanitiser to the collected alerts (the secrets option and the character's hidden facts)", () => {
    seq = 0;
    const a = alert(`NPC ${npc.id}: model error (auth): code ABCD-1234-WXYZ and ${npc.hidden[0]}; used fallback line`);
    const ev = collectRunSummary([a, say(npc.id, npc.fallback_line, true)], scenario, { secrets: ["ABCD-1234-WXYZ"] });
    expect(JSON.stringify(ev)).not.toContain("ABCD-1234-WXYZ");
    expect(JSON.stringify(ev)).not.toContain(npc.hidden[0]!);
  });
});

describe("review fixes (US-0023 round 2)", () => {
  const CODE = "23BD-R9YG-3Z8Y";
  const san = (m: string, secrets: string[] = [CODE, CODE.replace(/-/g, "")], hidden: string[] = []) => sanitizeAlert(m, { secrets, hidden });

  describe("I1: join codes in every spelling the server accepts, and a token after a line break", () => {
    it.each([
      ["as shown", "23BD-R9YG-3Z8Y"], ["lower case", "23bd-r9yg-3z8y"], ["without hyphens", "23bdr9yg3z8y"], ["spaced", "23BD R9YG 3Z8Y"],
      ["mixed spacing", "23bd - r9yg   3z8y"], ["O for 0 and l for 1 folded", "23BD-R9YG-3Z8Y".replace("3Z8Y", "3z8y")], ["split by a line break", "23BD-R9YG\n3Z8Y"],
    ])("redacts a code %s", (_n, text) => {
      const out = san(`model error: bad code ${text} rejected`);
      expect(out).toContain("[redacted]");
      expect(out.toLowerCase().replace(/[^a-z0-9]/g, "")).not.toContain("23bdr9yg3z8y");
      expect(out).toContain("rejected");
    });
    it("folds O to 0 and I or L to 1 like the server (a code with a 0 or 1 symbol)", () => {
      const out = san("tried 1O-o1-LI-0O-1111 ok".replace("1O-o1-LI-0O-1111", "ABCD-EFG1-0000"), ["ABCD-EFG1-0000"]);
      expect(out).toBe("tried [redacted] ok");
      expect(san("tried abcd-efgl-oooo ok", ["ABCD-EFG1-0000"])).toBe("tried [redacted] ok");
      expect(san("tried abcd-efgI-OOOO ok", ["ABCD-EFG1-0000"])).toBe("tried [redacted] ok");
    });
    it("does not mangle ordinary prose, numbers, model ids or a similar but different code", () => {
      const prose = "NPC cfo: model error after 3 attempts (overloaded): Service temporarily overloaded on gemma-4-31b-it-qat-mxfp4 at 12:30, HTTP 503";
      expect(san(prose)).toBe(prose);
      expect(san("23BD-R9YG-3Z8Z is not the code")).toBe("23BD-R9YG-3Z8Z is not the code");
      expect(san("a code 23BD-R9YG-3Z8Y", ["not a code at all"])).toBe("a code 23BD-R9YG-3Z8Y");
    });
    it("redacts a bearer token after a line break (the line break becomes a marker before the pass)", () => {
      for (const m of ["Bearer\nshortTok456", "Bearer \r\n shortTok456", "bearer\tshortTok456", "Bearer shortTok456", String.raw`Bearer\nshortTok456`, String.raw`"Bearer\r\nshortTok456"`]) {
        const out = san(`auth failed: ${m} end`);
        expect(out).not.toContain("shortTok456");
        expect(out).toContain("end");
      }
    });
    it("holds for the collected evidence too (secrets option, every spelling)", () => {
      seq = 0;
      const a = alert(`NPC ${npc.id}: model error (auth): 23bdr9yg3z8y and 23BD R9YG 3Z8Y; used fallback line`);
      const ev = collectRunSummary([a, say(npc.id, npc.fallback_line, true)], scenario, { secrets: [CODE] });
      expect(JSON.stringify(ev).toLowerCase()).not.toMatch(/23bd.?r9yg.?3z8y/);
    });
  });

  describe("I2: hidden facts survive no disguise", () => {
    const HID = "Phased delivery after go-live if the risk is accepted";
    const hidden = [HID];
    const ZW = ["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff", "\u00ad", "\u202e", "\u0301"];
    it.each(ZW.map((c) => [`U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`, c]))("an invisible %s inside the fact", (_n, c) => {
      const out = san(`note: ${HID.slice(0, 10)}${c}${HID.slice(10)} end`, [], hidden);
      expect(out).toBe("note: [redacted] end");
    });
    it("case changes, full-width forms and several disguises at once", () => {
      expect(san(`x ${HID.toUpperCase()} y`, [], hidden)).toBe("x [redacted] y");
      expect(san(`x ${HID.toLowerCase()} y`, [], hidden)).toBe("x [redacted] y");
      const wide = [...HID].map((ch) => (ch >= "!" && ch <= "~" ? String.fromCharCode(ch.charCodeAt(0) + 0xfee0) : ch)).join("");
      expect(san(`x ${wide} y`, [], hidden)).toBe("x [redacted] y");
      expect(san(`x P\u200bh\u2060a\u0301sed DELIVERY\u00ad after go-live if the risk is accepted y`, [], hidden)).toBe("x [redacted] y");
    });
    it("redacts every occurrence and keeps the text around it", () => {
      expect(san(`a ${HID} b ${HID.toUpperCase()} c`, [], hidden)).toBe("a [redacted] b [redacted] c");
    });
    it("a fact cut off at the very end of the text is redacted from its start", () => {
      const out = san(`${"x ".repeat(5)}${HID.slice(0, 30)}`, [], hidden);
      expect(out).not.toContain("Phased delivery after go-live");
      expect(out).toContain("[redacted]");
      expect(san("fact starts: Phased", [], hidden)).toBe("fact starts: Phased"); // too short to be a cut-off fact
    });
    it("a fact straddling the 300 character clip is redacted before the clip", () => {
      const pad = "p".repeat(5).concat(" ").repeat(48); // 288 characters
      const out = san(`${pad}${HID}`, [], hidden);
      expect(out).not.toMatch(/phased/i);
      expect(out.endsWith("[redacted]")).toBe(true);
    });
    it("keeps ordinary text next to the fact readable (only the fact is replaced)", () => {
      expect(san(`NPC cfo: empty reply (${HID}); used fallback line`, [], hidden)).toBe("NPC cfo: empty reply ([redacted]); used fallback line");
    });
  });

  describe("I3: an alert belongs only to the reply it caused", () => {
    const sceneIn = (id: string): SessionEvent => ({ ...base(), type: "scene.entered", sceneId: id, participants: [] } as unknown as SessionEvent);
    const sceneOut = (id: string): SessionEvent => ({ ...base(), type: "scene.exited", sceneId: id, reason: "facilitator_advance" } as unknown as SessionEvent);
    it("an orphan alert (its reply was refused as stale) is not tied to a later reply in another scene, and is still reported", () => {
      seq = 0;
      const a = alert(`NPC ${npc.id}: empty reply; used fallback line`);
      const events = [sceneIn("s1"), a, sceneOut("s1"), sceneIn("s2"), say("delivery_lead", "hi"), say(npc.id, "a real reply")];
      const ev = collectRunSummary(events, scenario, { secrets: [] });
      expect(ev.alerts).toHaveLength(1);
      expect(ev.alerts[0]).toMatchObject({ seq: a.seq, fallback: true, replySeq: null });
      expect(alertsForReply(events, { seq: events[5]!.seq, roleId: npc.id }, { ...none, scenario })).toEqual([]);
    });
    it("a fallback alert is never tied to a reply that is not the fallback, even in the same scene", () => {
      seq = 0;
      const a = alert(`NPC ${npc.id}: empty reply; used fallback line`);
      const real = say(npc.id, "a real reply");
      const events = [sceneIn("s1"), a, real];
      expect(collectRunSummary(events, scenario, { secrets: [] }).alerts[0]!.replySeq).toBeNull();
      expect(alertsForReply(events, real as { seq: number; roleId: string }, { ...none, scenario })).toEqual([]);
    });
    it("three fallback alerts from scene 1 are not narrated under a later non-canned reply (the reviewer's repro)", () => {
      seq = 0;
      const alerts = [alert(`NPC ${npc.id}: empty reply; used fallback line`), alert(`NPC ${npc.id}: empty reply; used fallback line`), alert(`NPC ${npc.id}: empty reply; used fallback line`)];
      const later = say(npc.id, "finally a real reply");
      const events = [sceneIn("s1"), ...alerts, sceneOut("s1"), sceneIn("s2"), later];
      expect(collectRunSummary(events, scenario, { secrets: [] }).alerts.map((x) => x.replySeq)).toEqual([null, null, null]);
      expect(alertsForReply(events, later as { seq: number; roleId: string }, { ...none, scenario })).toEqual([]);
    });
    it("a non-fallback alert is not tied past a player line or a scene change", () => {
      seq = 0;
      const cut = alert(`NPC ${npc.id}: the reply included lines for other speakers; they were removed`);
      const mid = [sceneIn("s1"), cut, say("delivery_lead", "interrupting"), say(npc.id, "later reply")];
      expect(collectRunSummary(mid, scenario, { secrets: [] }).alerts[0]!.replySeq).toBeNull();
      seq = 0;
      const cut2 = alert(`character ${npc.id} repeated an earlier reply verbatim`);
      const other = [sceneIn("s1"), cut2, sceneOut("s1"), sceneIn("s2"), say(npc.id, "next scene")];
      expect(collectRunSummary(other, scenario, { secrets: [] }).alerts[0]!.replySeq).toBeNull();
    });
    it("a fallback alert still links to the fallback reply that follows it in the same scene (with the marker, and with the legacy rule)", () => {
      seq = 0;
      const a = alert(`NPC ${npc.id}: empty reply; used fallback line`);
      const fb = say(npc.id, npc.fallback_line, true);
      expect(collectRunSummary([sceneIn("s1"), a, fb], scenario, { secrets: [] }).alerts[0]!.replySeq).toBe(fb.seq);
      seq = 0;
      const b = alert(`NPC ${npc.id}: empty reply; used fallback line`);
      const legacy = say(npc.id, npc.fallback_line);
      const evs = [sceneIn("s1"), b, legacy];
      expect(collectRunSummary(evs, scenario, { secrets: [], legacy: true }).alerts[0]!.replySeq).toBe(legacy.seq);
      expect(collectRunSummary(evs, scenario, { secrets: [] }).alerts[0]!.replySeq).toBeNull();
    });
  });

  describe("M6: opaque tokens shorter than 32 characters", () => {
    it.each(["aB3dEf+gH1jKlMnOpQrStU", "dGVzdC1rZXktMTIzNDU2Nzg5MA==", "0123456789abcdef0123", "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0Ed"])("redacts %s", (tok) => {
      expect(san(`key ${tok} end`)).toBe("key [redacted] end");
    });
    it.each(["gemma-4-31b-it-qat-mxfp4", "claude-sonnet-4-5-20250929", "anthropic/claude-sonnet-4-5-20250929", "meta-llama/llama-3.3-70b-instruct:free", "req_011CTx9abcDEF123ghij", "claude-3-5-sonnet-20241022-v2-extended-thinking", "temporarily_overloaded_upstream", "AnOrdinaryLongWordNoDigits", "http://127.0.0.1:8080/v1"])("keeps %s", (txt) => {
      expect(san(`about ${txt} here`)).toBe(`about ${txt} here`);
    });
  });

  describe("N1: a fact cut off by the provider's snippet", () => {
    const FACT = "Would accept a phased delivery after go-live if the risk is explained well";
    const hid = [FACT];
    it.each([
      ["a snippet cut inside the fact, ending in ...", `local request failed with HTTP 400: {"error":"${"p".repeat(239)}${FACT.slice(0, 40)}...`],
      ["glued to a long run of characters", `${"p".repeat(239)}${FACT.slice(0, 40)}...`],
      ["ending in a closing quote and brace", `error {"message":"${FACT.slice(0, 30)}"}`],
      ["ending in an ellipsis character", `error: ${FACT.slice(0, 25)}…`],
      ["ending in several marks", `error: ${FACT.slice(0, 25)}..."} ]`],
    ])("redacts the start of a fact %s", (_n, text) => {
      const out = san(text, [], hid);
      expect(out).not.toMatch(/would accept|phased/i);
      expect(out).toContain("[redacted]");
    });
    it("redacts a whole fact glued to a long run (the opaque pass must not eat part of it first)", () => {
      const out = san(`${"p".repeat(60)}${FACT} tail`, [], hid);
      expect(out).not.toMatch(/phased/i);
      expect(out).toContain("tail");
    });
    it("leaves a short beginning alone (under 12 characters)", () => {
      expect(san("error: Would acc...", [], hid)).toBe("error: Would acc...");
    });
    it("precomposed and decomposed accents agree, and the mapping back stays right", () => {
      const acc = ["Caf\u00e9 prices are fixed for the team", "Caf\u00e9 prices are fixed for the team"];
      expect(san(`a ${acc[0]!.replace("\u00e9", "e\u0301")} b`, [], [acc[0]!])).toBe("a [redacted] b");
      expect(san(`a ${acc[0]} b`, [], [acc[0]!.replace("\u00e9", "e\u0301")])).toBe("a [redacted] b");
    });
  });

  describe("N2: readable diagnostics stay readable", () => {
    it("keeps a model-not-found message and its URL", () => {
      const m = "model not found: anthropic/claude-sonnet-4-5-20250929 at https://openrouter.ai/api/v1/chat/completions";
      expect(san(m)).toBe(m);
      expect(san("request id req_011CTx9abcDEF123ghij failed")).toBe("request id req_011CTx9abcDEF123ghij failed");
    });
    it("still redacts a long mixed run, even inside a path segment", () => {
      expect(san("at /v1/Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0Ed/x")).toBe("at /v1/[redacted]/x");
    });
  });

  it("N3: a doubly escaped Bearer value is redacted", () => {
    for (const m of [String.raw`Bearer\\nshortTok789`, String.raw`Bearer\\\\r\\\\nshortTok789`, String.raw`Bearer\nshortTok789`]) expect(san(`x ${m} y`)).not.toContain("shortTok789");
  });
});

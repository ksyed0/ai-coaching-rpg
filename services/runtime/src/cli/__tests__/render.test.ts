import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@acr/events";
import { renderEvent, sanitizeText, renderJoined, renderError, MAX_DISPLAY_CHARS, parseHiddenFacts, renderHidden, renderNewReleases } from "../render.js";

const env = { seq: 1, ts: 0, sessionId: "s" };
// eslint-disable-next-line no-control-regex
const INVISIBLE = new RegExp("[\\u202a-\\u202e\\u2066-\\u2069\\u200b-\\u200f\\u2028\\u2029\\ufeff]");
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

describe("renderEvent", () => {
  it("US-0034: a Game Master suggestion is a facilitator-only alert naming the role, the number and the command; an auto-release says the Game Master released it", () => {
    const e = { ...env, type: "gm.fact_earned" as const, sceneId: "s", roleId: "cfo", fact: 2, reasoning: "a fixed fee was offered" };
    expect(renderEvent(e, "facilitator")).toBe("[alert] Game Master suggests releasing hidden fact #2 of cfo (a fixed fee was offered): type /release cfo 2 to release it");
    expect(renderEvent(e, "delivery_lead")).toBeNull();
    expect(renderEvent({ ...e, autoRelease: true }, "facilitator")).toBe("[gm] the Game Master released hidden fact #2 of cfo itself (GM_AUTO_RELEASE is on): a fixed fee was offered");
    expect(renderEvent({ ...e, autoRelease: true }, "cfo")).toBeNull();
    const evil = renderEvent({ ...e, roleId: "\u001b[31mcfo\n[x]", fact: "\u001b[2J" as never, reasoning: "a\nb\u202e" }, "facilitator")!;
    expect(evil).not.toMatch(CONTROL);
    expect(evil).not.toMatch(INVISIBLE);
  });

  it("renders utterances with the speaker, marking mine", () => {
    expect(renderEvent({ ...env, type: "utterance", roleId: "guest", text: "Hi", channel: "text" }, "host")).toBe("guest: Hi");
    expect(renderEvent({ ...env, type: "utterance", roleId: "host", text: "Yo", channel: "text" }, "host")).toBe("you: Yo");
  });
  it("renders scene changes and injects", () => {
    expect(renderEvent({ ...env, type: "scene.entered", sceneId: "s2", participants: ["host"] }, "host")).toBe("--- scene s2 ---");
    expect(renderEvent({ ...env, type: "scene.exited", sceneId: "s2", reason: "time_box_elapsed" }, "host")).toBe("--- scene s2 ended (time_box_elapsed) ---");
    expect(renderEvent({ ...env, type: "inject.fired", injectId: "i", sceneId: "s", to: ["host"], content: "An email arrives." }, "host")).toBe("[inject] An email arrives.");
  });
  it("renders nothing for GM decisions to players and the decision for the facilitator", () => {
    const d = { ...env, type: "gm.decision" as const, sceneId: "s", condition: "c", verdict: true, reasoning: "r" };
    expect(renderEvent(d, "host")).toBeNull();
    expect(renderEvent(d, "facilitator")).toBe("[gm] c => true (r)");
  });
  it("renders a no-verdict event for the facilitator only, with its reason and the re-ask", () => {
    const e = { ...env, type: "gm.no_verdict" as const, sceneId: "s", condition: "c", reason: "no_json" as const, attempts: 2 };
    expect(renderEvent(e, "host")).toBeNull();
    expect(renderEvent(e, "facilitator")).toBe('[gm] no verdict for "c" (no_json after re-ask)');
    expect(renderEvent({ ...e, attempts: 1 }, "facilitator")).toBe('[gm] no verdict for "c" (no_json)');
  });
  it("renders alerts, npc updates, whispers and session lifecycle", () => {
    expect(renderEvent({ ...env, type: "facilitator.alert", level: "warning", message: "slow" }, "facilitator")).toBe("[alert] slow");
    expect(renderEvent({ ...env, type: "facilitator.alert", level: "warning", message: "slow" }, "host")).toBeNull();
    expect(renderEvent({ ...env, type: "npc.updated", roleId: "cto", goals: ["a", "b"], knowledge: [] }, "facilitator")).toBe("[npc cto] goals: a; b");
    expect(renderEvent({ ...env, type: "npc.updated", roleId: "cto", goals: ["a"], knowledge: [] }, "host")).toBeNull();
    expect(renderEvent({ ...env, type: "facilitator.command", command: "whisper", roleId: "host", text: "psst" }, "host")).toBe("[whisper] psst");
    expect(renderEvent({ ...env, type: "facilitator.command", command: "pause" }, "host")).toBe("[facilitator] pause");
    expect(renderEvent({ ...env, type: "session.started", scenarioId: "sc", version: "1", roles: {} }, "host")).toBe("session started: sc v1");
    expect(renderEvent({ ...env, type: "session.ended", reason: "script_complete" }, "host")).toBe("=== session ended (script_complete) ===");
  });
  it("renders nothing for unknown event types instead of crashing", () => {
    expect(renderEvent({ ...env, type: "something.new" } as unknown as SessionEvent, "host")).toBeNull();
  });
});

describe("sanitizeText (R26)", () => {
  it("neutralises ANSI CSI, OSC title and carriage-return overwrite", () => {
    expect(CONTROL.test(sanitizeText("a\x1b[2Jb"))).toBe(false);
    const osc = sanitizeText("x\x1b]0;pwned\x07y");
    expect(CONTROL.test(osc)).toBe(false);
    expect(osc).not.toContain("\x1b");
    const cr = sanitizeText("real text\rfake: overwrite");
    expect(cr).not.toContain("\r");
  });
  it("keeps a message from forging a new line", () => {
    const out = sanitizeText("hello\n[facilitator]: forged line");
    expect(out).not.toContain("\n");
    expect(out).toContain("⏎");
    expect(sanitizeText("a\r\nb")).toBe("a ⏎ b");
  });
  it("strips bidi, zero-width, line separators, NUL, DEL and C1", () => {
    for (const ch of ["\u202e", "\u202a", "\u2066", "\u2069", "\u200b", "\u200f", "\ufeff"]) expect(sanitizeText(`a${ch}b`)).toBe("ab");
    expect(sanitizeText("a\u2028b\u2029c")).toBe("a ⏎ b ⏎ c");
    expect(CONTROL.test(sanitizeText("a\x00b\x7fc\x85d\x9be"))).toBe(false);
  });
  it("keeps ordinary text, tabs become spaces, unicode survives", () => {
    expect(sanitizeText("héllo 世界 🙂")).toBe("héllo 世界 🙂");
    expect(sanitizeText("a\tb")).toBe("a b");
  });
  it("caps very long input with a truncation marker", () => {
    const out = sanitizeText("x".repeat(100_000));
    expect(out.length).toBeLessThanOrEqual(MAX_DISPLAY_CHARS + 20);
    expect(out.endsWith("[truncated]")).toBe(true);
  });
  it("tolerates non-string input", () => {
    expect(sanitizeText(undefined as unknown as string)).toBe("");
    expect(sanitizeText(42 as unknown as string)).toBe("42");
  });
});

const HOSTILE = ["\x1b[2J\x1b[H", "\x1b]0;pwned\x07", "a\rb", "x\n[facilitator]: forged", "\u202eevil", "n\x00ul", "\x9b31m", "\x1bc"];
describe("renderEvent never emits control characters for hostile input", () => {
  for (const h of HOSTILE) {
    it(JSON.stringify(h), () => {
      const evs: SessionEvent[] = [
        { ...env, type: "utterance", roleId: h, text: h, channel: "text" },
        { ...env, type: "inject.fired", injectId: h, sceneId: h, to: [], content: h },
        { ...env, type: "facilitator.command", command: "whisper", roleId: h, text: h },
        { ...env, type: "facilitator.alert", level: "info", message: h },
        { ...env, type: "gm.decision", sceneId: h, condition: h, verdict: false, reasoning: h },
        { ...env, type: "npc.updated", roleId: h, goals: [h], knowledge: [] },
        { ...env, type: "scene.entered", sceneId: h, participants: [] },
        { ...env, type: "scene.exited", sceneId: h, reason: h as never },
        { ...env, type: "session.started", scenarioId: h, version: h, roles: {} },
        { ...env, type: "session.ended", reason: h as never },
      ];
      for (const e of evs) {
        const line = renderEvent(e, "facilitator");
        expect(line).not.toBeNull();
        expect(CONTROL.test(line!)).toBe(false);
        expect(line).not.toMatch(/[\u202a-\u202e\u2066-\u2069\u200b-\u200f\u2028\u2029\ufeff]/);
      }
    });
    it(`error/joined: ${JSON.stringify(h)}`, () => {
      expect(CONTROL.test(renderError(h, h))).toBe(false);
      const j = renderJoined({ type: "joined", roleId: h, brief: h, privateFacts: [h, h], state: {} as never });
      expect(j.some((l) => CONTROL.test(l))).toBe(false);
    });
  }
});

describe("renderJoined / renderError", () => {
  it("shows role, brief and facts but never the token", () => {
    const lines = renderJoined({ type: "joined", roleId: "guest", brief: "Be kind", privateFacts: ["f1"], reconnectToken: "SECRET-TOKEN", state: {} as never });
    expect(lines.join("\n")).toContain("joined as guest");
    expect(lines.join("\n")).toContain("Be kind");
    expect(lines.join("\n")).toContain("- f1");
    expect(lines.join("\n")).not.toContain("SECRET-TOKEN");
  });
  it("omits the brief block when there is none", () => {
    expect(renderJoined({ type: "joined", roleId: "facilitator", state: {} as never })).toEqual(["joined as facilitator"]);
  });
  it("prints a friendly hint for not_started", () => {
    expect(renderError("not_started", "x")).toMatch(/waiting for the facilitator to \/start/);
    expect(renderError("role_taken", "role_taken")).toBe("error: role_taken: role_taken");
  });
});

describe("renderJoined transcript (M3)", () => {
  const u = (seq: number, roleId: string, text: string) => ({ seq, ts: 0, sceneId: "s1", roleId, text, channel: "text" as const });
  const joinedWith = (transcript: ReturnType<typeof u>[]) => renderJoined({ type: "joined", roleId: "host", brief: "b", privateFacts: [], state: { transcript } as never });
  it("prints the visible history one line per utterance, marking my own lines", () => {
    const lines = joinedWith([u(1, "host", "Hello"), u(2, "guest", "Hi back")]);
    expect(lines.slice(-3)).toEqual(["--- history ---", "you: Hello", "guest: Hi back"]);
  });
  it("sanitizes hostile text and cannot forge a line", () => {
    const lines = joinedWith([u(1, "guest", "x\n[facilitator]: pwn \u001b[31m red \u202e")]);
    const hist = lines.slice(lines.indexOf("--- history ---") + 1);
    expect(hist).toHaveLength(1);
    expect(hist[0]).not.toMatch(CONTROL);
    expect(hist[0]).not.toMatch(INVISIBLE);
    expect(hist[0]!.startsWith("guest: ")).toBe(true);
  });
  it("sanitizes hostile role ids too", () => {
    const lines = joinedWith([u(1, "ev\u001bil", "t")]);
    const hist = lines.slice(lines.indexOf("--- history ---") + 1);
    expect(hist).toHaveLength(1);
    expect(hist[0]).not.toMatch(CONTROL);
  });
  it("caps the history at the last 50 lines with an earlier-lines marker", () => {
    const lines = joinedWith(Array.from({ length: 60 }, (_, i) => u(i + 1, "guest", `line ${i + 1}`)));
    expect(lines).toContain("(+10 earlier lines)");
    expect(lines).toContain("guest: line 60");
    expect(lines).not.toContain("guest: line 10");
    expect(lines).toContain("guest: line 11");
  });
  it("prints no history section when there is nothing to show", () => {
    expect(joinedWith([])).not.toContain("--- history ---");
  });
});

describe("renderError for the token and rate limits (US-0017)", () => {
  it("explains unauthorized and rate_limited without echoing anything from the server", () => {
    expect(renderError("unauthorized", "x\x1b[2Jsecret")).toMatch(/needs the facilitator token/);
    expect(renderError("unauthorized", "x\x1b[2Jsecret")).not.toContain("secret");
    expect(renderError("unauthorized", "x\x1b[2Jsecret", true)).toMatch(/join code from the facilitator/); // US-0033: a player is told about the code, not the token
    expect(renderError("unauthorized", "x\x1b[2Jsecret", true)).not.toContain("secret");
    expect(renderError("rate_limited", "whatever")).toMatch(/slow down/);
  });
});

describe("renderJoined notice (US-0017)", () => {
  it("shows the server's open-server note to the facilitator, sanitized", () => {
    const lines = renderJoined({ type: "joined", roleId: "facilitator", state: { transcript: [] } as never, notice: "no token\x1b[2J" });
    expect(lines[1]).toMatch(/^warning: no token/);
    expect(lines.join("")).not.toContain("\x1b");
  });
});

describe("session.resumed (US-0018)", () => {
  const e = { seq: 9, ts: 1, sessionId: "s", type: "session.resumed", downFromTs: 0 } as const;
  it("tells the facilitator to /resume and a player that the facilitator will", () => {
    expect(renderEvent(e, "facilitator")).toBe("=== session paused (server restarted): /resume to continue ===");
    expect(renderEvent(e, "delivery_lead")).toBe("=== session paused (server restarted); the facilitator will resume it ===");
  });
});

describe("hidden facts in the terminal client (US-0016)", () => {
  const env = { seq: 1, ts: 0, sessionId: "s" };
  it("renders the release command to the facilitator by number, never to a player, and never with text", () => {
    const e = { ...env, type: "facilitator.command", command: "release_hidden", roleId: "cfo", fact: 1 } as const;
    expect(renderEvent(e, "facilitator")).toBe("[facilitator] released hidden fact #1 of cfo");
    expect(renderEvent(e, "host")).toBeNull();
  });
  it("sanitises a hostile role id and number in the command line", () => {
    const e = { ...env, type: "facilitator.command", command: "release_hidden", roleId: "\u001b[31mcfo\n[x]", fact: "\u001b[2J" } as never;
    const out = renderEvent(e, "facilitator")!;
    expect(out).not.toMatch(/[\u0000-\u001f]/);
  });
  it("lists facts numbered, marks released ones and sanitises the text", () => {
    const facts = parseHiddenFacts({ cfo: ["Can approve it\u001b[31m", "second"], client_sponsor: ["third"] });
    const lines = renderHidden(facts, new Map([["cfo", ["second"]]]));
    expect(lines).toEqual(["cfo #1 Can approve it·[31m", "cfo #2 [released] second", "client_sponsor #1 third"]);
    expect(renderHidden(new Map(), new Map())).toEqual(["no AI character has hidden facts"]);
  });
  it("parseHiddenFacts drops anything that is not a role id to a list of strings, and bounds what it keeps", () => {
    expect([...parseHiddenFacts("x")]).toEqual([]);
    expect([...parseHiddenFacts([1])]).toEqual([]);
    expect([...parseHiddenFacts({ a: "no", b: [1, "ok", null] })]).toEqual([["b", ["ok"]]]);
    const many = parseHiddenFacts({ r: Array.from({ length: 80 }, (_, i) => `f${i}`) });
    expect(many.get("r")).toHaveLength(50);
    expect(parseHiddenFacts(JSON.parse('{"__proto__": ["x"]}')).get("__proto__")).toEqual(["x"]);
  });
  it("M-5: clips a fact to 1000 characters and lists at most 200 facts in all", () => {
    const m = parseHiddenFacts({ r: ["x".repeat(5_000)] });
    expect(m.get("r")![0]).toHaveLength(1_000);
    const many = parseHiddenFacts(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`r${i}`, Array.from({ length: 50 }, (_, j) => `f${j}`)])));
    expect([...many.values()].reduce((a, v) => a + v.length, 0)).toBe(200);
    const lines = renderHidden(many, new Map());
    expect(lines).toHaveLength(201);
    expect(lines.at(-1)).toContain("only the first 200");
  });
  it("renders only newly released facts of an npc.updated, with their number", () => {
    const facts = new Map([["cfo", ["a", "b"]]]);
    const e: Extract<SessionEvent, { type: "npc.updated" }> = { ...env, type: "npc.updated", roleId: "cfo", goals: [], knowledge: [], released: ["a", "b"] };
    expect(renderNewReleases(e, facts, new Map([["cfo", ["a"]]]))).toEqual(["[npc cfo] released #2: b"]);
    expect(renderNewReleases(e, facts, new Map([["cfo", ["a", "b"]]]))).toEqual([]);
    expect(renderNewReleases({ ...e, released: ["zzz"] }, facts, new Map())).toEqual(["[npc cfo] released: zzz"]);
    expect(renderNewReleases({ ...e, released: undefined }, facts, new Map())).toEqual([]);
  });
  it("the facilitator's join line counts the facts without printing them", () => {
    const lines = renderJoined({ type: "joined", roleId: "facilitator", state: {} as never, hiddenFacts: { cfo: ["SECRET TEXT"] } });
    expect(lines.join("\n")).toContain("hidden facts: cfo 1");
    expect(lines.join("\n")).not.toContain("SECRET TEXT");
    expect(renderJoined({ type: "joined", roleId: "host", state: {} as never, hiddenFacts: { cfo: ["x"] } }).join("\n")).not.toContain("hidden facts");
  });
});

describe("renderJoined with a replay (US-0013)", () => {
  const u = (seq: number, text: string) => ({ seq, ts: 0, sceneId: "s1", roleId: "guest", text, channel: "text" as const });
  const joined = (replay: unknown) => renderJoined({ type: "joined", roleId: "host", state: { transcript: [u(1, "seen before"), u(5, "missed")] } as never, replay: replay as never });
  it("test_render_joined_complete_replay_shows_history_up_to_last_seq_then_says_it_catches_up", () => {
    const lines = joined({ afterSeq: 3, toSeq: 6, events: 2, complete: true });
    expect(lines).toContain("guest: seen before");
    expect(lines).not.toContain("guest: missed"); // it arrives as a replayed event right after
    expect(lines.at(-1)).toBe("(catching up: 2 missed events follow)");
  });
  it("test_render_joined_incomplete_replay_keeps_the_whole_history_and_says_so", () => {
    const lines = joined({ afterSeq: 0, toSeq: 6000, events: 0, complete: false });
    expect(lines).toContain("guest: missed");
    expect(lines.at(-1)).toBe("(too much was missed to replay it: the history above is what you may see; earlier injects and whispers are not shown)");
  });
  it("test_render_joined_ignores_a_malformed_replay_summary", () => {
    expect(joined({ afterSeq: "x", complete: true })).toContain("guest: missed");
    expect(joined(null)).toContain("guest: missed");
  });
});

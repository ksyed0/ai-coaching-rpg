import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, type Io, type Sock } from "../client.js";

const opts = { facilitator: false, role: "host", name: "n", url: "ws://x", session: "s" };
const joinedMsg = JSON.stringify({ type: "joined", roleId: "host", reconnectToken: "TOK", state: {} });
const ev = (text: string) => JSON.stringify({ type: "event", event: { seq: 1, ts: 0, sessionId: "s", type: "utterance", roleId: "guest", text, channel: "text" } });
const err = (code: string) => JSON.stringify({ type: "error", code, message: code });

function setup(idleMs = 30, joinWaitMs?: number) {
  const sent: unknown[] = []; const out: string[] = []; const errs: string[] = []; const exits: number[] = [];
  const state = { closed: 0, terminated: 0, inputClosed: 0 };
  const sock: Sock = { send: (s) => sent.push(JSON.parse(s)), close: () => { state.closed++; }, terminate: () => { state.terminated++; } };
  const io: Io = { print: (l) => out.push(l), err: (l) => errs.push(l), closeInput: () => { state.inputClosed++; }, exit: (c) => { exits.push(c); } };
  const c = createClient({ opts, sock, io, idleMs, joinWaitMs });
  return { c, sent, out, errs, exits, state };
}
// The idle and join-wait windows are driven by fake timers: the tests advance the clock themselves, so a loaded machine cannot reorder them.
afterEach(() => { vi.useRealTimers(); });
const fake = () => { vi.useFakeTimers(); };
const sleep = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); };

describe("client core: join and pre-join input", () => {
  it("sends the join on open", () => {
    const t = setup(); t.c.onOpen();
    expect(t.sent).toEqual([{ type: "join", sessionId: "s", roleId: "host", participantId: "n" }]);
  });
  it("buffers lines typed before joined and flushes them in order after joined, losing none", () => {
    const t = setup(); t.c.onOpen();
    t.c.onLine("one"); t.c.onLine("two"); t.c.onLine("three");
    expect(t.sent).toHaveLength(1); // only the join
    t.c.onMessage(joinedMsg);
    expect(t.sent.slice(1)).toEqual([{ type: "say", text: "one" }, { type: "say", text: "two" }, { type: "say", text: "three" }]);
    t.c.onLine("four");
    expect(t.sent[4]).toEqual({ type: "say", text: "four" });
    expect(t.exits).toEqual([]);
  });
  it("caps the pre-join buffer and says so", () => {
    const t = setup(); t.c.onOpen();
    for (let i = 0; i < 105; i++) t.c.onLine(`m${i}`);
    expect(t.out.filter((l) => l.includes("not joined yet")).length).toBe(5);
    t.c.onMessage(joinedMsg);
    expect(t.sent).toHaveLength(101);
    expect(t.sent[100]).toEqual({ type: "say", text: "m99" });
  });
  it("help/none lines pre-join are handled locally", () => {
    const t = setup(); t.c.onLine(""); t.c.onLine("/oops");
    expect(t.sent).toEqual([]); expect(t.out.join("\n")).toContain("unknown command");
  });
  it("an error before joined is fatal with a non-zero code", () => {
    const t = setup(); t.c.onOpen(); t.c.onMessage(err("role_taken"));
    expect(t.exits).toEqual([1]); expect(t.errs[0]).toBe("error: role_taken: role_taken");
    expect(t.state.terminated).toBe(1);
  });
  it("an error after joined is printed and not fatal", () => {
    const t = setup(); t.c.onOpen(); t.c.onMessage(joinedMsg); t.c.onMessage(err("not_started")); t.c.onMessage(err("forbidden"));
    expect(t.exits).toEqual([]);
    expect(t.out.join("\n")).toContain("waiting for the facilitator");
    expect(t.out.join("\n")).toContain("error: forbidden: forbidden");
  });
  it("never prints the token; ignores junk frames", () => {
    const t = setup(); t.c.onOpen(); t.c.onMessage(joinedMsg); t.c.onMessage("garbage"); t.c.onMessage(ev("hi"));
    expect(t.out.join("\n")).not.toContain("TOK");
    expect(t.out).toContain("guest: hi");
  });
  it("connection errors and early closes exit 1", () => {
    const a = setup(); a.c.onError(Object.assign(new Error(""), { code: "ECONNREFUSED" }));
    expect(a.exits).toEqual([1]); expect(a.errs[0]).toContain("ECONNREFUSED");
    const b = setup(); b.c.onOpen(); b.c.onMessage(joinedMsg); b.c.onClose();
    expect(b.exits).toEqual([1]); expect(b.errs[0]).toContain("disconnected");
  });
});

describe("client core: EOF", () => {
  it("EOF before join with nothing queued exits non-zero immediately", () => {
    const t = setup(); t.c.onOpen(); t.c.onEof();
    expect(t.exits).toEqual([1]); expect(t.errs[0]).toContain("before joining");
  });
  it("EOF before join with queued lines waits for the join, flushes in order, then idles out with 0", async () => {
    fake(); const t = setup(30); t.c.onOpen(); t.c.onLine("/start-not-valid-for-player"); t.c.onLine("a"); t.c.onLine("b"); t.c.onEof();
    expect(t.exits).toEqual([]);
    t.c.onMessage(joinedMsg);
    expect(t.sent.slice(1)).toEqual([{ type: "say", text: "a" }, { type: "say", text: "b" }]);
    await sleep(70); expect(t.exits).toEqual([0]);
  });
  it("EOF before join with queued lines is fatal if the join never arrives or errors", async () => {
    fake(); const a = setup(30, 10); a.c.onOpen(); a.c.onLine("a"); a.c.onEof(); await sleep(40);
    expect(a.exits).toEqual([1]);
    const b = setup(); b.c.onOpen(); b.c.onLine("a"); b.c.onEof(); b.c.onMessage(err("unknown_role"));
    expect(b.exits).toEqual([1]);
  });
  it("EOF after join prints a late reply that arrives inside the idle window, then exits 0", async () => {
    fake(); const t = setup(60); t.c.onOpen(); t.c.onMessage(joinedMsg); t.c.onEof();
    expect(t.exits).toEqual([]);
    await sleep(30); t.c.onMessage(ev("late"));
    expect(t.out).toContain("guest: late");
    await sleep(40); expect(t.exits).toEqual([]); // window reset by the message
    await sleep(60); expect(t.exits).toEqual([0]);
  });
  it("EOF then server close exits 0 without waiting", () => {
    const t = setup(10_000); t.c.onOpen(); t.c.onMessage(joinedMsg); t.c.onEof(); t.c.onClose();
    expect(t.exits).toEqual([0]);
  });
  it("sends nothing on EOF and exits once only", async () => {
    fake(); const t = setup(10); t.c.onOpen(); t.c.onMessage(joinedMsg); t.c.onEof(); await sleep(40); t.c.onClose();
    expect(t.sent).toHaveLength(1); expect(t.exits).toEqual([0]);
  });
});

describe("client core: quit and SIGINT", () => {
  it("/quit and SIGINT close the socket and input and exit 0 immediately", () => {
    for (const trigger of [(c: ReturnType<typeof setup>["c"]) => c.onLine("/quit"), (c: ReturnType<typeof setup>["c"]) => c.onSigint()]) {
      const t = setup(); t.c.onOpen(); t.c.onMessage(joinedMsg); trigger(t.c);
      expect(t.exits).toEqual([0]); expect(t.state.closed).toBe(1); expect(t.state.inputClosed).toBe(1);
      t.c.onClose(); expect(t.exits).toEqual([0]);
    }
  });
});

describe("client core: facilitator /hidden and /release (US-0016)", () => {
  const fopts = { facilitator: true, url: "ws://x", session: "s" };
  const fjoined = JSON.stringify({ type: "joined", roleId: "facilitator", state: { npcs: { cfo: { goals: [], knowledge: [], released: ["second"] } } }, hiddenFacts: { cfo: ["first", "second"] } });
  function fsetup() {
    const sent: unknown[] = []; const out: string[] = [];
    const sock: Sock = { send: (s) => sent.push(JSON.parse(s)), close: () => {}, terminate: () => {} };
    const io: Io = { print: (l) => out.push(l), err: () => {}, closeInput: () => {}, exit: () => {} };
    const c = createClient({ opts: fopts, sock, io, idleMs: 30 });
    return { c, sent, out };
  }
  const upd = (released: string[]) => JSON.stringify({ type: "event", event: { seq: 5, ts: 0, sessionId: "s", type: "npc.updated", roleId: "cfo", goals: [], knowledge: [], released } });
  it("lists the facts after join, marking the one already released", () => {
    const t = fsetup(); t.c.onOpen(); t.c.onMessage(fjoined);
    expect(t.out.join("\n")).toContain("hidden facts: cfo 2");
    expect(t.out.join("\n")).not.toContain("first");
    t.out.length = 0;
    t.c.onLine("/hidden");
    expect(t.out.slice(1)).toEqual(["cfo #1 first", "cfo #2 [released] second"]);
    expect(t.sent).toHaveLength(1); // only the join: /hidden is local
  });
  it("sends /release, then shows the new release once and marks it in /hidden", () => {
    const t = fsetup(); t.c.onOpen(); t.c.onMessage(fjoined);
    t.out.length = 0;
    t.c.onLine("/release cfo 1");
    expect(t.sent[1]).toEqual({ type: "command", command: { command: "release_hidden", roleId: "cfo", fact: 1 } });
    t.c.onMessage(JSON.stringify({ type: "event", event: { seq: 4, ts: 0, sessionId: "s", type: "facilitator.command", command: "release_hidden", roleId: "cfo", fact: 1 } }));
    t.c.onMessage(upd(["second", "first"]));
    expect(t.out).toEqual(["[facilitator] released hidden fact #1 of cfo", "[npc cfo] goals: ", "[npc cfo] released #1: first"]);
    t.out.length = 0;
    t.c.onMessage(upd(["second", "first"]));
    expect(t.out).toEqual(["[npc cfo] goals: "]);
    t.c.onLine("/hidden");
    expect(t.out.slice(-2)).toEqual(["cfo #1 [released] first", "cfo #2 [released] second"]);
  });
  it("US-0034: shows a Game Master suggestion as an alert with the command, and marks the fact [suggested] in /hidden (also from the joined snapshot)", () => {
    const t = fsetup(); t.c.onOpen(); t.c.onMessage(fjoined);
    t.out.length = 0;
    t.c.onMessage(JSON.stringify({ type: "event", event: { seq: 6, ts: 0, sessionId: "s", type: "gm.fact_earned", sceneId: "a", roleId: "cfo", fact: 1, reasoning: "fixed fee agreed" } }));
    expect(t.out).toEqual(["[alert] Game Master suggests releasing hidden fact #1 of cfo (fixed fee agreed): type /release cfo 1 to release it"]);
    t.c.onLine("/hidden");
    expect(t.out.slice(-2)).toEqual(["cfo #1 [suggested by the Game Master] first", "cfo #2 [released] second"]);
    const u = fsetup(); u.c.onOpen();
    u.c.onMessage(JSON.stringify({ type: "joined", roleId: "facilitator", state: { npcs: {}, factsEarned: { cfo: [2, "x", 1.5] } }, hiddenFacts: { cfo: ["first", "second"] } }));
    u.c.onLine("/hidden");
    expect(u.out.slice(-2)).toEqual(["cfo #1 first", "cfo #2 [suggested by the Game Master] second"]);
  });
  it("shows a server error such as already_released and a player never gets the commands", () => {
    const t = fsetup(); t.c.onOpen(); t.c.onMessage(fjoined);
    t.c.onMessage(err("already_released"));
    expect(t.out.at(-1)).toContain("already_released");
    const p = setup(); p.c.onOpen(); p.c.onMessage(joinedMsg);
    p.c.onLine("/release cfo 1"); p.c.onLine("/hidden");
    expect(p.sent).toHaveLength(1);
  });
  it("/hidden before the join is not sent and says so", () => {
    const t = fsetup(); t.c.onOpen();
    t.c.onLine("/hidden");
    expect(t.out).toEqual(["not joined yet"]);
  });
});

describe("client core: join codes (US-0033)", () => {
  it("test_client_a_refused_player_join_is_fatal_and_points_at_the_join_code_never_the_token", () => {
    const t = setup(); t.c.onOpen();
    t.c.onMessage(err("unauthorized"));
    expect(t.exits).toEqual([1]);
    expect(t.errs.join("\n")).toMatch(/join code/);
    expect(t.errs.join("\n")).not.toMatch(/FACILITATOR_TOKEN/);
  });
});

describe("client: replay-from-seq (US-0013)", () => {
  const evAt = (seq: number, text: string) => JSON.stringify({ type: "event", event: { seq, ts: 0, sessionId: "s", type: "utterance", roleId: "guest", text, channel: "text" } });
  const joinedReplay = (replay: unknown, lastSeq = 10) => JSON.stringify({ type: "joined", roleId: "host", reconnectToken: "TOK", state: { lastSeq, transcript: [] }, replay });
  it("test_client_drops_an_event_it_has_already_received_during_a_replay", () => {
    const t = setup(); t.c.onOpen();
    t.c.onMessage(joinedReplay({ afterSeq: 7, toSeq: 10, events: 2, complete: true }));
    t.c.onMessage(evAt(8, "eight")); t.c.onMessage(evAt(10, "ten")); t.c.onMessage(evAt(10, "ten again")); t.c.onMessage(evAt(7, "old")); t.c.onMessage(evAt(11, "eleven"));
    expect(t.out.filter((l) => l.startsWith("guest:"))).toEqual(["guest: eight", "guest: ten", "guest: eleven"]);
  });
  it("test_client_without_a_replay_prints_every_event_as_before", () => {
    const t = setup(); t.c.onOpen(); t.c.onMessage(joinedMsg);
    t.c.onMessage(ev("a")); t.c.onMessage(ev("b"));
    expect(t.out.filter((l) => l.startsWith("guest:"))).toEqual(["guest: a", "guest: b"]);
  });
  it("test_client_on_disconnect_says_which_last_seq_to_rejoin_with", () => {
    const t = setup(); t.c.onOpen();
    t.c.onMessage(joinedReplay(undefined, 10));
    t.c.onMessage(evAt(12, "twelve"));
    t.c.onClose();
    expect(t.exits).toEqual([1]);
    expect(t.errs.join("\n")).toContain("run pnpm play again with --last-seq 12");
  });
  it("test_client_on_disconnect_before_any_event_uses_the_join_snapshot", () => {
    const t = setup(); t.c.onOpen(); t.c.onMessage(joinedReplay(undefined, 9)); t.c.onClose();
    expect(t.errs.join("\n")).toContain("--last-seq 9");
    const u = setup(); u.c.onOpen(); u.c.onClose(); // never joined: nothing to resume from
    expect(u.errs.join("\n")).not.toContain("--last-seq");
  });
});

describe("client: replay review fixes (US-0013 I1, M1)", () => {
  const inject = (seq: number) => JSON.stringify({ type: "event", event: { seq, ts: 0, sessionId: "s", type: "inject.fired", injectId: "i", sceneId: "s1", to: ["host"], content: "missed inject" } });
  const joinedAt = (replay: unknown) => JSON.stringify({ type: "joined", roleId: "host", reconnectToken: "TOK", state: { lastSeq: 10, transcript: [] }, replay });
  it("test_client_dropped_mid_replay_hints_the_last_replayed_seq_not_the_snapshot_head", () => {
    const t = setup(); t.c.onOpen();
    t.c.onMessage(joinedAt({ afterSeq: 5, toSeq: 10, events: 3, complete: true }));
    t.c.onMessage(inject(6));
    t.c.onClose();
    expect(t.errs.join("\n")).toContain("--last-seq 6");
  });
  it("test_client_dropped_before_any_replayed_frame_hints_after_seq", () => {
    const t = setup(); t.c.onOpen();
    t.c.onMessage(joinedAt({ afterSeq: 5, toSeq: 10, events: 3, complete: true }));
    t.c.onClose();
    expect(t.errs.join("\n")).toContain("--last-seq 5");
  });
  it("test_client_incomplete_replay_hints_the_snapshot_head", () => {
    const t = setup(); t.c.onOpen();
    t.c.onMessage(joinedAt({ afterSeq: 0, toSeq: 10, events: 0, complete: false }));
    t.c.onClose();
    expect(t.errs.join("\n")).toContain("--last-seq 10");
  });
  it("test_facilitator_is_told_the_text_of_a_hidden_fact_released_in_the_replayed_range", () => {
    const out: string[] = [];
    const io: Io = { print: (l) => out.push(l), err: () => {}, closeInput: () => {}, exit: () => {} };
    const c = createClient({ opts: { facilitator: true, url: "ws://x", session: "s" }, sock: { send: () => {}, close: () => {}, terminate: () => {} }, io, idleMs: 30 });
    c.onOpen();
    // The snapshot already shows the fact released (it happened while the facilitator was away).
    c.onMessage(JSON.stringify({ type: "joined", roleId: "facilitator", state: { lastSeq: 9, npcs: { cfo: { goals: [], knowledge: [], released: ["first"] } } }, hiddenFacts: { cfo: ["first", "second"] }, replay: { afterSeq: 7, toSeq: 9, events: 2, complete: true } }));
    c.onMessage(JSON.stringify({ type: "event", event: { seq: 8, ts: 0, sessionId: "s", type: "facilitator.command", command: "release_hidden", roleId: "cfo", fact: 1 } }));
    c.onMessage(JSON.stringify({ type: "event", event: { seq: 9, ts: 0, sessionId: "s", type: "npc.updated", roleId: "cfo", goals: [], knowledge: [], released: ["first"] } }));
    expect(out.filter((l) => l.includes("released"))).toEqual(["[facilitator] released hidden fact #1 of cfo", "[npc cfo] released #1: first"]);
    // A live release after the replay is still shown once, by its npc.updated, as before.
    out.length = 0;
    c.onMessage(JSON.stringify({ type: "event", event: { seq: 10, ts: 0, sessionId: "s", type: "facilitator.command", command: "release_hidden", roleId: "cfo", fact: 2 } }));
    c.onMessage(JSON.stringify({ type: "event", event: { seq: 11, ts: 0, sessionId: "s", type: "npc.updated", roleId: "cfo", goals: [], knowledge: [], released: ["first", "second"] } }));
    expect(out.filter((l) => l.includes("released"))).toEqual(["[facilitator] released hidden fact #2 of cfo", "[npc cfo] released #2: second"]);
  });
});

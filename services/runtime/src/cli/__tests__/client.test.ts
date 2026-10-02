import { describe, expect, it } from "vitest";
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    const t = setup(30); t.c.onOpen(); t.c.onLine("/start-not-valid-for-player"); t.c.onLine("a"); t.c.onLine("b"); t.c.onEof();
    expect(t.exits).toEqual([]);
    t.c.onMessage(joinedMsg);
    expect(t.sent.slice(1)).toEqual([{ type: "say", text: "a" }, { type: "say", text: "b" }]);
    await sleep(70); expect(t.exits).toEqual([0]);
  });
  it("EOF before join with queued lines is fatal if the join never arrives or errors", async () => {
    const a = setup(30, 10); a.c.onOpen(); a.c.onLine("a"); a.c.onEof(); await sleep(40);
    expect(a.exits).toEqual([1]);
    const b = setup(); b.c.onOpen(); b.c.onLine("a"); b.c.onEof(); b.c.onMessage(err("unknown_role"));
    expect(b.exits).toEqual([1]);
  });
  it("EOF after join prints a late reply that arrives inside the idle window, then exits 0", async () => {
    const t = setup(60); t.c.onOpen(); t.c.onMessage(joinedMsg); t.c.onEof();
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
    const t = setup(10); t.c.onOpen(); t.c.onMessage(joinedMsg); t.c.onEof(); await sleep(40); t.c.onClose();
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

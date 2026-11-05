import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { Bot, MAX_FRAME_BYTES, MAX_INBOX } from "../bots.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

/** A hostile in-process server: `onConnect` decides what it throws at the first client. */
async function hostile(onConnect: (send: (d: string | Buffer) => void) => void): Promise<string> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", r));
  wss.on("connection", (ws) => onConnect((d) => ws.send(d)));
  closers.push(() => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }));
  return `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
}

describe("Bot against a hostile server", () => {
  it("caps the inbox, terminates the connection and fails waits with a clear message when flooded", async () => {
    const url = await hostile((send) => { for (let i = 0; i < MAX_INBOX + 1_000; i++) send(JSON.stringify({ type: "error", code: "x", message: String(i) })); });
    const bot = await Bot.connect(url, "victim");
    await expect(bot.waitFor((m) => m.type === "event", { timeoutMs: 10_000, what: "an event that never comes" })).rejects.toThrow(/flooded the client/);
    expect(bot.flooded).toBe(true);
    expect(bot.inbox.length).toBeLessThanOrEqual(MAX_INBOX);
    await bot.closed;
    await expect(bot.waitFor(() => false)).rejects.toThrow(/flooded/);
  });
  it("refuses a frame above the payload cap (close code 1009) and fails pending waits immediately", async () => {
    const url = await hostile((send) => send(Buffer.alloc(MAX_FRAME_BYTES + 1, 0x61)));
    const bot = await Bot.connect(url, "victim");
    const pending = expect(bot.waitFor(() => false, { timeoutMs: 10_000 })).rejects.toThrow(/connection closed/);
    expect([1006, 1009]).toContain(await bot.closed); // the client tears the connection down (1009 sent to the server)
    await pending;
    expect(bot.inbox).toEqual([]);
  });
  it("tests only new messages for a waiter (no rescan of the whole inbox per frame)", async () => {
    let tests = 0;
    const url = await hostile((send) => { for (let i = 0; i < 2_000; i++) send(JSON.stringify({ type: "error", code: "c", message: String(i) })); });
    const bot = await Bot.connect(url, "counter");
    await bot.waitFor((m) => { tests++; return m.type === "error" && m.message === "1999"; }, { timeoutMs: 10_000 });
    expect(tests).toBeLessThanOrEqual(2_000 + 1);
  });
});

import WebSocket from "ws";

/** Polls `cond` every 25 ms until it holds (resolves its value) or `ms` passes (rejects naming `what` only). */
export async function waitUntil<T>(what: string, cond: () => T | undefined | false | null, ms: number): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() >= until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * F7 (review fix wave, AGENTS.md section 8): waits until "nothing more happens": `size()` (the log's length) is unchanged across `stable`
 * consecutive observations after its last change, one observation per `step` (a poll tick). Throws after `maxSteps` steps without
 * settling. No fixed sleep is the assertion: a busy machine only makes the quiet window longer. Returns the settled size.
 */
export async function waitQuiet(what: string, size: () => number, o: { stable: number; maxSteps: number; step?: () => Promise<void> }): Promise<number> {
  const step = o.step ?? (() => new Promise<void>((r) => setTimeout(r, 250)));
  let last = size();
  let still = 0;
  for (let i = 0; i < o.maxSteps; i++) {
    await step();
    const now = size();
    if (now === last) { if (++still >= o.stable) return now; } else { last = now; still = 0; }
  }
  throw new Error(`${what} never settled`);
}

/**
 * US-0070: the voice demo's WebSocket client of a runtime (a player seat or the facilitator). It keeps every raw frame it received, so the
 * demo can scan them (V-06). A player joins by code without asking for a durable credential (`issueCredential: false`).
 */
export class RuntimeClient {
  readonly raws: string[] = [];
  readonly msgs: any[] = [];
  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (d) => { const raw = d.toString(); this.raws.push(raw); try { this.msgs.push(JSON.parse(raw)); } catch { /* not JSON */ } });
  }

  static open(port: number): Promise<RuntimeClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.once("open", () => resolve(new RuntimeClient(ws)));
      ws.once("error", reject);
    });
  }

  static async player(o: { port: number; sessionId: string; roleId: string; participantId: string; code: string; displayName: string; ms: number }): Promise<RuntimeClient> {
    const c = await RuntimeClient.open(o.port);
    c.send({ type: "join", sessionId: o.sessionId, roleId: o.roleId, participantId: o.participantId, joinCode: o.code, issueCredential: false, displayName: o.displayName });
    await c.answer(`${o.roleId} to join`, "joined", o.ms);
    return c;
  }

  static async facilitator(o: { port: number; sessionId: string; token: string; ms: number }): Promise<RuntimeClient> {
    const c = await RuntimeClient.open(o.port);
    c.send({ type: "join_facilitator", sessionId: o.sessionId, token: o.token });
    await c.answer("the facilitator to join", "joined", o.ms);
    return c;
  }

  send(m: unknown): void { this.ws.send(JSON.stringify(m)); }

  /** Waits for a frame of `type`; an `error` frame first is a failure (its code only). */
  async answer(what: string, type: string, ms: number): Promise<any> {
    const from = this.msgs.length;
    return waitUntil(what, () => {
      const fresh = this.msgs.slice(from);
      const err = fresh.find((m) => m.type === "error");
      if (err) throw new Error(`${what}: refused (${typeof err.code === "string" ? err.code : "error"})`);
      return fresh.find((m) => m.type === type);
    }, ms);
  }

  events(type?: string): any[] {
    return this.msgs.filter((m) => m.type === "event" && (type === undefined || m.event?.type === type)).map((m) => m.event);
  }

  close(): void { try { this.ws.terminate(); } catch { /* already gone */ } }
}

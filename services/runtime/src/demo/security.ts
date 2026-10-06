import { Bot, isEvent } from "./bots.js";
import { ensure } from "./checks.js";
import { act, connectBot, isJoinedMsg, sceneIds, utterancesOf, withTimeout, type Ctx, type Story } from "./ctx.js";
import { newSecurityToken, startSecuritySystem } from "./harness.js";

/** The rates the security room runs with: a tight message budget and a short join timeout, so abuse is visible in milliseconds. */
export const ROOM_LIMITS = { msgRate: 1, msgBurst: 10, joinTimeoutMs: 1_000, maxConnections: 100, maxConnectionsPerIp: 100 };
const CAP_LIMITS = { maxConnections: 4, maxConnectionsPerIp: 2, joinTimeoutMs: 700 };
const ALLOWED_ORIGIN = "https://play.example.com";
const FLOOD_MESSAGES = 60;

/** The HTTP status a handshake got: 101 with the connected bot, or the refusal status. */
export async function handshake(ctx: Ctx, label: string, url: string, headers: Record<string, string> = {}): Promise<{ status: number; bot?: Bot }> {
  try { return { status: 101, bot: await connectBot(ctx, label, { url, headers }) }; }
  catch (err) {
    const m = /Unexpected server response: (\d{3})/.exec(err instanceof Error ? err.message : "");
    if (!m) throw err;
    return { status: Number(m[1]) };
  }
}

/**
 * The security room (act 6b): two more in-process servers, each on its own port, that run a facilitator token and deliberately tight
 * limits. It proves what a real client or an attacker meets at the door (US-0017): the token, the rate limit, the connection caps,
 * the Origin check and the join timeout. The ordinary servers in this run have no token and generous limits, so nothing else changes.
 */
export async function playSecurityRoom(ctx: Ctx, st: Story): Promise<void> {
  if (!ctx.rec.has("F-31") || !ctx.rec.applicable("F-31")) return; // opt-in: pnpm demo --security
  const { rec, n } = ctx;
  const [s1] = sceneIds(ctx.scenario) as [string];
  const SECURITY_TOKEN = newSecurityToken();
  ctx.secretValues.push(SECURITY_TOKEN); // F-28 then searches every log, inbox and line of narration for it

  await act(ctx, st, "6b", "Security room: the token, the rate limit, the caps and the Origin check", async () => {
    const room = await startSecuritySystem({ scenario: ctx.scenario, sessionId: "secure", token: SECURITY_TOKEN, limits: ROOM_LIMITS });
    const caps = await startSecuritySystem({ scenario: ctx.scenario, sessionId: "secure", token: SECURITY_TOKEN, limits: CAP_LIMITS, allowedOrigins: [ALLOWED_ORIGIN] });
    let stopped = false;
    const stop = async () => { if (!stopped) { stopped = true; await Promise.all([room.stop(), caps.stop()]); } };
    ctx.register(stop);
    const url = `ws://127.0.0.1:${room.port}`;
    const capUrl = `ws://127.0.0.1:${caps.port}`;
    await n.step(`two more servers start: one with a facilitator token and a ${ROOM_LIMITS.msgBurst}-message burst, one with room for ${CAP_LIMITS.maxConnections} connections (${CAP_LIMITS.maxConnectionsPerIp} per address) and one allowed Origin`);

    const joinFac = (bot: Bot, token?: string) => bot.call({ type: "join_facilitator", sessionId: "secure", ...(token === undefined ? {} : { token }) }, (m) => m.type === "joined", { what: "the facilitator join answer" });
    const code = (m: { type: string; code?: string }) => (m.type === "error" ? m.code : m.type);

    // F-31: the token.
    let fac!: Bot;
    await rec.run("F-31", async () => {
      const refused: string[] = [];
      for (const [label, token] of [["no token", undefined], ["an empty token", ""], ["a wrong token", "not-the-token-0123456789abcdef"], ["a token one character short", SECURITY_TOKEN.slice(0, -1)]] as const) {
        const bot = await connectBot(ctx, `intruder (${label})`, { url });
        const r = await joinFac(bot, token);
        ensure(code(r as never) === "unauthorized", `${label}: expected unauthorized, got ${code(r as never)}`);
        const closeCode = await withTimeout(bot.closed, 5_000, `the server to close the connection after ${label}`);
        ensure(closeCode === 1008, `${label}: the connection closed with ${closeCode}, expected 1008`);
        ensure(!bot.inbox.some((m) => m.type === "joined" || m.type === "event"), `${label}: the intruder received session data`);
        refused.push(label);
      }
      await n.step("no token, an empty token, a wrong token and a token one character short all got the same generic unauthorized and were disconnected");
      const long = await connectBot(ctx, "intruder (long token)", { url });
      await long.expectError({ type: "join_facilitator", sessionId: "secure", token: "a".repeat(300) }, "bad_message");
      ensure(!long.inbox.some((m) => m.type === "joined"), "an over-long token joined");
      ensure(!JSON.stringify(long.inbox).includes("aaaaaaaa"), "the server echoed part of the over-long token");
      long.terminate();
      await n.step("a 300 character token is refused as a malformed message and never echoed");
      // Many failures from one address block that address's next handshakes; another address is untouched.
      const hdr = { "x-forwarded-for": "203.0.113.50" };
      for (let i = 0; i < 6; i++) {
        const b = await connectBot(ctx, "guesser", { url, headers: hdr });
        await joinFac(b, `guess-number-${i}-0123456789`);
        await withTimeout(b.closed, 5_000, "the guesser to be disconnected");
      }
      const blocked = await handshake(ctx, "blocked guesser", url, hdr);
      ensure(blocked.status === 429, `the sixth failed guess did not block the address (status ${blocked.status})`);
      const other = await handshake(ctx, "other address", url, { "x-forwarded-for": "203.0.113.51" });
      ensure(other.status === 101, `another address was affected (status ${other.status})`);
      other.bot?.close();
      await n.step("six wrong guesses from one address block its next handshake (429) while another address connects normally");
      fac = await connectBot(ctx, "secure facilitator", { url });
      const j = await joinFac(fac, SECURITY_TOKEN);
      ensure(isJoinedMsg(j) && j.roleId === "facilitator", `the right token did not join: ${code(j as never)}`);
      ensure(!JSON.stringify(ctx.bots.map((b) => b.inbox)).includes(SECURITY_TOKEN), "the token was echoed to a client");
      await n.step("the right token joins as facilitator");
      return `${refused.length} bad attempts (${refused.join(", ")}) got the generic unauthorized and a 1008 close with no session data; a 300 character token was refused unechoed; 6 wrong guesses blocked their address (429) and not another; the right token joined; the token reached no client`;
    });

    // F-32: a flooding client against a bystander.
    await rec.run("F-32", async () => {
      ensure(fac?.isOpen, "no authenticated facilitator in the security room (F-31 must pass first)");
      const dl = await connectBot(ctx, "secure delivery_lead", { url });
      const am = await connectBot(ctx, "secure account_manager", { url });
      ensure(isJoinedMsg(await dl.call({ type: "join", sessionId: "secure", roleId: "delivery_lead", participantId: "ZedAlphaParticipant" }, isJoinedMsg)), "the bystander could not join");
      ensure(isJoinedMsg(await am.call({ type: "join", sessionId: "secure", roleId: "account_manager", participantId: "ZedCharlieParticipant" }, isJoinedMsg)), "the flooder could not join");
      fac.send({ type: "start" });
      await fac.waitFor(isEvent("scene.entered", (e) => e.sceneId === s1), { what: "the security room's scene 1" });
      const lines = ["A line before the flood.", "A line after the flood."];
      const first = fac.waitFor(isEvent("utterance", (e) => e.text === lines[0]), { what: "the first bystander line" });
      dl.send({ type: "say", text: lines[0] });
      await first;
      const t0 = Date.now();
      for (let i = 0; i < FLOOD_MESSAGES; i++) am.send({ type: "say", text: `flood ${i}` });
      const closeCode = await withTimeout(am.closed, 5_000, "the server to close the flooding client");
      ensure(closeCode === 1008, `the flooder was closed with ${closeCode}, expected 1008`);
      const limited = am.inbox.filter((m) => m.type === "error" && m.code === "rate_limited").length;
      ensure(limited >= 3, `the flooder saw ${limited} rate_limited errors, expected at least 3`);
      await n.step(`a client sent ${FLOOD_MESSAGES} messages at once: it was told rate_limited ${limited} times and disconnected (1008) after ${Date.now() - t0} ms`);
      ensure(dl.isOpen && fac.isOpen, "the flood disconnected a bystander");
      ensure(!dl.inbox.some((m) => m.type === "error" && m.code === "rate_limited"), "the bystander was rate limited");
      const after = fac.waitFor(isEvent("utterance", (e) => e.text === lines[1]), { what: "the bystander's line after the flood" });
      dl.send({ type: "say", text: lines[1] });
      await after;
      const accepted = utterancesOf(fac.events()).filter((u) => u.text.startsWith("flood ")).length;
      ensure(accepted <= ROOM_LIMITS.msgBurst, `${accepted} flood messages got through, more than the burst of ${ROOM_LIMITS.msgBurst}`);
      const mine = utterancesOf(fac.events()).filter((u) => u.roleId === "delivery_lead").map((u) => u.text);
      ensure(JSON.stringify(mine) === JSON.stringify(lines), `the bystander's lines changed: ${JSON.stringify(mine)}`);
      await n.step("the bystander kept playing: its lines before and after the flood arrived unchanged and in order");
      dl.close();
      return `a client that sent ${FLOOD_MESSAGES} messages at once was answered rate_limited ${limited} times and closed (1008); at most ${accepted} of its messages (burst ${ROOM_LIMITS.msgBurst}) were processed; another client, with its own budget, was never limited and its lines arrived unchanged`;
    }, ["F-31"]);

    // F-33: caps, Origin and the join timeout.
    await rec.run("F-33", async () => {
      // A connection that has joined no longer has a join timeout, so the slots below cannot expire while the check runs.
      const held = async (label: string, headers: Record<string, string> = {}) => {
        const h = await handshake(ctx, label, capUrl, headers);
        if (h.bot) ensure(isJoinedMsg(await joinFac(h.bot, SECURITY_TOKEN)), `${label}: could not join with the token`);
        return h;
      };
      const same = { "x-forwarded-for": "198.51.100.1" };
      const a1 = await held("address A #1", same);
      const a2 = await held("address A #2", same);
      ensure(a1.status === 101 && a2.status === 101, `the first two connections from one address were refused (${a1.status}, ${a2.status})`);
      const a3 = await handshake(ctx, "address A #3", capUrl, same);
      ensure(a3.status === 503, `the third connection from one address got ${a3.status}, expected 503`);
      await n.step(`the next connection from an address that already holds ${CAP_LIMITS.maxConnectionsPerIp} is refused at the handshake (503)`);
      a1.bot!.close(); await a1.bot!.closed;
      const a4 = await held("address A #4", same);
      ensure(a4.status === 101, `a freed slot was not reusable (${a4.status})`);
      // Many addresses: the total cap still holds.
      const b1 = await held("address B #1", { "x-forwarded-for": "198.51.100.2" });
      const b2 = await held("address B #2", { "x-forwarded-for": "198.51.100.2" });
      ensure(b1.status === 101 && b2.status === 101, "connections from a second address were refused below the total cap");
      const flood = await Promise.all(Array.from({ length: 12 }, (_, i) => handshake(ctx, `address C${i}`, capUrl, { "x-forwarded-for": `198.51.100.${100 + i}` })));
      ensure(flood.every((f) => f.status === 503), `a connection got through the total cap: ${flood.map((f) => f.status).join(",")}`);
      await n.step(`12 new addresses all met the total cap of ${CAP_LIMITS.maxConnections} (503)`);
      for (const h of [a2, a4, b1, b2]) h.bot?.close();
      await Promise.all([a2, a4, b1, b2].map((h) => h.bot!.closed));
      await new Promise((r) => setTimeout(r, 50)); // the server frees a slot when it sees the close
      // Origin.
      const evil = await handshake(ctx, "a web page", capUrl, { origin: "https://evil.example" });
      const nul = await handshake(ctx, "a sandboxed page", capUrl, { origin: "null" });
      ensure(evil.status === 403 && nul.status === 403, `a browser origin was not refused (${evil.status}, ${nul.status})`);
      const good = await held("the allowed page", { origin: ALLOWED_ORIGIN });
      const bare = await held("a terminal client");
      ensure(good.status === 101 && bare.status === 101, `an allowed origin or a client without one was refused (${good.status}, ${bare.status})`);
      good.bot?.close(); bare.bot?.close();
      await Promise.all([good.bot!.closed, bare.bot!.closed]);
      await n.step("a handshake carrying an unlisted Origin (or the sandbox origin \"null\") is refused (403); the allowed Origin and clients that send none connect");
      // Join timeout.
      const idle = await handshake(ctx, "an idle connection", capUrl);
      ensure(idle.status === 101 && idle.bot, "the idle connection was refused at the handshake");
      const closeCode = await withTimeout(idle.bot!.closed, 5_000, "the server to close a connection that never joins");
      ensure(closeCode === 1008, `the idle connection closed with ${closeCode}, expected 1008`);
      await n.step(`a connection that never joined was closed (1008) after about ${CAP_LIMITS.joinTimeoutMs} ms`);
      return `per-address cap ${CAP_LIMITS.maxConnectionsPerIp} (3rd refused 503, a freed slot reusable); total cap ${CAP_LIMITS.maxConnections} held against 12 other addresses (503); unlisted Origin and "null" refused (403), the allowed Origin and Origin-less clients connected; a connection that never joined was closed (1008) within the ${CAP_LIMITS.joinTimeoutMs} ms join timeout`;
    });

    ctx.labLogs.push(...room.hostLog, ...room.serverLog, ...caps.hostLog, ...caps.serverLog);
    ctx.labHostLog.push(...room.hostLog, ...caps.hostLog);
    for (const b of ctx.bots) if (b.label.startsWith("secure") || b.label.startsWith("address") || b.label.startsWith("the ")) b.close();
    await stop();
  }, { always: true });
}

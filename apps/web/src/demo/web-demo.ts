import { CLIENT_ADDRESS, SESSION_ID, startStack, type Stack } from "../../e2e/helpers/start-stack";

// `pnpm demo --web` (the runtime's demo runner spawns `pnpm --filter @acr/web demo`, which builds the app and runs this file).
// Three generated players drive the real stack over plain HTTP, as a browser would (join, the SSE stream, say, consent): the runtime
// in mock mode in its own process, `next start` with injected COOKIE_KEYS, a relay that can cut one player's runtime socket, and the
// facilitator on the runtime's protocol. Checks W-01 to W-08; exit 0 only when all eight pass. Offline and deterministic: every wait
// is on an effect (a frame, an answer) with a generous upper bound, and nothing measures elapsed time.
// The output never shows a join code, a cookie, a credential or a typed name.

const PLAYERS = ["delivery_lead", "tech_lead", "account_manager"] as const;
type Player = (typeof PLAYERS)[number];
const COOKIE = "__Host-scenecoach";
const WAIT_MS = 45_000;

export const WEB_CHECKS = [
  ["W-01", "Join by code sets the sealed session cookie (HttpOnly, Secure, SameSite=Lax) and the code stops working"],
  ["W-02", "The stream delivers the opening scene to every player"],
  ["W-03", "A line said through the BFF reaches every player's transcript once"],
  ["W-04", "A dropped runtime socket recovers and the replay has no gap and no duplicate"],
  ["W-05", "A BFF restart keeps every seat (same cookie keys, Last-Event-ID resumes)"],
  ["W-06", "A second stream for a seat supersedes the first, which stops"],
  ["W-07", "No facilitator-only data, code or cookie on any player stream"],
  ["W-08", "robots.txt disallows the private routes and the pages send noindex"],
] as const;
type CheckId = (typeof WEB_CHECKS)[number][0];
type Result = { id: CheckId; title: string; status: "passed" | "failed"; details: string };

class CheckFailed extends Error {}
function check(cond: unknown, msg: string): asserts cond { if (!cond) throw new CheckFailed(msg); }

// ---- the plain-HTTP client a browser would be ----

type Frame = { event: string; id?: string; data: any };
type StreamReader = {
  status: number; frames: Frame[]; raw: () => string; ended: boolean;
  events: () => { seq: number; type: string; [k: string]: any }[];
  lastId: () => string | undefined; cancel(): void;
};

const changed = new Set<() => void>();
const notify = () => { for (const f of [...changed]) f(); };
/** Resolves when `pred` holds (re-checked on every frame and stream end); rejects naming `what` after WAIT_MS. */
function until(pred: () => boolean, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { changed.delete(f); reject(new CheckFailed(`timed out waiting for ${what}`)); }, WAIT_MS);
    const f = () => { if (pred()) { clearTimeout(t); changed.delete(f); resolve(); } };
    changed.add(f);
    f();
  });
}

class Web {
  readonly streams: { role: Player; r: StreamReader }[] = [];
  constructor(private readonly stack: Stack) {}
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { "X-Forwarded-For": CLIENT_ADDRESS, ...extra };
  }
  private guarded(cookie?: string) {
    return this.headers({ Origin: this.stack.baseUrl, "X-Requested-With": "scenecoach", "Content-Type": "application/json", ...(cookie ? { Cookie: `${COOKIE}=${cookie}` } : {}) });
  }
  async join(role: Player, code: string, displayName: string) {
    const res = await fetch(`${this.stack.baseUrl}/api/v1/join`, { method: "POST", headers: this.guarded(), body: JSON.stringify({ sessionId: SESSION_ID, role, joinCode: code, displayName }) });
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    const body = await res.text();
    const m = new RegExp(`^${COOKIE}=([^;]+);`).exec(setCookie);
    return { status: res.status, setCookie, body, cookie: m ? m[1]! : null };
  }
  post(path: string, cookie: string, body: unknown) {
    return fetch(`${this.stack.baseUrl}/api/v1/${path}`, { method: "POST", headers: this.guarded(cookie), body: JSON.stringify(body) });
  }
  async stream(role: Player, cookie: string, lastEventId?: string): Promise<StreamReader> {
    const res = await fetch(`${this.stack.baseUrl}/api/v1/stream?session=${SESSION_ID}`, {
      headers: this.headers({ Accept: "text/event-stream", Cookie: `${COOKIE}=${cookie}`, "Sec-Fetch-Site": "same-origin", ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}) }),
    });
    const chunks: string[] = [];
    const frames: Frame[] = [];
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const r: StreamReader = {
      status: res.status, frames, ended: false, raw: () => chunks.join(""),
      events: () => frames.filter((f) => f.event === "event").map((f) => f.data),
      lastId: () => [...frames].reverse().find((f) => f.id !== undefined)?.id,
      cancel: () => { void reader.cancel().catch(() => undefined); },
    };
    const parse = (block: string) => {
      const f: { event: string; id?: string; data: string[] } = { event: "message", data: [] };
      for (const line of block.split("\n")) {
        if (line.startsWith(":") || line === "") continue;
        const at = line.indexOf(":");
        const field = at < 0 ? line : line.slice(0, at);
        const value = at < 0 ? "" : line.slice(at + 1).replace(/^ /, "");
        if (field === "event") f.event = value;
        else if (field === "id") f.id = value;
        else if (field === "data") f.data.push(value);
      }
      if (f.data.length > 0) frames.push({ event: f.event, id: f.id, data: JSON.parse(f.data.join("\n")) });
    };
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          chunks.push(text);
          buf += text;
          for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) { parse(buf.slice(0, i)); buf = buf.slice(i + 2); }
          notify();
        }
      } catch { /* the connection was cut (a BFF restart): the stream is over, as a browser would see it */ }
      r.ended = true;
      notify();
    })();
    this.streams.push({ role, r });
    return r;
  }
}

const utterances = (r: StreamReader, text: string) => r.events().filter((e) => e.type === "utterance" && e.text === text).length;

// ---- the run ----

export async function runWebDemo(o: { write: (s: string) => void; color: boolean }): Promise<number> {
  const paint = (s: string, code: number) => (o.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const results: Result[] = [];
  const titleOf = (id: CheckId) => WEB_CHECKS.find(([i]) => i === id)![1];
  const why = (err: unknown) => (err instanceof CheckFailed ? err.message : `unexpected error: ${err instanceof Error ? err.name : "error"}`);
  /**
   * Runs one check and records it. A failure does not stop the run: the later checks still run on whatever state there is (a check
   * that depended on the failed one fails too, with its own reason), so one regression never hides another, such as a leak.
   */
  const run = async (id: CheckId, body: () => Promise<string>) => {
    try { results.push({ id, title: titleOf(id), status: "passed", details: await body() }); }
    catch (err) { results.push({ id, title: titleOf(id), status: "failed", details: why(err) }); }
  };

  o.write(`${paint("pnpm demo --web", 1)}: three players in the browser's place, against the runtime (mock models), next start and a relay\n`);
  let stack: Stack | null = null;
  try {
    stack = await startStack();
    const s = stack;
    const web = new Web(s);
    const cookies = {} as Record<Player, string>;
    const live = {} as Record<Player, StreamReader>;
    const codes = { ...s.codes };
    /** What a person types: lower case with spaces and hyphens (the runtime normalises it). */
    const typed = (code: string) => code.replace(/-/g, "").toLowerCase().replace(/(.{4})(?=.)/g, "$1 - ");

    await run("W-01", async () => {
      for (const role of PLAYERS) {
        const j = await web.join(role, typed(codes[role]!), `Generated ${role}`);
        check(j.status === 200 && j.cookie, `${role}: join answered ${j.status} without a cookie`);
        check(new RegExp(`^${COOKIE}=[^;]+; Path=/; Max-Age=\\d+; HttpOnly; Secure; SameSite=Lax$`).test(j.setCookie), `${role}: the cookie attributes are not HttpOnly, Secure, SameSite=Lax, Path=/`);
        check(!j.body.includes(codes[role]!) && !j.body.includes(j.cookie), `${role}: the join answer echoed the code or the cookie`);
        cookies[role] = j.cookie;
      }
      const again = await web.join("delivery_lead", codes.delivery_lead!, "Someone else");
      check(again.status === 401 && again.cookie === null, `the code still seated someone after a credential existed (answer ${again.status})`);
      return "3 joins by typed code set a sealed __Host- cookie (HttpOnly, Secure, SameSite=Lax, Path=/; the answer echoes neither code nor cookie); the same code again was refused (401) once the seat had a credential";
    });

    await run("W-02", async () => {
      for (const role of PLAYERS) {
        const r = await web.stream(role, cookies[role]);
        check(r.status === 200, `${role}: the stream answered ${r.status}`);
        await until(() => r.frames.some((f) => f.event === "joined"), `${role}'s joined`);
        live[role] = r;
        const notice = r.frames.find((f) => f.event === "joined")!.data.consent.noticeVersion as string;
        const c = await web.post("consent", cookies[role], { noticeVersion: notice });
        check(c.status === 200, `${role}: consent answered ${c.status}`);
      }
      await s.terminalFacilitator.start();
      for (const role of PLAYERS) {
        await until(() => live[role].events().some((e) => e.type === "scene.entered" && e.sceneId === "s1_huddle"), `${role}'s opening scene`);
        await until(() => live[role].events().some((e) => e.type === "inject.fired" && typeof e.content === "string" && e.content.includes("Email from Priya Raman")), `${role}'s opening inject`);
      }
      return "each player opened the stream, consented over it and, after the facilitator's start, received scene.entered for s1_huddle and the opening inject (Priya's email)";
    });

    const lines: Record<Player, string> = { delivery_lead: "Did everyone see the email?", tech_lead: "Yes, before go-live is a risk.", account_manager: "We cannot simply say no." };
    await run("W-03", async () => {
      for (const role of PLAYERS) {
        const r = await web.post("say", cookies[role], { text: lines[role] });
        check(r.status === 200, `${role}: say answered ${r.status}`);
      }
      for (const role of PLAYERS) for (const line of Object.values(lines)) await until(() => utterances(live[role], line) >= 1, `"${line}" on ${role}'s stream`);
      for (const role of PLAYERS) for (const line of Object.values(lines)) check(utterances(live[role], line) === 1, `${role} received a line more than once`);
      return "3 lines said through POST /api/v1/say arrived as utterance events on all 3 streams, each exactly once";
    });

    // Facilitator-only material for W-07: a whisper (the tech lead's own) and a released hidden fact (never a player's).
    await s.terminalFacilitator.command({ command: "whisper", roleId: "tech_lead", text: "WHISPER-ONLY-FOR-TECH-LEAD" });
    await s.terminalFacilitator.command({ command: "release_hidden", roleId: "client_sponsor", fact: 1 });

    await run("W-04", async () => {
      const before = live.tech_lead;
      const lastId = before.lastId();
      check(lastId !== undefined, "the tech lead's stream carried no event id");
      s.dropSocket("tech_lead");
      await until(() => before.ended, "the dropped stream to end");
      check(before.frames.at(-1)?.event === "reconnecting", `the dropped stream ended with ${before.frames.at(-1)?.event ?? "nothing"}, not reconnecting`);
      const missed = "Said while the tech lead was away.";
      check((await web.post("say", cookies.delivery_lead, { text: missed })).status === 200, "the say during the drop was refused");
      const after = await web.stream("tech_lead", cookies.tech_lead, lastId);
      await until(() => utterances(after, missed) === 1, "the missed line in the replay");
      check(!after.frames.some((f) => f.event === "reset"), "the reconnect reset the view instead of replaying");
      live.tech_lead = after;
      // The gap check: what the two streams carried, against a full replay from the start for the same seat.
      const head = Number(after.lastId());
      const seen = [...before.events(), ...after.events()].map((e) => e.seq).filter((q) => q <= head);
      check(new Set(seen).size === seen.length, "an event arrived twice across the drop");
      after.cancel();
      const full = await web.stream("tech_lead", cookies.tech_lead);
      await until(() => full.events().some((e) => e.seq === head), "the full replay up to the same event");
      const expected = full.events().map((e) => e.seq).filter((q) => q <= head);
      check(JSON.stringify(expected) === JSON.stringify([...seen].sort((a, b) => a - b)), `the streams across the drop held ${seen.length} events, a full replay ${expected.length}`);
      live.tech_lead = full;
      return `the cut socket ended the stream with reconnecting; a reopen from Last-Event-ID ${lastId} replayed the missed line without a reset; ${seen.length} events across the drop equal a full replay up to seq ${head}, none twice`;
    });

    await run("W-05", async () => {
      const ids = Object.fromEntries(PLAYERS.map((r) => [r, live[r].lastId()!])) as Record<Player, string>;
      await s.restartBff();
      for (const role of PLAYERS) await until(() => live[role].ended, `${role}'s stream to end with the old BFF`);
      for (const role of PLAYERS) {
        const r = await web.stream(role, cookies[role], ids[role]);
        await until(() => r.frames.length > 0, `${role}'s first frame from the new BFF`);
        check(r.frames[0]!.event === "joined", `${role}: the new BFF answered ${r.frames[0]!.event} (the seat was not kept)`);
        check(!r.frames.some((f) => f.event === "reset"), `${role}: the new BFF reset the view`);
        live[role] = r;
      }
      const line = "Still here after the restart.";
      check((await web.post("say", cookies.account_manager, { text: line })).status === 200, "say after the restart was refused");
      for (const role of PLAYERS) await until(() => utterances(live[role], line) === 1, `the line after the restart on ${role}'s stream`);
      return "next start was killed and started again with the same COOKIE_KEYS; every cookie rejoined from its Last-Event-ID without a reset, and a new line reached all 3";
    });

    await run("W-06", async () => {
      const first = live.delivery_lead;
      const second = await web.stream("delivery_lead", cookies.delivery_lead, first.lastId());
      await until(() => first.ended, "the first stream to end");
      check(first.frames.at(-1)?.event === "superseded", `the first stream ended with ${first.frames.at(-1)?.event ?? "nothing"}, not superseded`);
      await until(() => second.frames.some((f) => f.event === "joined"), "the second stream's joined");
      live.delivery_lead = second;
      const line = "Speaking from the second stream.";
      check((await web.post("say", cookies.delivery_lead, { text: line })).status === 200, "say from the second stream was refused");
      await until(() => utterances(second, line) === 1 && utterances(live.tech_lead, line) === 1, "the second stream's line");
      check(!second.ended, "the second stream was ended too");
      return "a second stream with the same cookie took the seat; the first ended with superseded (final, no retry) and the second spoke on";
    });

    // Scene 2 (Priya, an AI character holding the hidden fact, answers), scene 3, the end. Part of W-07's material; its failure is W-07's.
    let toTheEnd: unknown = null;
    try {
      await s.terminalFacilitator.command({ command: "advance" });
      await until(() => live.delivery_lead.events().some((e) => e.type === "scene.entered" && e.sceneId === "s2_client_call"), "scene 2");
      check((await web.post("say", cookies.delivery_lead, { text: "Hello Priya." })).status === 200, "say in scene 2 was refused");
      await until(() => live.delivery_lead.events().some((e) => e.type === "utterance" && e.roleId === "client_sponsor"), "Priya's answer");
      await s.terminalFacilitator.command({ command: "advance" });
      await s.terminalFacilitator.command({ command: "advance" });
      for (const role of PLAYERS) await until(() => live[role].ended, `${role}'s stream to end`);
    } catch (err) { toTheEnd = err; }

    await run("W-07", async () => {
      // The scan below runs first: a leak is reported even when the session could not be played to its end.
      const facText = JSON.stringify(s.terminalFacilitator.frames());
      const FACILITATOR_ONLY = ["Would accept a phased delivery after go-live" /* client_sponsor's hidden fact */, "hiddenFacts", "\"npc.updated\"", "\"gm.no_verdict\""];
      // Each marker really exists in this session (the facilitator saw it), so the scan below can fail.
      for (const m of FACILITATOR_ONLY) check(facText.includes(m), `the facilitator never saw ${m}: the scan would prove nothing`);
      const secrets = [...Object.values(codes).flatMap((c) => [c, typed(c)]), ...Object.values(cookies), "\"credential\"", "\"reconnectToken\"", "reasoning", "\"gm.decision\"", "\"facilitator.alert\""];
      let frames = 0;
      for (const { role, r } of web.streams) {
        frames += r.frames.length;
        const raw = r.raw();
        for (const m of [...FACILITATOR_ONLY, ...secrets]) check(!raw.includes(m), `${role}'s stream leaked ${m.slice(0, 12)}…`);
        if (role !== "tech_lead") check(!raw.includes("WHISPER-ONLY-FOR-TECH-LEAD"), `${role} saw the tech lead's whisper`);
      }
      check(web.streams.filter((x) => x.role === "tech_lead").some((x) => x.r.raw().includes("WHISPER-ONLY-FOR-TECH-LEAD")), "the tech lead never got its own whisper");
      if (toTheEnd !== null) throw toTheEnd;
      for (const role of PLAYERS) check(live[role].frames.at(-1)?.event === "ended", `${role}'s stream did not end with ended`);
      return `${frames} SSE frames on ${web.streams.length} streams (every stream every role opened) carry none of the ${FACILITATOR_ONLY.length} facilitator-only markers the facilitator saw, no join code, cookie, credential or token; the whisper reached only its addressee`;
    });

    await run("W-08", async () => {
      const robots = await (await fetch(`${s.baseUrl}/robots.txt`)).text();
      for (const p of ["/join", "/session", "/api", "/report", "/console", "/admin"]) check(new RegExp(`^Disallow: ${p}$`, "m").test(robots), `robots.txt does not disallow ${p}`);
      for (const p of [`/join?session=${SESSION_ID}&role=tech_lead`, `/session/${SESSION_ID}`]) {
        const res = await fetch(`${s.baseUrl}${p}`, { headers: { "X-Forwarded-For": CLIENT_ADDRESS } });
        const html = await res.text();
        check(res.status === 200, `${p.split("?")[0]} answered ${res.status}`);
        check(res.headers.get("X-Robots-Tag") === "noindex, nofollow", `${p.split("?")[0]} sent no X-Robots-Tag noindex`);
        check(/<meta name="robots" content="noindex, nofollow"\s*\/?>/.test(html), `${p.split("?")[0]} has no robots meta tag`);
      }
      const api = await fetch(`${s.baseUrl}/api/v1/stream?session=${SESSION_ID}`, { headers: { Accept: "text/event-stream", "X-Forwarded-For": CLIENT_ADDRESS } });
      await api.body?.cancel();
      check(api.headers.get("X-Robots-Tag") === "noindex, nofollow", "the API sent no X-Robots-Tag noindex");
      return "robots.txt disallows /join, /session, /report, /console, /admin and /api; /join and /session send X-Robots-Tag and a robots meta tag (noindex, nofollow), and so does the API";
    });
  } catch (err) {
    if (!(err instanceof CheckFailed) && results.length === 0) o.write(`error: the stack did not start: ${err instanceof Error ? err.message : "error"}\n`);
  } finally {
    for (const x of [...changed]) changed.delete(x);
    await stack?.stop();
  }

  for (const [id, title] of WEB_CHECKS) if (!results.some((r) => r.id === id)) results.push({ id, title, status: "failed", details: "not run: an earlier step failed" });
  o.write(`\n${paint("Checklist", 1)}\n`);
  for (const r of results) {
    o.write(`  ${r.status === "passed" ? paint("✓", 32) : paint("✗", 31)} ${r.id}  ${r.title}\n      ${paint(r.details, 2)}\n`);
  }
  const passed = results.filter((r) => r.status === "passed").length;
  o.write(`\n${paint("Summary:", 1)} ${passed} passed, ${results.length - passed} failed, 0 skipped (web, mock mode)\n`);
  return passed === results.length ? 0 : 1;
}

// Run directly (tsx src/demo/web-demo.ts), never on import.
if (process.argv[1] && /web-demo\.ts$/.test(process.argv[1])) {
  const color = !process.env.NO_COLOR && process.stdout.isTTY === true;
  const exitCode = await runWebDemo({ write: (s) => { process.stdout.write(s); }, color });
  process.exitCode = exitCode;
  // Everything is closed by now; never let a stray handle keep the process alive.
  setTimeout(() => process.exit(exitCode), 3_000).unref();
}

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page, type WebSocketRoute } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { checkBothSchemes, createSession, expectSeatReady, facilitator, ROLE_LABEL, startButton } from "./helpers/console";
import { joinAsLauncher, playerContext, say, consent, PLAYERS, type Player } from "./helpers/players";
import { startLauncherStack, type LauncherStack } from "./helpers/start-launcher-stack";

// US-0071 (EPIC-0003 voice A1b, Task 17): the participant's voice flow and the console's voice panel in a real browser, against the
// real control service, runtimes, speech workers and `next start` (launcher mode). Chromium gets a fake microphone that plays the tone
// written below. There is NO LiveKit server here: the web server's LIVEKIT_URL is a loopback port nothing listens on, and the control
// service has no LiveKit key (so it answers every token request `voice_unavailable`). What this proves:
//   - the REAL response headers: one Permissions-Policy on /session/<id> with microphone=(self) and a connect-src naming the LiveKit
//     origin; microphone=() on /console, /join and /api/*; and without LIVEKIT_URL no exception anywhere;
//   - the microphone is never requested on load (a getUserMedia counter installed by an init script, before any page script);
//   - the lobby choice through the real runtime with the real keyboard (Tab enters the radio group once, arrows select, Enter and Space
//     save), the console's voice column and panel, and peer isolation (another player's page and stream never carry a voice field);
//   - the mic check level from the fake device; "Join with voice" stops the check, gets 503 from the real token route, then (with the
//     token route answered by the test) cannot connect and keeps the focus on "Join with voice"; the text box still works;
//   - a private voice notice reaches the voice holder only (a speech worker is killed; control restarts it);
//   - the page leaves the LiveKit connection when its runtime stream drops and asks for a fresh token on resume (batch 3 review F10);
//   - the microphone tracks stop when the seat is superseded or removed;
//   - Axe (no serious or critical violation in either scheme; none at all inside the voice sections) on every voice state reachable
//     without a LiveKit server.
// What it cannot prove (Task 18, a real LiveKit server): publishing, the Mute button and its "Microphone muted" state, "Stop using
// voice", the unpublish on mute, and the teardown of a PUBLISHED track. The fake token below is a fixed, obviously fake JWT shape.

// ---- the fake microphone: written at module scope, before the worker-scoped browser launches with it ----

/** A 16 kHz mono 16-bit WAV: a 44-byte RIFF header and `seconds` of a 440 Hz tone at -12 dBFS peak (no import from @acr/adapters). */
function writeToneWav(file: string, seconds = 2): void {
  const rate = 16_000;
  const n = rate * seconds;
  const amp = Math.round(32767 * 10 ** (-12 / 20));
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16); // fmt chunk size
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); // byte rate
  b.writeUInt16LE(2, 32); // block align
  b.writeUInt16LE(16, 34); // bits per sample
  b.write("data", 36, "ascii");
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  writeFileSync(file, b);
}
const WAV_DIR = mkdtempSync(path.join(os.tmpdir(), "acr-voice-wav-"));
const WAV = path.join(WAV_DIR, "tone.wav");
writeToneWav(WAV);
process.once("exit", () => rmSync(WAV_DIR, { recursive: true, force: true }));

test.use({
  trace: "off",
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${WAV}`],
  },
});

// ---- what the page does, observed from inside it (installed before any page script runs) ----

/** Counts getUserMedia calls, keeps every track they returned, and records the raw data of every SSE event of the types listed. */
function instrument(): void {
  const w = window as unknown as { __gum: number; __tracks: MediaStreamTrack[]; __sse: { type: string; data: string }[] };
  w.__gum = 0;
  w.__tracks = [];
  w.__sse = [];
  const md = navigator.mediaDevices;
  if (md && typeof md.getUserMedia === "function") {
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = (c?: MediaStreamConstraints) => {
      w.__gum++;
      return orig(c).then((s) => { for (const t of s.getTracks()) w.__tracks.push(t); return s; });
    };
  }
  // The BFF's event names plus names a leak would plausibly use: a raw copy of each, whatever the page itself listens to.
  const TYPES = ["joined", "reset", "event", "roster", "error", "voice_notice", "voice", "speaking", "facilitator", "characters", "reconnecting", "ended", "removed", "superseded", "signed_out", "expired", "ai_filled", "message"];
  const Native = window.EventSource;
  window.EventSource = class extends Native {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);
      for (const t of TYPES) this.addEventListener(t, (e) => { const d = (e as MessageEvent).data; if (typeof d === "string") w.__sse.push({ type: t, data: d }); });
    }
  } as typeof EventSource;
}
const gum = (p: Page) => p.evaluate(() => (window as unknown as { __gum: number }).__gum);
const trackStates = (p: Page) => p.evaluate(() => (window as unknown as { __tracks: MediaStreamTrack[] }).__tracks.map((t) => t.readyState));
const sseFrames = (p: Page) => p.evaluate(() => (window as unknown as { __sse: { type: string; data: string }[] }).__sse);

// ---- headers on real responses ----

/** One GET with node's http client: every header line as sent (a repeated header stays repeated). */
function rawGet(url: string): Promise<{ status: number; headers: [string, string][] }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const pairs: [string, string][] = [];
      for (let i = 0; i < res.rawHeaders.length; i += 2) pairs.push([res.rawHeaders[i]!.toLowerCase(), res.rawHeaders[i + 1]!]);
      res.resume();
      resolve({ status: res.statusCode ?? 0, headers: pairs });
    }).on("error", reject);
  });
}
const all = (h: [string, string][], name: string) => h.filter(([k]) => k === name).map(([, v]) => v);
const connectSrc = (csp: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src")) ?? "";

// ---- seats ----

const NAMES: Record<Player, string> = { delivery_lead: "Dana Lead", tech_lead: "Tomás Tech", account_manager: "Ama Voice" };
const VOICE_ANSWER = "Voice is not available right now. Use the text box.";
const COULD_NOT_CONNECT = "Voice could not connect. Use the text box.";
/** Obviously fake: three base64url parts; never a real token, never signed by any key. */
const FAKE_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlLWUyZSJ9.ZmFrZS1zaWduYXR1cmU";
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function voiceSeat(browser: Browser, baseUrl: string, sessionId: string, role: Player, code: string, o: { consent?: boolean } = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await playerContext(browser);
  await context.grantPermissions(["microphone"], { origin: baseUrl });
  await context.addInitScript(instrument);
  const page = await context.newPage();
  await joinAsLauncher(page, baseUrl, sessionId, role, code, NAMES[role]);
  if (o.consent !== false) await consent(page);
  return { context, page };
}

const ui = (p: Page) => ({
  region: p.getByRole("region", { name: "Voice", exact: true }),
  /** The saved state in words (after its aria-hidden icon). */
  saved: p.getByRole("region", { name: "Voice", exact: true }).locator(":scope > p").first(),
  withVoice: p.getByRole("radio", { name: "Take part with voice" }),
  textOnly: p.getByRole("radio", { name: "Take part by text only" }),
  save: p.getByRole("button", { name: "Save choice" }),
  withdraw: p.getByRole("button", { name: "Leave and withdraw consent" }),
  check: p.getByRole("button", { name: "Check my microphone" }),
  stopCheck: p.getByRole("button", { name: "Stop the check" }),
  meter: p.getByRole("meter", { name: "Microphone level" }),
  join: p.getByRole("button", { name: "Join with voice" }),
  micState: p.locator(".mic .mic-state"),
  notices: p.locator(".voice-notices[role=status][aria-live=polite]"),
});

const isVoicePost = (r: { url(): string; request(): { method(): string } }) => new URL(r.url()).pathname === "/api/v1/voice" && r.request().method() === "POST";
const isTokenPath = (u: string) => new URL(u).pathname === "/api/v1/voice/token";

/** Answers the page's token requests itself (the control service has no LiveKit): the fake token and the stack's LiveKit origin. */
async function fakeTokens(page: Page, origin: string): Promise<{ count: () => number }> {
  let n = 0;
  await page.route((u) => isTokenPath(u.toString()), async (route) => {
    n++;
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify({ success: true, data: { token: FAKE_TOKEN, url: origin, expiresAt: 1 }, error: null }) });
  });
  return { count: () => n };
}

/** Every violation (any impact) inside `selector`: the new voice sections must be clean, not only free of serious ones. */
async function voiceViolations(page: Page, selector: string) {
  const r = await new AxeBuilder({ page }).include(selector).withTags(WCAG).analyze();
  return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target.join(" ")) }));
}
/** The repo's whole-page check (no serious or critical violation, light and dark), then every violation inside the voice sections, in both schemes. */
async function axe(page: Page, screen: string, selectors: string[]): Promise<void> {
  await checkBothSchemes(page, screen);
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    // As in checkBothSchemes: a scheme switch starts button transitions; Axe must measure the settled colours.
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" && !a.pending));
    for (const s of selectors) expect(await voiceViolations(page, s), `${screen}: ${s} (${scheme})`).toEqual([]);
  }
}

/** Readiness row cells of a seat on the console: Name, Joined, Consented, Voice, Connected, Code. */
const seatCells = (fac: Page, role: Player) =>
  fac.locator("tbody tr").filter({ has: fac.getByRole("rowheader", { name: ROLE_LABEL[role], exact: true }) }).locator("td");

/** The peer roster entries a player's stream carried, and the keys they used. */
function peerKeys(frames: { type: string; data: string }[]): Set<string> {
  const keys = new Set<string>();
  for (const f of frames.filter((x) => x.type === "roster")) {
    const d = JSON.parse(f.data) as { entries?: Record<string, unknown>[] };
    for (const e of d.entries ?? []) for (const k of Object.keys(e)) keys.add(k);
  }
  return keys;
}
const PEER_KEYS = ["roleId", "name", "ready", "ai"];

// =====================================================================================================================================

test.describe("voice with LiveKit configured in the web server", () => {
  test.describe.configure({ mode: "serial" });

  let stack: LauncherStack;
  let fac: Page;
  let sessionId: string;
  let codes: Record<Player, string>;
  const seats = {} as Record<Player, { context: BrowserContext; page: Page }>;
  const opened: BrowserContext[] = [];

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    stack = await startLauncherStack({ voice: {} });
  });
  test.afterAll(async () => {
    for (const c of opened.splice(0)) await c.close().catch(() => undefined);
    await stack?.stop();
  });

  test("the real response headers: microphone=(self) and the LiveKit origin on the session page only", async () => {
    test.setTimeout(60_000);
    const origin = stack.livekitOrigin!;
    expect(origin).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    const httpTwin = origin.replace(/^ws:/, "http:");

    const page = await rawGet(`${stack.baseUrl}/session/abc123`);
    expect(all(page.headers, "permissions-policy")).toEqual(["camera=(), microphone=(self), geolocation=()"]);
    const csp = all(page.headers, "content-security-policy");
    expect(csp).toHaveLength(1);
    expect(connectSrc(csp[0]!).split(/\s+/)).toEqual(["connect-src", "'self'", origin, httpTwin]);
    expect(all(page.headers, "x-content-type-options")).toEqual(["nosniff"]);
    expect(all(page.headers, "x-frame-options")).toHaveLength(1);
    expect(all(page.headers, "referrer-policy")).toHaveLength(1);

    for (const p of ["/console", "/join", "/api/v1/stream", "/api/v1/voice/token", "/session"]) {
      const r = await rawGet(`${stack.baseUrl}${p}`);
      expect(all(r.headers, "permissions-policy"), p).toEqual(["camera=(), microphone=(), geolocation=()"]);
      for (const c of all(r.headers, "content-security-policy")) expect(connectSrc(c), p).not.toContain(origin);
    }
  });

  test("lobby: no microphone on load, the keyboard choice, the console voice column, peer isolation, the mic check and the failed joins", async ({ browser }) => {
    test.setTimeout(300_000);
    fac = await facilitator(browser, stack.baseUrl, stack.facilitatorSecret);
    opened.push(fac.context());
    ({ sessionId, codes } = await createSession(fac, stack.baseUrl));

    // Seat A (account_manager) will take part with voice; B and C stay text only.
    const a = await voiceSeat(browser, stack.baseUrl, sessionId, "account_manager", codes.account_manager, { consent: false });
    opened.push(a.context);
    seats.account_manager = a;
    const A = a.page;
    const ua = ui(A);
    expect(await gum(A), "no microphone request on load").toBe(0);
    await expect(ua.region).toHaveCount(0); // no voice choice before consent
    await consent(A);
    await expect(A.getByRole("heading", { name: "Consent, notice v3" })).toBeVisible();
    await expect(ua.saved).toHaveText(/Voice: not chosen$/);
    expect(await gum(A), "no microphone request after consent").toBe(0);

    for (const role of ["delivery_lead", "tech_lead"] as const) {
      const s = await voiceSeat(browser, stack.baseUrl, sessionId, role, codes[role]);
      opened.push(s.context);
      seats[role] = s;
    }
    const B = seats.delivery_lead.page;
    const ub = ui(B);
    await expect(ub.saved).toHaveText(/Voice: not chosen$/);
    const bBefore = await B.locator("main").innerText();

    // Axe on the lobby with the voice choice (nothing chosen yet).
    await axe(A, "lobby with the voice choice", ["section.card.voice"]);

    // The real keyboard: Tab enters the radio group once, the arrows move the selection, Tab leaves it for Save choice.
    await ua.withdraw.focus();
    await A.keyboard.press("Tab");
    await expect(ua.withVoice).toBeFocused();
    await A.keyboard.press("ArrowDown");
    await expect(ua.textOnly).toBeFocused();
    await expect(ua.textOnly).toBeChecked();
    await A.keyboard.press("ArrowUp");
    await expect(ua.withVoice).toBeFocused();
    await expect(ua.withVoice).toBeChecked();
    await A.keyboard.press("Tab");
    await expect(ua.save, "the second radio is not a tab stop of its own").toBeFocused();
    await A.keyboard.press("Shift+Tab");
    await expect(ua.withVoice).toBeFocused();
    await A.keyboard.press("Shift+Tab");
    await expect(ua.withdraw, "the group is one tab stop backwards too").toBeFocused();
    await A.keyboard.press("Tab");
    await A.keyboard.press("Tab");
    await expect(ua.save).toBeFocused();
    // Enter on Save choice saves through the real runtime.
    let [answer] = await Promise.all([A.waitForResponse(isVoicePost), A.keyboard.press("Enter")]);
    expect(answer.status()).toBe(200);
    await expect(ua.saved).toHaveText(/Voice: on$/);
    await expect(ua.check).toBeVisible();
    await expect(ua.join).toBeVisible();
    expect(await gum(A), "choosing voice opens no microphone").toBe(0);

    // Opt out with Space on Save choice, then back in with Enter inside a radio (implicit submission).
    await ua.withVoice.focus();
    await A.keyboard.press("ArrowDown");
    await expect(ua.textOnly).toBeChecked();
    await A.keyboard.press("Tab");
    await expect(ua.save).toBeFocused();
    [answer] = await Promise.all([A.waitForResponse(isVoicePost), A.keyboard.press("Space")]);
    expect(answer.status()).toBe(200);
    await expect(ua.saved).toHaveText(/Voice: off \(text only\)$/);
    await expect(ua.join).toHaveCount(0);
    await A.keyboard.press("Shift+Tab");
    await expect(ua.textOnly).toBeFocused();
    await A.keyboard.press("ArrowUp");
    await expect(ua.withVoice).toBeChecked();
    [answer] = await Promise.all([A.waitForResponse(isVoicePost), A.keyboard.press("Enter")]);
    expect(answer.status()).toBe(200);
    await expect(ua.saved).toHaveText(/Voice: on$/);

    // The console: the readiness roster has a Voice column, in words, per seat.
    await fac.goto(`${stack.baseUrl}/console/${sessionId}`);
    for (const role of PLAYERS) await expectSeatReady(fac, role);
    await expect(fac.getByRole("columnheader", { name: "Voice", exact: true })).toBeVisible();
    await expect(seatCells(fac, "account_manager").nth(3)).toHaveText(/Voice on/);
    await expect(seatCells(fac, "delivery_lead").nth(3)).toHaveText(/Not chosen/);
    await axe(fac, "console readiness with the voice column", ["table.grid"]);

    // Peer isolation: B's page is unchanged by A's choices, and B's stream carried no voice field of anyone but B's own joined.
    expect(await B.locator("main").innerText()).toBe(bBefore);
    const bFrames = await sseFrames(B);
    expect(bFrames.some((f) => f.type === "joined")).toBe(true);
    expect([...peerKeys(bFrames)].every((k) => PEER_KEYS.includes(k)), `B's roster keys: ${[...peerKeys(bFrames)].join(",")}`).toBe(true);
    for (const f of bFrames) {
      expect(f.type, "no voice frame or notice reaches B").not.toMatch(/^voice/);
      expect(f.type, "no speaking or facilitator frame reaches B").not.toMatch(/speaking|facilitator/);
      expect(f.data).not.toContain('"speaking"');
      if (f.type === "joined") expect((JSON.parse(f.data) as { voice?: { state?: string } }).voice?.state).toBe("none");
      else expect(f.data).not.toContain('"voice"');
    }
    // A is a player too: never a console field in A's own roster frames.
    expect([...peerKeys(await sseFrames(A))].every((k) => PEER_KEYS.includes(k))).toBe(true);

    // A private notice: killing the speech worker makes control restart it; A (a voice holder) is told, B is not.
    await stack.crashSpeechWorkers();
    await expect(ua.notices.locator("span")).toHaveText(/Voice is (unavailable right now|available again)/, { timeout: 60_000 });
    await expect(ua.notices.locator("span")).toHaveText("Voice is available again, you can speak.", { timeout: 60_000 });
    expect((await sseFrames(B)).filter((f) => f.type === "voice_notice")).toEqual([]);
    await expect(ub.notices.locator("span")).toHaveCount(0);
    await axe(A, "lobby with a voice notice", [".voice-notices", "section.card.voice"]);

    // The mic check: only the click asks for the microphone; the fake device's tone reads as "Hearing you".
    expect(await gum(A)).toBe(0);
    await ua.check.click();
    await expect(ua.meter).toBeVisible();
    await expect(A.locator(".mic-words")).toHaveText("Hearing you", { timeout: 30_000 });
    expect(await gum(A)).toBe(1);
    expect(await trackStates(A)).toEqual(["live"]);
    await expect(A.locator(".mic-words").locator("xpath=ancestor-or-self::*[@aria-live or @role='status' or @role='alert']")).toHaveCount(0);
    await axe(A, "lobby with the mic check running", ["section.card.voice", "main section.card:has(meter)"]);

    // Join with voice through the REAL token route: the check stops first, the control service has no LiveKit (503, its sentence).
    await ua.join.focus();
    const [tokenAnswer] = await Promise.all([A.waitForResponse((r) => isTokenPath(r.url())), A.keyboard.press("Enter")]);
    expect(tokenAnswer.status()).toBe(503);
    expect(Object.keys(((await tokenAnswer.json()) as { data?: object }).data ?? {})).toEqual([]);
    await expect(A.locator(".mic [role=alert]")).toHaveText(VOICE_ANSWER);
    expect(await trackStates(A), "Join with voice stopped the check's tracks").toEqual(["ended"]);
    await expect(ua.join).toBeFocused();

    // With a token (answered by the test), the real livekit-client cannot reach LiveKit: the fixed sentence, the focus stays on Join.
    const tokens = await fakeTokens(A, stack.livekitOrigin!);
    await ua.join.focus();
    await A.keyboard.press("Enter");
    await expect(A.locator(".mic [role=alert]")).toHaveText(COULD_NOT_CONNECT, { timeout: 60_000 });
    await expect(ua.join).toBeFocused();
    await expect(ua.micState).toHaveText(/Voice not connected/);
    expect(tokens.count()).toBe(1);
    await axe(A, "lobby after a failed join", ["section.card.voice", ".mic"]);
    await A.unroute((u) => isTokenPath(u.toString()));
  });

  test("scene: the text box still works, the scene's voice controls and the console voice panel pass Axe", async () => {
    test.setTimeout(180_000);
    const A = seats.account_manager.page;
    const ua = ui(A);
    await expect(startButton(fac)).toBeEnabled();
    await startButton(fac).click();
    await expect(fac.getByText("The session has started.", { exact: true })).toBeVisible();
    await expect(A.getByRole("heading", { name: "Play the scene" })).toBeVisible({ timeout: 60_000 });
    await expect(ua.join).toBeVisible();
    await expect(ua.check).toHaveCount(0); // the mic check is a lobby step
    await say(A, "Typed while voice could not connect.");
    await axe(A, "scene with the voice controls", ["section.card.voice", ".mic"]);

    const panel = fac.getByRole("region", { name: "Voice", exact: true });
    await expect(panel).toBeVisible({ timeout: 60_000 });
    const row = panel.getByRole("row").filter({ has: fac.getByRole("rowheader", { name: /Ama Voice/ }) });
    await expect(row).toContainText("Voice on");
    await expect(row).toContainText("Quiet");
    await expect(panel.getByRole("row").filter({ has: fac.getByRole("rowheader", { name: /Dana Lead/ }) })).toContainText("Not chosen");
    await expect(panel.locator("xpath=ancestor-or-self::*[@aria-live or @role='status' or @role='alert' or @role='log']")).toHaveCount(0);
    await axe(fac, "console live view with the voice panel", [".voicepanel"]);
  });

  test("the page leaves the LiveKit connection when its runtime stream drops, and asks for a fresh token on resume (F10)", async () => {
    test.setTimeout(240_000);
    const A = seats.account_manager.page;
    const ua = ui(A);
    const tokens = await fakeTokens(A, stack.livekitOrigin!);
    // The LiveKit signalling socket is answered by the test and held open (no LiveKit server), so the page stays "connecting".
    const sockets: { route: WebSocketRoute; closed: boolean }[] = [];
    await A.routeWebSocket(/\/rtc(\/|\?|$)/, (ws) => {
      const s = { route: ws, closed: false };
      sockets.push(s);
      ws.onClose(() => { s.closed = true; });
    });
    await ua.join.focus();
    await A.keyboard.press("Enter");
    await expect.poll(() => sockets.length, { timeout: 30_000 }).toBe(1);
    expect(sockets[0]!.closed).toBe(false);

    // The runtime stream drops (the web server goes away and comes back): the page leaves the room at once, without a failure.
    const restarted = stack.restartBff();
    await expect(A.getByText("Reconnecting", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => sockets[0]!.closed, { timeout: 10_000, message: "the page closed its LiveKit socket" }).toBe(true);
    await expect(A.locator(".mic [role=alert]")).toHaveCount(0);
    await restarted;
    // The fresh joined: a NEW token and a new connection, once, with no click.
    await expect.poll(() => tokens.count(), { timeout: 60_000 }).toBe(2);
    await expect.poll(() => sockets.length, { timeout: 30_000 }).toBe(2);
    await A.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("the microphone tracks stop when the seat is superseded or removed", async ({ browser }) => {
    test.setTimeout(240_000);
    const second = await createSession(fac, stack.baseUrl);
    const runCheck = async (role: Player) => {
      const s = await voiceSeat(browser, stack.baseUrl, second.sessionId, role, second.codes[role]);
      opened.push(s.context);
      const u = ui(s.page);
      await u.withVoice.check();
      await Promise.all([s.page.waitForResponse(isVoicePost), u.save.click()]);
      await expect(u.saved).toHaveText(/Voice: on$/);
      await u.check.click();
      await expect(s.page.locator(".mic-words")).toHaveText("Hearing you", { timeout: 30_000 });
      expect(await trackStates(s.page)).toEqual(["live"]);
      return s;
    };

    // Superseded: the same person opens the session page again in another tab.
    const sup = await runCheck("tech_lead");
    const other = await sup.context.newPage();
    await other.goto(`${stack.baseUrl}/session/${second.sessionId}`);
    await expect(sup.page.getByRole("heading", { name: "Open in another tab" })).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => trackStates(sup.page), { timeout: 10_000 }).toEqual(["ended"]);

    // Removed: the facilitator removes the seat in the lobby.
    const rem = await runCheck("delivery_lead");
    await fac.goto(`${stack.baseUrl}/console/${second.sessionId}`);
    await expectSeatReady(fac, "delivery_lead");
    await fac.getByRole("button", { name: `Remove ${NAMES.delivery_lead} from ${ROLE_LABEL.delivery_lead}` }).click();
    const dialog = fac.getByRole("dialog");
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(rem.page.getByRole("heading", { name: "Removed from the session" })).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => trackStates(rem.page), { timeout: 10_000 }).toEqual(["ended"]);
  });
});

test.describe("voice on, but no LiveKit in the web server", () => {
  let stack: LauncherStack | null = null;
  const opened: BrowserContext[] = [];
  test.afterEach(async () => {
    for (const c of opened.splice(0)) await c.close().catch(() => undefined);
    await stack?.stop();
    stack = null;
  });

  test("no microphone exception in any header, and the voice option says why it is not offered", async ({ browser }) => {
    test.setTimeout(240_000);
    stack = await startLauncherStack({ voice: { livekitUrl: false } });
    for (const p of ["/session/abc123", "/console", "/join", "/api/v1/stream"]) {
      const r = await rawGet(`${stack.baseUrl}${p}`);
      expect(all(r.headers, "permissions-policy"), p).toEqual(["camera=(), microphone=(), geolocation=()"]);
      for (const c of all(r.headers, "content-security-policy")) expect(connectSrc(c), p).toBe("connect-src 'self'");
    }
    const fac = await facilitator(browser, stack.baseUrl, stack.facilitatorSecret);
    opened.push(fac.context());
    const { sessionId, codes } = await createSession(fac, stack.baseUrl);
    const a = await voiceSeat(browser, stack.baseUrl, sessionId, "account_manager", codes.account_manager);
    opened.push(a.context);
    const u = ui(a.page);
    await expect(u.saved).toHaveText(/Voice: not chosen$/);
    await expect(u.withVoice).toBeDisabled();
    await expect(u.withVoice).toHaveAccessibleDescription("Voice is not available in this session.");
    await expect(u.check).toHaveCount(0);
    await expect(u.join).toHaveCount(0);
    expect(await gum(a.page)).toBe(0);
    await axe(a.page, "lobby without LiveKit", ["section.card.voice"]);
  });
});

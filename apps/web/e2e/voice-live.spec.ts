import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkBothSchemes, createSession, expectSeatReady, facilitator, startButton } from "./helpers/console";
import { consent, joinAsLauncher, playerContext, transcript, type Player } from "./helpers/players";
import { startLauncherStack, type LauncherStack } from "./helpers/start-launcher-stack";
import { REPO_ROOT } from "./helpers/start-stack";

// US-0071 (EPIC-0003 voice A1b, Task 18): the OPT-IN browser live check against a REAL LiveKit server. Skipped unless VOICE_LIVE=1;
// never in CI or the default e2e run. The harness sets LIVEKIT_LIVE_URL (ws://127.0.0.1:<port>), LIVEKIT_LIVE_HOST
// (http://127.0.0.1:<port>), LIVEKIT_LIVE_KEY and LIVEKIT_LIVE_SECRET for a throwaway local server (never `--dev` keys).
// The real stack runs with SPEECH_INGEST=livekit and the fake speech-to-text (a script of lines for the voice seat); the REAL token
// route is used (no page.route); Chromium has a fake microphone playing tone bursts. It proves: a successful "Join with voice" (focus to
// "Mute microphone"); the worker hears the seat only after the start and a voice line reaches the transcript; the console's "Speaking";
// Mute (aria-pressed, "Microphone muted") UNPUBLISHES the microphone track on the server (D40) and stops transcription; unmute and
// rapid toggles keep audio flowing; "Stop using voice" and its focus move; a stale browser reconnecting with the old token is removed by
// control's sweep and never heard; the teardown of a published track on the final `ended`; Axe on the connected and muted states;
// nothing in the page console, the services' output or the speech log names the token, the room or the identity.
// The server is read through its own admin API (twirp) with a short-lived admin token made here for that room only. Nothing is printed
// but counts and seconds.
const LIVE = process.env.VOICE_LIVE === "1";

/** A 16 kHz mono WAV of tone bursts: 1.5 s of 440 Hz at -12 dBFS, then 1.5 s of silence (Chromium loops the file). */
function writeBurstWav(file: string): void {
  const rate = 16_000;
  const n = rate * 3;
  const amp = Math.round(32767 * 10 ** (-12 / 20));
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(i < rate * 1.5 ? Math.round(amp * Math.sin((2 * Math.PI * 440 * i) / rate)) : 0, 44 + i * 2);
  writeFileSync(file, b);
}
const WAV_DIR = mkdtempSync(path.join(os.tmpdir(), "acr-voice-live-wav-"));
const WAV = path.join(WAV_DIR, "bursts.wav");
writeBurstWav(WAV);
process.once("exit", () => rmSync(WAV_DIR, { recursive: true, force: true }));

test.use({
  trace: "off",
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${WAV}`],
  },
});

/** The page's getUserMedia tracks (livekit-client's included), kept from an init script that runs before any page script. */
function instrument(): void {
  const w = window as unknown as { __tracks: MediaStreamTrack[] };
  w.__tracks = [];
  const md = navigator.mediaDevices;
  if (md && typeof md.getUserMedia === "function") {
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = (c?: MediaStreamConstraints) => orig(c).then((s) => { for (const t of s.getTracks()) w.__tracks.push(t); return s; });
  }
}
const trackStates = (p: Page) => p.evaluate(() => (window as unknown as { __tracks: MediaStreamTrack[] }).__tracks.map((t) => t.readyState));

type Live = { url: string; host: string; apiKey: string; apiSecret: string };
function liveEnv(): Live {
  const { LIVEKIT_LIVE_URL: url, LIVEKIT_LIVE_HOST: host, LIVEKIT_LIVE_KEY: apiKey, LIVEKIT_LIVE_SECRET: apiSecret } = process.env;
  if (!url || !host || !apiKey || !apiSecret) throw new Error("VOICE_LIVE=1 needs LIVEKIT_LIVE_URL, LIVEKIT_LIVE_HOST, LIVEKIT_LIVE_KEY and LIVEKIT_LIVE_SECRET");
  return { url, host, apiKey, apiSecret };
}

/** A 60-second HS256 admin token for one room (the claims LiveKit reads); made here, used for the twirp calls below only. */
function adminToken(env: Live, room: string): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = `${b({ alg: "HS256", typ: "JWT" })}.${b({ iss: env.apiKey, nbf: now - 10, exp: now + 60, video: { roomAdmin: true, room } })}`;
  return `${head}.${createHmac("sha256", env.apiSecret).update(head).digest("base64url")}`;
}
type Participant = { identity: string; tracks?: { source?: string | number }[] };
/** The room's participants as the server sees them (hidden ones included); [] when the room does not exist. */
async function participants(env: Live, room: string): Promise<Participant[]> {
  const r = await fetch(`${env.host}/twirp/livekit.RoomService/ListParticipants`, {
    method: "POST", headers: { Authorization: `Bearer ${adminToken(env, room)}`, "Content-Type": "application/json" }, body: JSON.stringify({ room }),
  });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`ListParticipants answered ${r.status}`);
  return ((await r.json()) as { participants?: Participant[] }).participants ?? [];
}
const isMic = (t: { source?: string | number }) => t.source === "MICROPHONE" || t.source === 2;
const micTracks = (ps: Participant[], identity: string) => (ps.find((p) => p.identity === identity)?.tracks ?? []).filter(isMic).length;
const workers = (ps: Participant[]) => ps.filter((p) => p.identity.startsWith("SPEECH.")).length;

/** The claims of a LiveKit token the browser received: its room and identity (kept in memory only, never printed). */
function claims(token: string): { room: string; identity: string } {
  const p = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { sub?: string; video?: { room?: string } };
  return { room: p.video!.room!, identity: p.sub! };
}

/** How many fake transcriptions ran for `roleId` (the fake records role and ordinal per call, never text). */
function sttCalls(stack: LauncherStack, roleId: string): number {
  if (!stack.sttCalls || !existsSync(stack.sttCalls)) return 0;
  return readFileSync(stack.sttCalls, "utf8").split("\n").filter((l) => l !== "" && (JSON.parse(l) as { roleId: string }).roleId === roleId).length;
}

const NAMES: Record<Player, string> = { delivery_lead: "Dana Lead", tech_lead: "Tomás Tech", account_manager: "Ama Voice" };
const VOICE_ROLE: Player = "account_manager";
const LINES = Array.from({ length: 300 }, (_, i) => `Voice line ${i + 1} from the live check.`);
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
/** A window in which NOTHING may happen (AGENTS.md section 8: a real wait that only gets safer the longer it is). */
const QUIET_MS = 6_000;

async function voiceViolations(page: Page, selector: string) {
  const r = await new AxeBuilder({ page }).include(selector).withTags(WCAG).analyze();
  return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target.join(" ")) }));
}
async function axe(page: Page, screen: string, selectors: string[]): Promise<void> {
  await checkBothSchemes(page, screen);
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" && !a.pending));
    for (const s of selectors) expect(await voiceViolations(page, s), `${screen}: ${s} (${scheme})`).toEqual([]);
  }
}

const ui = (p: Page) => ({
  saved: p.getByRole("region", { name: "Voice", exact: true }).locator(":scope > p").first(),
  withVoice: p.getByRole("radio", { name: "Take part with voice" }),
  textOnly: p.getByRole("radio", { name: "Take part by text only" }),
  save: p.getByRole("button", { name: "Save choice" }),
  join: p.getByRole("button", { name: "Join with voice" }),
  mute: p.getByRole("button", { name: "Mute microphone" }),
  stop: p.getByRole("button", { name: "Stop using voice" }),
  micState: p.locator(".mic .mic-state"),
});
const isVoicePost = (r: { url(): string; request(): { method(): string } }) => new URL(r.url()).pathname === "/api/v1/voice" && r.request().method() === "POST";
const isTokenAnswer = (r: { url(): string }) => new URL(r.url()).pathname === "/api/v1/voice/token";
const voiceLines = (p: Page) => transcript(p).getByText(/^Voice line \d+ from the live check\.$/);

test.describe("voice against a real LiveKit server (VOICE_LIVE=1)", () => {
  test.skip(!LIVE, "opt-in: VOICE_LIVE=1 with a local LiveKit server");
  test.describe.configure({ mode: "serial" });

  let env: Live;
  let stack: LauncherStack;
  let fac: Page;
  let sessionId: string;
  let A: Page;
  let room = "";
  let identity = "";
  const tokens: string[] = [];
  const consoleText: string[] = [];
  const output: string[] = [];
  const opened: BrowserContext[] = [];

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    env = liveEnv();
    stack = await startLauncherStack({ onOutput: (l) => output.push(l), voice: { live: env, sttLines: { [VOICE_ROLE]: LINES } } });
  });
  test.afterAll(async () => {
    for (const c of opened.splice(0)) await c.close().catch(() => undefined);
    await stack?.stop();
  });

  /** Clicks "Join with voice" and returns the token route's answer (the real route: 200 with exactly token, url and expiresAt). */
  async function joinWithVoice(page: Page): Promise<void> {
    const u = ui(page);
    const [answer] = await Promise.all([page.waitForResponse(isTokenAnswer), u.join.click()]);
    expect(answer.status()).toBe(200);
    const data = ((await answer.json()) as { data: { token: string; url: string; expiresAt: number } }).data;
    expect(Object.keys(data).sort()).toEqual(["expiresAt", "token", "url"]);
    expect(data.url).toBe(env.url);
    tokens.push(data.token);
    ({ room, identity } = claims(data.token));
    await expect(u.mute).toBeVisible({ timeout: 60_000 });
    await expect(u.mute).toBeFocused();
    await expect(u.mute).toHaveAttribute("aria-pressed", "false");
  }

  test("lobby: Join with voice through the real token route publishes a microphone track into the seat's own room", async ({ browser }) => {
    test.setTimeout(300_000);
    fac = await facilitator(browser, stack.baseUrl, stack.facilitatorSecret);
    opened.push(fac.context());
    const created = await createSession(fac, stack.baseUrl);
    sessionId = created.sessionId;
    for (const role of ["delivery_lead", "tech_lead", VOICE_ROLE] as const) {
      const context = await playerContext(browser);
      opened.push(context);
      await context.grantPermissions(["microphone"], { origin: stack.baseUrl });
      await context.addInitScript(instrument);
      const page = await context.newPage();
      await joinAsLauncher(page, stack.baseUrl, sessionId, role, created.codes[role], NAMES[role]);
      await consent(page);
      if (role === VOICE_ROLE) A = page;
    }
    A.on("console", (m) => consoleText.push(m.text()));
    const u = ui(A);
    await u.withVoice.check();
    await Promise.all([A.waitForResponse(isVoicePost), u.save.click()]);
    await expect(u.saved).toHaveText(/Voice: on$/);
    await joinWithVoice(A);
    await expect(u.micState).toHaveText(/Microphone on, not recorded until the session starts/);
    expect(room).toMatch(/^v[0-9a-f]{32}$/);
    await expect.poll(async () => micTracks(await participants(env, room), identity), { timeout: 30_000 }).toBe(1);
    const ps = await participants(env, room);
    expect(ps.length, "only this seat in its room: no worker before the start").toBe(1);
    await axe(A, "lobby, connected with voice", ["section.card.voice", ".mic"]);
  });

  test("scene: the worker hears the seat only now, a voice line reaches the transcript and the console shows Speaking", async () => {
    test.setTimeout(300_000);
    const u = ui(A);
    expect(sttCalls(stack, VOICE_ROLE), "nothing was transcribed in the lobby").toBe(0);
    await fac.goto(`${stack.baseUrl}/console/${sessionId}`);
    for (const role of ["delivery_lead", "tech_lead", VOICE_ROLE] as const) await expectSeatReady(fac, role);
    await expect(startButton(fac)).toBeEnabled();
    await startButton(fac).click();
    await expect(A.getByRole("heading", { name: "Play the scene" })).toBeVisible({ timeout: 60_000 });
    await expect(u.micState).toHaveText(/Microphone on, recording/, { timeout: 60_000 });
    await expect.poll(async () => workers(await participants(env, room)), { timeout: 60_000, message: "the hidden worker joined the seat room" }).toBe(1);
    await expect(voiceLines(A).first()).toBeVisible({ timeout: 120_000 });
    expect(sttCalls(stack, VOICE_ROLE)).toBeGreaterThan(0);
    for (const role of ["delivery_lead", "tech_lead"]) expect(sttCalls(stack, role), role).toBe(0);
    // The console: the voice panel's row for the seat says Speaking at some point (the bursts start and stop speech).
    const row = fac.getByRole("region", { name: "Voice", exact: true }).getByRole("row").filter({ has: fac.getByRole("rowheader", { name: /Ama Voice/ }) });
    await expect(row).toContainText("Speaking", { timeout: 60_000 });
  });

  test("mute unpublishes the microphone on the server and stops transcription; unmute and rapid toggles keep audio flowing", async () => {
    test.setTimeout(300_000);
    const u = ui(A);
    await u.mute.click();
    await expect(u.mute).toHaveAttribute("aria-pressed", "true");
    await expect(u.micState).toHaveText(/Microphone muted/);
    await expect.poll(async () => micTracks(await participants(env, room), identity), { timeout: 30_000, message: "no microphone track while muted" }).toBe(0);
    expect((await participants(env, room)).some((p) => p.identity === identity), "the seat stays in its room while muted").toBe(true);
    // Transcription stops: once the in-flight segment is done, the count holds through a long quiet window.
    let settled = -1;
    await expect.poll(async () => { const n = sttCalls(stack, VOICE_ROLE); const same = n === settled; settled = n; return same; }, { timeout: 60_000, intervals: [3_000] }).toBe(true);
    await A.waitForTimeout(QUIET_MS); // a window in which nothing may happen
    expect(sttCalls(stack, VOICE_ROLE)).toBe(settled);
    await axe(A, "scene, muted", ["section.card.voice", ".mic"]);

    await u.mute.click();
    await expect(u.mute).toHaveAttribute("aria-pressed", "false");
    await expect(u.micState).toHaveText(/Microphone on, recording/);
    await expect.poll(async () => micTracks(await participants(env, room), identity), { timeout: 30_000 }).toBe(1);
    await expect.poll(() => sttCalls(stack, VOICE_ROLE), { timeout: 60_000, message: "transcription resumed after unmute" }).toBeGreaterThan(settled);
    await axe(A, "scene, connected and recording", ["section.card.voice", ".mic"]);

    // Rapid toggles, each waiting only for the button's own state.
    for (let i = 0; i < 3; i++) {
      await u.mute.click();
      await expect(u.mute).toHaveAttribute("aria-pressed", "true");
      await u.mute.click();
      await expect(u.mute).toHaveAttribute("aria-pressed", "false");
    }
    await expect.poll(async () => micTracks(await participants(env, room), identity), { timeout: 30_000 }).toBe(1);
    const afterToggles = sttCalls(stack, VOICE_ROLE);
    await expect.poll(() => sttCalls(stack, VOICE_ROLE), { timeout: 60_000, message: "audio flows after rapid toggles" }).toBeGreaterThan(afterToggles);
  });

  test("Stop using voice leaves the room; a stale browser reconnecting with the old token is removed by control's sweep and never heard", async ({ browser }) => {
    test.setTimeout(300_000);
    const u = ui(A);
    await Promise.all([A.waitForResponse(isVoicePost), u.stop.click()]);
    await expect(u.textOnly).toBeFocused();
    await expect(u.textOnly).toBeChecked();
    await expect(u.saved).toHaveText(/Voice: off \(text only\)$/);
    await expect.poll(async () => (await participants(env, room)).some((p) => p.identity === identity), { timeout: 30_000 }).toBe(false);
    let settled = -1;
    await expect.poll(async () => { const n = sttCalls(stack, VOICE_ROLE); const same = n === settled; settled = n; return same; }, { timeout: 60_000, intervals: [3_000] }).toBe(true);
    const linesBefore = await voiceLines(A).count();

    // The stale browser: livekit-client loaded from the package, the seat's last token (still valid for 600 s), and
    // a tone published as a microphone. Control expects nobody in this seat room now, so its periodic sweep (20 s) must remove it.
    // A page of the app's own origin (a loopback secure context; about:blank is refused the loopback connection by Chromium), with
    // the page's CSP bypassed so the test can add the library; it has no cookie, so the app itself does nothing there.
    const rogue = await browser.newContext({ bypassCSP: true });
    opened.push(rogue);
    const page = await rogue.newPage();
    await page.goto(`${stack.baseUrl}/session/abc123`);
    await page.addScriptTag({ path: path.join(REPO_ROOT, "apps", "web", "node_modules", "livekit-client", "dist", "livekit-client.umd.js") });
    const joined = await page.evaluate(async ({ url, token }) => {
      const LK = (window as unknown as { LivekitClient: typeof import("livekit-client") }).LivekitClient;
      LK.setLogLevel("silent");
      const r = new LK.Room();
      const w = window as unknown as { __gone?: number; __joined?: number };
      r.on(LK.RoomEvent.Disconnected, () => { w.__gone = Date.now(); });
      await r.connect(url, token, { autoSubscribe: false });
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const dest = ctx.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      await r.localParticipant.publishTrack(dest.stream.getAudioTracks()[0]!, { source: LK.Track.Source.Microphone });
      w.__joined = Date.now();
      return true;
    }, { url: env.url, token: tokens[tokens.length - 1]! });
    expect(joined).toBe(true);
    await expect.poll(async () => micTracks(await participants(env, room), identity), { timeout: 30_000, message: "the stale browser published" }).toBe(1);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __gone?: number }).__gone !== undefined), { timeout: 60_000, intervals: [500], message: "control's sweep removed the stale browser" }).toBe(true);
    const seconds = await page.evaluate(() => { const w = window as unknown as { __gone: number; __joined: number }; return Math.round((w.__gone - w.__joined) / 1000); });
    console.log(`the stale browser was removed about ${seconds} s after it published (sweep interval 20 s)`);
    expect((await participants(env, room)).some((p) => p.identity === identity)).toBe(false);
    await A.waitForTimeout(QUIET_MS);
    expect(sttCalls(stack, VOICE_ROLE), "the stale browser was never transcribed").toBe(settled);
    expect(await voiceLines(A).count()).toBe(linesBefore);
  });

  test("the final ended event tears the published track down and the seat room is deleted", async () => {
    test.setTimeout(300_000);
    const u = ui(A);
    await u.withVoice.check();
    await Promise.all([A.waitForResponse(isVoicePost), u.save.click()]);
    await expect(u.saved).toHaveText(/Voice: on$/);
    await joinWithVoice(A);
    await expect.poll(async () => micTracks(await participants(env, room), identity), { timeout: 30_000 }).toBe(1);
    expect((await trackStates(A)).filter((s) => s === "live").length, "one live microphone track").toBe(1);

    const controls = fac.getByRole("region", { name: "Facilitator controls" });
    await controls.getByRole("button", { name: "End session", exact: true }).click();
    await fac.getByRole("dialog").getByRole("button", { name: "End session", exact: true }).click();
    await expect(A.getByRole("heading", { name: "The session has ended" })).toBeVisible({ timeout: 60_000 });
    await expect.poll(async () => (await trackStates(A)).every((s) => s === "ended"), { timeout: 20_000, message: "every microphone track stopped" }).toBe(true);
    await expect(u.mute).toHaveCount(0);
    await expect.poll(async () => (await participants(env, room)).length, { timeout: 30_000, message: "the seat room is gone" }).toBe(0);
  });

  test("nothing in the page console, the services' output or the speech log names a token, the room, the identity or a LiveKit key", async () => {
    test.setTimeout(60_000);
    const logDir = path.join(stack.dataDir, "child-logs");
    const speechLogs = existsSync(logDir) ? readdirSync(logDir).filter((f) => f.endsWith(".speech.log")).map((f) => readFileSync(path.join(logDir, f), "utf8")) : [];
    expect(speechLogs.length).toBeGreaterThan(0);
    const secrets = [env.apiKey, env.apiSecret, room, identity, ...tokens, ...tokens.map((t) => t.split(".")[1]!)];
    const texts: [string, string][] = [["the page console", consoleText.join("\n")], ["the services' output", output.join("\n")], ...speechLogs.map((t, i) => [`speech log ${i + 1}`, t] as [string, string])];
    for (const [where, text] of texts) {
      for (const s of secrets) expect(text.includes(s), `${where} holds a value of length ${s.length}`).toBe(false);
      expect(text.includes(`${VOICE_ROLE}.g`), `${where} holds a seat identity`).toBe(false);
      expect(text.includes("SPEECH."), `${where} holds a worker identity`).toBe(false);
    }
  });
});

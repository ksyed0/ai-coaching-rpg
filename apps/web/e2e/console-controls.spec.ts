import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  checkBothSchemes,
  createSession,
  expectSeatReady,
  FAC_NAME,
  facilitator,
  JOIN_REFUSED,
  noHorizontalScroll,
  ROLE_LABEL,
  startButton,
} from "./helpers/console";
import { joinAsLauncher, playerContext, PLAYERS, say, seatLauncher, trackStreams, type Player } from "./helpers/players";
import { startLauncherStack, type LauncherStack } from "./helpers/start-launcher-stack";

// US-0059: the facilitator's controls against the real control service (mock models, temp data dir) and `next start` in launcher
// mode. Every wait is on an effect (auto-retrying expect, waitForResponse, expect.poll); no fixed sleep and no assertion on elapsed
// time. Each test starts its own stack (the suite's wall time is recorded in the commit message).

let stack: LauncherStack | null = null;
const opened: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of opened.splice(0)) await c.close().catch(() => undefined);
  await stack?.stop();
  stack = null;
});

const NAMES: Record<Player, string> = {
  delivery_lead: "Dana Lead",
  tech_lead: "Tomás Tech",
  account_manager: "Ama Accounts",
};
/** "Name (Role label)", as the confirmations name a seated player. */
const WHO = (r: Player) => `${NAMES[r]} (${ROLE_LABEL[r]})`;
const INJECT_TEXT = "Quick one. Before go-live we need a small reconciliation module";
/** The hidden fact of the client sponsor (scenarios/friday-escalation/roles/client_sponsor.yaml). */
const FACT_TEXT = "Would accept a phased delivery after go-live if the risk is explained well";
const BUSY = "This session is open in too many console tabs. Close one, then reload this page.";
const STALE = "The scene changed. Review the live view and try again.";

type Live = {
  stack: LauncherStack;
  fac: Page;
  sessionId: string;
  players: Record<Player, { context: BrowserContext; page: Page }>;
};

/** A started session: three players joined and consented, the facilitator's console on the live view with its controls. */
async function startedSession(browser: Browser): Promise<Live> {
  stack = await startLauncherStack();
  const fac = await facilitator(browser, stack.baseUrl, stack.facilitatorSecret);
  const { sessionId, codes } = await createSession(fac, stack.baseUrl);
  const players = {} as Live["players"];
  for (const role of PLAYERS)
    players[role] = await seatLauncher(browser, stack.baseUrl, sessionId, role, codes[role], NAMES[role]);
  await fac.goto(`${stack.baseUrl}/console/${sessionId}`);
  for (const role of PLAYERS) await expectSeatReady(fac, role);
  await startButton(fac).click();
  await expect(fac.getByText("The session has started.", { exact: true })).toBeVisible();
  await expect(fac.getByRole("heading", { name: "Live session" })).toBeVisible();
  opened.push(fac.context(), ...PLAYERS.map((r) => players[r].context));
  await liveControls(fac);
  // Joined people sit in the roster, and once the session runs nobody can be removed from it (Remove is a lobby action).
  await expect(fac.getByRole("button", { name: /^Reissue code for / })).toHaveCount(3);
  await expect(fac.getByRole("button", { name: /^Remove / })).toHaveCount(0);
  return { stack, fac, sessionId, players };
}

const controls = (p: Page) => p.getByRole("region", { name: "Facilitator controls" });
const dialog = (p: Page) => p.getByRole("dialog");
const timeline = (p: Page) => p.getByRole("list", { name: "Transcript and notices" });
const entry = (p: Page, text: string) => timeline(p).locator("li").filter({ hasText: text });
const updates = (p: Page) => p.getByRole("region", { name: "Your brief" }).locator("li.gm");
const scene = (n: number, title: string) => new RegExp(`^Scene ${n} of [23]: ${title}$`);
/** The status line of the controls (polite, always mounted). */
/** The "Paused" pill of the scene bar on a player's or the facilitator's page (the header repeats it, so the main region only). */
const pausedPill = (p: Page) => p.getByRole("main").getByText("Paused", { exact: true });
const status = (p: Page, text: string) => controls(p).getByRole("status").getByText(text, { exact: true });

/** The controls are mounted and enabled, i.e. the stream is live and the session is running. */
async function liveControls(p: Page): Promise<void> {
  await expect(controls(p)).toBeVisible();
  await expect(controls(p).getByRole("button", { name: /^(Pause|Resume)$/ })).toBeEnabled();
}

/** Confirms the open dialog with its confirm button and waits until it is gone. */
async function confirmDialog(p: Page, label: string): Promise<void> {
  await dialog(p).getByRole("button", { name: label, exact: true }).click();
  await expect(dialog(p)).toHaveCount(0);
}

/** No player page holds `needle` in its text or markup. */
async function expectNoPlayerHas(live: Live, needle: string): Promise<void> {
  for (const r of PLAYERS) {
    const page = live.players[r].page;
    await expect(page.locator("body")).not.toContainText(needle);
    expect(await page.content(), `${r} page markup`).not.toContain(needle);
  }
}

test("pause, whisper and resume: the player sees the pause and the whisper, another player does not see the whisper, the console timeline says \"Paused by Ann Facilitator\" and no player page contains the facilitator's name", async ({ browser }) => {
  test.setTimeout(300_000);
  const live = await startedSession(browser);
  const { fac, players } = live;
  const lead = players.delivery_lead.page;
  const whisper = "Privately: keep the price out of the first reply";

  await controls(fac).getByRole("button", { name: "Pause", exact: true }).click();
  await expect(status(fac, "Paused.")).toBeVisible();
  await expect(controls(fac).getByRole("button", { name: "Resume", exact: true })).toBeEnabled();
  await expect(entry(fac, `Paused by ${FAC_NAME}`)).toHaveCount(1);
  await expect(pausedPill(lead)).toBeVisible();
  await expect(lead.getByLabel("Say something")).toBeDisabled();

  await controls(fac).getByLabel("To", { exact: true }).selectOption({ label: WHO("delivery_lead") });
  await controls(fac).getByLabel("Message", { exact: true }).fill(whisper);
  await controls(fac).getByRole("button", { name: "Send whisper", exact: true }).click();
  await expect(dialog(fac).getByRole("heading", { name: `Whisper to ${WHO("delivery_lead")}?` })).toBeVisible();
  await expect(dialog(fac)).toContainText(`Only ${WHO("delivery_lead")} sees this message. It cannot be taken back.`);
  await expect(dialog(fac)).toContainText(whisper);
  await confirmDialog(fac, "Send whisper");
  await expect(status(fac, "Whisper sent.")).toBeVisible();

  await expect(updates(lead).filter({ hasText: whisper })).toHaveCount(1);
  await expect(entry(fac, `Whisper to ${NAMES.delivery_lead} by ${FAC_NAME}`)).toHaveCount(1);
  // The whisper reached the delivery lead first (above), so the others' silence is an absence after delivery, not before it.
  for (const r of ["tech_lead", "account_manager"] as const) {
    await expect(players[r].page.locator("body")).not.toContainText(whisper);
    await expect(pausedPill(players[r].page)).toBeVisible();
  }

  await controls(fac).getByRole("button", { name: "Resume", exact: true }).click();
  await expect(status(fac, "Resumed.")).toBeVisible();
  await expect(entry(fac, `Resumed by ${FAC_NAME}`)).toHaveCount(1);
  await expect(lead.getByLabel("Say something")).toBeEnabled();
  await expect(pausedPill(lead)).toHaveCount(0);

  for (const r of PLAYERS) {
    const page = players[r].page;
    await expect(page.locator("body")).not.toContainText(FAC_NAME);
    expect(await page.content(), `${r} page markup`).not.toContain(FAC_NAME);
  }
  expect(await lead.content()).toContain(whisper); // the target did get it, so the checks above look at a page that had something to hide
  await expect(players.tech_lead.page.locator("body")).not.toContainText(whisper);
});

test("fire the scene's inject again: the dialog names the three players; each sees it twice", async ({ browser }) => {
  test.setTimeout(300_000);
  const { fac, players } = await startedSession(browser);
  for (const r of PLAYERS) await expect(updates(players[r].page).filter({ hasText: INJECT_TEXT })).toHaveCount(1);

  await controls(fac).getByRole("button", { name: "Fire inject email_from_priya again", exact: true }).click();
  await expect(dialog(fac).getByRole("heading", { name: "Fire inject “email_from_priya” again?" })).toBeVisible();
  const audience = `${WHO("delivery_lead")}, ${WHO("tech_lead")} and ${WHO("account_manager")}`;
  await expect(dialog(fac)).toContainText(`It is shown to ${audience}. It cannot be taken back.`);
  await expect(dialog(fac)).toContainText(INJECT_TEXT);
  await confirmDialog(fac, "Fire inject");
  await expect(status(fac, "Inject fired.")).toBeVisible();

  for (const r of PLAYERS) await expect(updates(players[r].page).filter({ hasText: INJECT_TEXT })).toHaveCount(2);
  await expect(entry(fac, `Inject email_from_priya fired by ${FAC_NAME}`)).toHaveCount(1);
});

test("move on in one tab while a second tab's Move on dialog is open: once both tabs show \"Call with Priya\", the second tab confirms and gets \"The scene changed. Review the live view and try again.\"", async ({ browser }) => {
  test.setTimeout(300_000);
  const { fac, sessionId, stack: s } = await startedSession(browser);
  const second = await fac.context().newPage(); // closed with the facilitator's context
  await second.goto(`${s.baseUrl}/console/${sessionId}`);
  await liveControls(second);
  await expect(second.getByText(scene(1, "Team huddle"))).toBeVisible();

  for (const p of [fac, second]) {
    await controls(p).getByRole("button", { name: "Move on", exact: true }).click();
    await expect(dialog(p).getByRole("heading", { name: "Move on from “Team huddle”?" })).toBeVisible();
  }
  // Confirming before the scene changes is accepted by design (it repeats the request), so the second tab waits for the new scene.
  await confirmDialog(fac, "Move on");
  await expect(status(fac, "Moving on to the next scene.")).toBeVisible();
  await expect(fac.getByText(scene(2, "Call with Priya"))).toBeVisible();
  await expect(second.getByText(scene(2, "Call with Priya"))).toBeVisible();
  await expect(dialog(second)).toBeVisible(); // still open: a stream update does not close a confirmation

  await confirmDialog(second, "Move on");
  await expect(second.getByRole("alert").getByText(STALE, { exact: true })).toBeVisible();
  await expect(second.getByText(scene(2, "Call with Priya"))).toBeVisible(); // the scene changed once
  await expect(entry(second, "Scene “Call with Priya” begins")).toHaveCount(1);
});

test("release a hidden fact and change a stance: the dialog reads \"Release fact 1 of Client sponsor?\"; the timeline shows the release and the stance change by Ann Facilitator; no player page contains the fact text", async ({ browser }) => {
  test.setTimeout(300_000);
  const live = await startedSession(browser);
  const { fac } = live;
  const factRequests: string[] = [];
  fac.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname.endsWith("/facts")) factRequests.push(r.url());
  });
  const summary = controls(fac).getByText("Hidden facts (1)", { exact: true });
  await expect(summary).toBeVisible();

  // Closed: no text in the page and no request for it.
  await expect(fac.locator("body")).not.toContainText(FACT_TEXT);
  expect(await fac.content()).not.toContain(FACT_TEXT);
  expect(factRequests).toEqual([]);

  // A real click on the summary opens the <details>: exactly one /facts request for that open.
  const [answer] = await Promise.all([
    fac.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/facts") && r.request().method() === "POST"),
    summary.click(),
  ]);
  expect(answer.status()).toBe(200);
  await expect(controls(fac).getByText(`Fact 1: ${FACT_TEXT}`)).toBeVisible();
  expect(factRequests).toHaveLength(1);

  await controls(fac).getByRole("button", { name: "Release fact 1 of Client sponsor", exact: true }).click();
  await expect(dialog(fac).getByRole("heading", { name: "Release fact 1 of Client sponsor?" })).toBeVisible();
  await expect(dialog(fac)).toContainText("Client sponsor may now share this fact with everyone in the room. It cannot be taken back.");
  await confirmDialog(fac, "Release fact");
  await expect(status(fac, "Fact released.")).toBeVisible();
  await expect(entry(fac, `Fact 1 of Client sponsor released by ${FAC_NAME}`)).toHaveCount(1);
  await expect(controls(fac).getByRole("button", { name: "Release fact 1 of Client sponsor" })).toHaveCount(0);

  const goals = "Hold the line on price\nAsk for a written change request";
  await controls(fac).getByLabel("Goals of Client sponsor, one per line").fill(goals);
  await controls(fac).getByRole("button", { name: "Set stance of Client sponsor", exact: true }).click();
  await expect(status(fac, "Stance changed.")).toBeVisible();
  await expect(entry(fac, `Stance of Client sponsor changed by ${FAC_NAME}`)).toHaveCount(1);

  // Closing the list takes the text out of the page again.
  await summary.click();
  await expect(fac.locator("body")).not.toContainText(FACT_TEXT);
  expect(await fac.content()).not.toContain(FACT_TEXT);

  await expectNoPlayerHas(live, FACT_TEXT);
  await expectNoPlayerHas(live, "phased delivery");
  await expectNoPlayerHas(live, "Hold the line on price");
  expect(factRequests, "one /facts request in all, for the one open").toHaveLength(1);
});

test("end now with a closing message: players see the message, the console keeps its view and shows \"The session has ended.\" exactly once, the controls are gone, and a reload shows the lobby's ended status with no controls", async ({ browser }) => {
  test.setTimeout(300_000);
  const { fac, players, sessionId, stack: s } = await startedSession(browser);
  const closing = "Thank you all. We stop here for today.";

  await controls(fac).getByRole("button", { name: "End session", exact: true }).click();
  await expect(dialog(fac).getByRole("heading", { name: "End the session now?" })).toBeVisible();
  await expect(dialog(fac)).toContainText("Nobody can speak after this and the session cannot be restarted.");
  await dialog(fac).getByLabel("Closing message to participants (optional)").fill(closing);
  await confirmDialog(fac, "End session");

  for (const r of PLAYERS) {
    const page = players[r].page;
    await expect(page.getByRole("heading", { name: "The session has ended" })).toBeVisible();
    await expect(page.getByText(`Message from the facilitator: ${closing}`)).toBeVisible();
  }
  // The console keeps its view and says so once; the controls are gone.
  await expect(fac.getByText("The session has ended.", { exact: true })).toHaveCount(1);
  await expect(fac.getByRole("heading", { name: "Live session" })).toBeVisible();
  await expect(entry(fac, `Session ended. Message to participants: ${closing}`)).toHaveCount(1);
  await expect(controls(fac)).toHaveCount(0);
  await expect(fac.getByRole("heading", { name: "Facilitator controls" })).toHaveCount(0);
  await expect(fac.getByText("The session has ended.", { exact: true })).toHaveCount(1);
  // BUG-0022: the End session button and its dialog are gone, so keyboard focus is on the final banner (not the page body).
  await expect(fac.getByText("The session has ended.", { exact: true })).toBeFocused();

  await fac.goto(`${s.baseUrl}/console/${sessionId}`);
  await expect(fac.getByText("This session has ended.", { exact: true })).toBeVisible();
  await expect(fac.getByRole("heading", { name: "Who is in the room" })).toBeVisible();
  await expect(fac.getByRole("heading", { name: "Live session" })).toHaveCount(0);
  await expect(controls(fac)).toHaveCount(0);
  await expect(fac.getByRole("button", { name: /^Remove / })).toHaveCount(0);
});

test("remove a participant before the start: the dialog names the person and the role, the player sees \"Removed from the session\", a new code is shown once and the old code is refused", async ({ browser }) => {
  test.setTimeout(300_000);
  stack = await startLauncherStack();
  const s = stack;
  const fac = await facilitator(browser, s.baseUrl, s.facilitatorSecret);
  const { sessionId, codes } = await createSession(fac, s.baseUrl);
  const lead = await seatLauncher(browser, s.baseUrl, sessionId, "delivery_lead", codes.delivery_lead, NAMES.delivery_lead);
  opened.push(fac.context(), lead.context);
  await fac.goto(`${s.baseUrl}/console/${sessionId}`);
  await expectSeatReady(fac, "delivery_lead");
  // Only a seat with a person in it offers Remove.
  await expect(fac.getByRole("button", { name: /^Remove / })).toHaveCount(1);

  await fac.getByRole("button", { name: `Remove ${NAMES.delivery_lead} from ${ROLE_LABEL.delivery_lead}`, exact: true }).click();
  const title = `Remove ${NAMES.delivery_lead} from ${ROLE_LABEL.delivery_lead}?`;
  await expect(dialog(fac).getByRole("heading", { name: title })).toBeVisible();
  await expect(dialog(fac)).toContainText(
    `They are signed out of the ${ROLE_LABEL.delivery_lead} seat and their code stops working. A new code for the seat is shown once. This affects the ${ROLE_LABEL.delivery_lead} role only.`,
  );
  // The confirmation, at both widths and in both schemes.
  for (const width of [1280, 400] as const) {
    await fac.setViewportSize({ width, height: 860 });
    await checkBothSchemes(fac, `the Remove confirmation at ${width} px`);
    await noHorizontalScroll(fac, width);
  }
  await fac.setViewportSize({ width: 1280, height: 860 });
  await confirmDialog(fac, "Remove");

  await expect(lead.page.getByRole("heading", { name: "Removed from the session" })).toBeVisible();
  const panel = fac.getByRole("region", { name: `New code for ${ROLE_LABEL.delivery_lead}` });
  await expect(panel).toBeVisible();
  const fresh = (await panel.locator("code").innerText()).trim();
  expect(fresh).not.toBe("");
  expect(fresh).not.toBe(codes.delivery_lead);
  // Shown once: dismissing it, and a reload, leave no trace of it.
  await panel.getByRole("button", { name: "I have copied the codes" }).click();
  await expect(panel).toHaveCount(0);
  expect(await fac.content()).not.toContain(fresh);
  await fac.reload();
  await expectSeatNotJoined(fac);
  expect(await fac.content()).not.toContain(fresh);

  // The old code is refused, the new one is not.
  const stranger = await playerContext(browser);
  opened.push(stranger);
  const refused = await stranger.newPage();
  await refused.goto(`${s.baseUrl}/join?session=${sessionId}&role=delivery_lead`);
  await refused.getByLabel("Your name").fill("Dana Again");
  await refused.getByLabel("Your join code").fill(codes.delivery_lead);
  await refused.getByRole("button", { name: "Join" }).click();
  await expect(refused.getByText(JOIN_REFUSED)).toBeVisible();
  const welcome = await stranger.newPage();
  await joinAsLauncher(welcome, s.baseUrl, sessionId, "delivery_lead", fresh, "Dana Again");
});

async function expectSeatNotJoined(p: Page): Promise<void> {
  const row = p.locator("tbody tr").filter({ has: p.getByRole("rowheader", { name: ROLE_LABEL.delivery_lead, exact: true }) });
  await expect(row.locator("td").nth(1)).toHaveText(/No/);
  await expect(p.getByRole("button", { name: /^Remove / })).toHaveCount(0);
}

test("channel cases: a fifth console tab shows the busy message; with the console offline a player's line is said, and back online the console stream reopens with a Last-Event-ID and shows the line once; after crashRuntimes the console shows \"The session stopped. Restart it from this page.\", Restart brings the live view back, paused, with the earlier line", async ({ browser }) => {
  test.setTimeout(420_000);
  const { fac, players, sessionId, stack: s } = await startedSession(browser);
  const context = fac.context();
  const streamPath = `/api/v1/console/sessions/${sessionId}/stream`;

  // A fifth tab: the first four are live, the fifth is told to close one.
  const extra: Page[] = [];
  for (let i = 0; i < 3; i++) {
    const p = await context.newPage();
    await p.goto(`${s.baseUrl}/console/${sessionId}`);
    await liveControls(p);
    extra.push(p);
  }
  const fifth = await context.newPage();
  await fifth.goto(`${s.baseUrl}/console/${sessionId}`);
  await expect(fifth.getByText(BUSY, { exact: true })).toBeVisible();
  await expect(controls(fifth)).toHaveCount(0);
  for (const p of [...extra, fifth]) await p.close();

  // Offline console. Chromium keeps an open EventSource through `setOffline(true)` (probed: no reconnecting banner appears within the
  // expect timeout), so the offline context only blocks the retries and the BFF restart is what drops the open stream.
  const streams = trackStreams(fac, streamPath);
  await context.setOffline(true);
  await s.restartBff();
  await expect(fac.getByText("Reconnecting… The live view catches up by itself.", { exact: true })).toBeVisible();
  const line = "While the console was offline I wrote this";
  await say(players.tech_lead.page, line);
  await expect(entry(fac, line)).toHaveCount(0); // the console cannot have it yet
  await context.setOffline(false);
  await expect(entry(fac, line)).toHaveCount(1);
  expect(streams.length, "the console stream was opened again").toBeGreaterThanOrEqual(1);
  const reopened = streams.filter((o) => o.lastEventId !== null && o.status === 200);
  expect(reopened.length, `a reopen carried a Last-Event-ID: ${JSON.stringify(streams)}`).toBeGreaterThanOrEqual(1);
  await expect(fac.getByText("Reconnecting… The live view catches up by itself.", { exact: true })).toHaveCount(0);
  await expect(entry(fac, line)).toHaveCount(1); // once, not replayed twice

  // A runtime crash: the console says so, Restart brings the live view back, paused, with the line.
  await s.crashRuntimes();
  await expect(fac.getByText("The session stopped. Restart it from this page.", { exact: true })).toBeVisible();
  await fac.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(fac.getByRole("heading", { name: "Live session" })).toBeVisible();
  await expect(controls(fac).getByRole("button", { name: "Resume", exact: true })).toBeEnabled();
  await expect(pausedPill(fac)).toBeVisible();
  await expect(entry(fac, line)).toHaveCount(1);
  await expect(fac.getByText("The session stopped. Restart it from this page.", { exact: true })).toHaveCount(0);
});

test("no serious or critical Axe violations with the controls, the expanded facts list and each confirmation dialog open, at 1280 px and 400 px, light and dark, with no horizontal scroll at either width", async ({ browser }) => {
  test.setTimeout(480_000);
  const { fac } = await startedSession(browser);
  // Untrusted-looking and unbroken text must wrap, not widen the page.
  const long = `W${"w".repeat(190)} <img src=x onerror=alert(1)> ‮evil`;
  const factRequest = () => fac.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/facts") && r.request().method() === "POST");

  await controls(fac).getByLabel("Message", { exact: true }).fill(long);
  const [answer] = await Promise.all([factRequest(), controls(fac).getByText("Hidden facts (1)", { exact: true }).click()]);
  expect(answer.status()).toBe(200);
  await expect(controls(fac).getByText(`Fact 1: ${FACT_TEXT}`)).toBeVisible();

  const opens: [string, () => Promise<void>][] = [
    ["Move on", () => controls(fac).getByRole("button", { name: "Move on", exact: true }).click()],
    ["End session", () => controls(fac).getByRole("button", { name: "End session", exact: true }).click()],
    ["Fire inject", () => controls(fac).getByRole("button", { name: "Fire inject email_from_priya again", exact: true }).click()],
    ["Send whisper", () => controls(fac).getByRole("button", { name: "Send whisper", exact: true }).click()],
    ["Release fact", () => controls(fac).getByRole("button", { name: "Release fact 1 of Client sponsor", exact: true }).click()],
  ];

  for (const width of [1280, 400] as const) {
    await fac.setViewportSize({ width, height: 860 });
    await expect(controls(fac)).toBeVisible();
    await checkBothSchemes(fac, `the controls with the facts list open at ${width} px`);
    await noHorizontalScroll(fac, width);
    for (const [name, open] of opens) {
      await open();
      await expect(dialog(fac)).toBeVisible();
      await checkBothSchemes(fac, `the ${name} confirmation at ${width} px`);
      await noHorizontalScroll(fac, width);
      await dialog(fac).getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog(fac)).toHaveCount(0);
    }
  }
});

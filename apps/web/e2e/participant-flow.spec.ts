import { expect, test, type Page } from "@playwright/test";
import { consent, joinAs, playerContext, PLAYERS, say, seat, trackStreams, transcript, type Player } from "./helpers/players";
import { SESSION_ID, startStack, type Stack } from "./helpers/start-stack";

// The participant pages against the real stack: the runtime in mock mode (its own process, private temp data dir), `next start` with
// injected COOKIE_KEYS, and the facilitator on the runtime's own protocol (as the terminal client). Every wait is on an effect
// (Playwright's auto-retrying expect, or expect.poll); no fixed sleep and no assertion on elapsed time. Generous explicit limits.

const NAMES: Record<Player, string> = { delivery_lead: "Dana <b>Lead</b>", tech_lead: "Tomás Tech", account_manager: "Ama Accounts" };
const REFUSED = "That did not work. Check the link and the code, or ask your facilitator for a new code.";

let stack: Stack | null = null;
test.afterEach(async () => { await stack?.stop(); stack = null; });

const reconnecting = (page: Page) => page.getByText(/^Reconnecting… The page catches up/);
const sayBox = (page: Page) => page.getByLabel("Say something");

test("three players join with names and consent, the terminal facilitator starts, everyone speaks, one drop recovers, a BFF restart recovers, and a second tab supersedes the first", async ({ browser }) => {
  test.setTimeout(240_000);
  stack = await startStack();
  const pages = {} as Record<Player, Page>;
  for (const role of PLAYERS) pages[role] = (await seat(browser, stack, role, NAMES[role])).page;
  const streams = Object.fromEntries(PLAYERS.map((r) => [r, trackStreams(pages[r])])) as Record<Player, ReturnType<typeof trackStreams>>;
  /** Waits until `role`'s page has opened a new stream since `before`, and returns the Last-Event-ID that request carried. */
  const reopened = async (role: Player, before: number) => {
    await expect.poll(() => streams[role].length, { timeout: 60_000 }).toBeGreaterThan(before);
    const entry = streams[role].at(-1)!;
    await expect.poll(() => entry.lastEventId, { timeout: 30_000 }).not.toBeNull();
    return entry.lastEventId;
  };

  // The production cookie, unchanged: Chromium keeps a Secure, __Host- cookie on http://localhost (a secure context), so the test
  // needs no weaker flags. The page cannot read it (HttpOnly).
  const [cookie] = await pages.delivery_lead.context().cookies();
  expect(cookie).toMatchObject({ name: "__Host-scenecoach", secure: true, httpOnly: true, sameSite: "Lax", path: "/" });
  expect(await pages.delivery_lead.evaluate(() => document.cookie)).toBe("");

  // The lobby shows everyone, by the name they typed (as text, never markup), and ready once they consented.
  const lobby = pages.account_manager;
  for (const role of PLAYERS) await expect(lobby.locator(".roster .seat").filter({ hasText: role === "account_manager" ? "(you)" : NAMES[role] })).toContainText("Ready");
  await expect(lobby.getByText("Dana <b>Lead</b>", { exact: true })).toBeVisible();
  await expect(lobby.locator(".roster b b")).toHaveCount(0);

  // Start: every page leaves the lobby for the running scene, with its title, goal and a clock that counts down.
  await stack.terminalFacilitator.start();
  for (const role of PLAYERS) {
    await expect(pages[role].getByRole("heading", { name: "Play the scene" })).toBeVisible();
    // Each player counts only the scenes they are in (the tech lead is not in the client call).
    await expect(pages[role].getByText(/^Scene 1 of [23]: Team huddle$/)).toBeVisible();
    await expect(pages[role].getByText(/^Goal: Agree the team's position/)).toBeVisible();
    // The opening inject reaches the brief panel.
    await expect(pages[role].getByText(/Email from Priya Raman/)).toBeVisible();
  }
  const timer = pages.delivery_lead.locator(".timer-value");
  await expect(timer).toHaveText(/^\d{1,2}:\d{2}$/);
  const first = await timer.textContent();
  await expect.poll(() => timer.textContent(), { timeout: 30_000 }).not.toBe(first);

  // Everyone speaks; every line reaches every page once.
  const lines: Record<Player, string> = { delivery_lead: "Did everyone see the email from Priya?", tech_lead: "Yes. Before go-live it is a real risk.", account_manager: "We cannot simply say no to her." };
  for (const role of PLAYERS) await say(pages[role], lines[role]);
  for (const role of PLAYERS) for (const line of Object.values(lines)) await expect(transcript(pages[role]).getByText(line, { exact: true })).toHaveCount(1);
  // My own line reads "You"; a colleague's carries the name they typed.
  await expect(transcript(pages.tech_lead).locator(".msg").filter({ hasText: lines.tech_lead }).locator(".h b")).toHaveText("You");
  await expect(transcript(pages.tech_lead).locator(".msg").filter({ hasText: lines.delivery_lead }).locator(".h b")).toHaveText(NAMES.delivery_lead);

  // Pause: the say box is off with the reason in words and the scene shows Paused; resume turns it back on.
  await stack.terminalFacilitator.command({ command: "pause" });
  for (const role of PLAYERS) {
    await expect(pages[role].getByRole("main").locator(".pill", { hasText: "Paused" })).toBeVisible();
    await expect(sayBox(pages[role])).toBeDisabled();
    await expect(pages[role].getByRole("button", { name: "Say", exact: true })).toBeDisabled();
    await expect(pages[role].getByText("The facilitator has paused the scene. You can speak again when it resumes.")).toBeVisible();
  }
  await stack.terminalFacilitator.command({ command: "resume" });
  for (const role of PLAYERS) await expect(sayBox(pages[role])).toBeEnabled();

  // One drop: the tech lead's runtime socket is cut. The page shows Reconnecting, comes back by itself, and catches up on a line said
  // while it was away, exactly once.
  const opensBeforeDrop = streams.tech_lead.length;
  stack.dropSocket("tech_lead");
  await expect(reconnecting(pages.tech_lead)).toBeVisible({ timeout: 30_000 });
  await say(pages.delivery_lead, "Said while the tech lead was away.");
  // The browser reopens the stream itself, from where it was (Last-Event-ID), not from the start.
  expect(await reopened("tech_lead", opensBeforeDrop)).toMatch(/^[1-9]\d*$/);
  await expect.poll(() => reconnecting(pages.tech_lead).count(), { timeout: 60_000 }).toBe(0);
  await expect(transcript(pages.tech_lead).getByText("Said while the tech lead was away.", { exact: true })).toHaveCount(1);
  for (const line of Object.values(lines)) await expect(transcript(pages.tech_lead).getByText(line, { exact: true })).toHaveCount(1);
  await say(pages.tech_lead, "Back again after the drop.");
  await expect(transcript(pages.account_manager).getByText("Back again after the drop.", { exact: true })).toHaveCount(1);

  // A BFF restart (same COOKIE_KEYS): every page reconnects with its cookie and Last-Event-ID and keeps its seat.
  const opensBeforeRestart = Object.fromEntries(PLAYERS.map((r) => [r, streams[r].length])) as Record<Player, number>;
  await stack.restartBff();
  for (const role of PLAYERS) {
    expect(await reopened(role, opensBeforeRestart[role])).toMatch(/^[1-9]\d*$/);
    await expect.poll(() => reconnecting(pages[role]).count(), { timeout: 60_000 }).toBe(0);
    await expect(sayBox(pages[role])).toBeEnabled({ timeout: 60_000 });
  }
  await say(pages.account_manager, "Still here after the restart.");
  for (const role of PLAYERS) {
    await expect(transcript(pages[role]).getByText("Still here after the restart.", { exact: true })).toHaveCount(1);
    for (const line of Object.values(lines)) await expect(transcript(pages[role]).getByText(line, { exact: true })).toHaveCount(1);
    // The seat was kept: nobody was signed out.
    await expect(pages[role].getByText(/ask your facilitator for a new code/)).toHaveCount(0);
  }

  // A second tab for the delivery lead supersedes the first, which stops and says why; the new tab plays on.
  const second = await pages.delivery_lead.context().newPage();
  await second.goto(`${stack.baseUrl}/session/${SESSION_ID}`);
  await expect(pages.delivery_lead.getByText("This session is open in another tab. Use that tab, or reload this page to continue here.")).toBeVisible({ timeout: 30_000 });
  await expect(pages.delivery_lead.getByRole("heading", { name: "Open in another tab" })).toBeVisible();
  await say(second, "Now speaking from the second tab.");
  await expect(transcript(pages.tech_lead).getByText("Now speaking from the second tab.", { exact: true })).toHaveCount(1);
  // The first tab does not fight back: it stays superseded while the second keeps working.
  await say(second, "And the second tab still holds the seat.");
  await expect(pages.delivery_lead.getByRole("heading", { name: "Open in another tab" })).toBeVisible();

  // The end: the facilitator advances through the remaining scenes; the transcript stays and the say box goes.
  for (let i = 0; i < 3; i++) await stack.terminalFacilitator.command({ command: "advance" });
  for (const page of [second, pages.tech_lead, pages.account_manager]) {
    await expect(page.getByRole("heading", { name: "The session has ended" })).toBeVisible({ timeout: 30_000 });
    await expect(sayBox(page)).toHaveCount(0);
  }
  await expect(transcript(pages.tech_lead).getByText(lines.tech_lead, { exact: true })).toHaveCount(1);
});

test("start is refused while one player has not consented and the page shows the roster state", async ({ browser }) => {
  test.setTimeout(120_000);
  stack = await startStack();
  const dl = await seat(browser, stack, "delivery_lead", "Dana");
  const tl = await seat(browser, stack, "tech_lead", "Tomás");
  const am = await seat(browser, stack, "account_manager", "Ama", { consent: false });

  // The roster: two ready, one joined but not ready.
  const seatOf = (page: Page, name: string) => page.locator(".roster .seat").filter({ hasText: name });
  await expect(seatOf(dl.page, "Ama")).toContainText("Joined");
  await expect(seatOf(dl.page, "Tomás")).toContainText("Ready");

  // The facilitator's start is refused, naming nothing a player could see; every page stays in the lobby.
  await expect(stack.terminalFacilitator.start()).rejects.toThrow(/seats_not_ready/);
  for (const page of [dl.page, tl.page, am.page]) await expect(page.getByRole("heading", { name: "Join your session" })).toBeVisible();

  // The join code stops working once a credential exists for the role (web seats): another browser with the same code is refused.
  const other = await (await playerContext(browser)).newPage();
  await other.goto(`${stack.baseUrl}/join?session=${SESSION_ID}&role=account_manager`);
  await other.getByLabel("Your name").fill("Someone Else");
  await other.getByLabel("Your join code").fill(stack.codes.account_manager!);
  await other.getByRole("button", { name: "Join" }).click();
  await expect(other.locator("p.err[role=alert]")).toHaveText(REFUSED);
  await expect(other).toHaveURL(/\/join\?/);

  // Once the last player consents, the roster says so and the start goes through.
  await consent(am.page);
  await expect(seatOf(dl.page, "Ama")).toContainText("Ready");
  await stack.terminalFacilitator.start();
  await expect(am.page.getByRole("heading", { name: "Play the scene" })).toBeVisible();
});

test("after a runtime restart with an empty log the player sees 'ask your facilitator for a new code'", async ({ browser }) => {
  test.setTimeout(120_000);
  stack = await startStack();
  const context = await playerContext(browser);
  const page = await context.newPage();
  const oldCode = stack.codes.tech_lead!;
  await joinAs(page, stack, "tech_lead", "Tomás");
  await consent(page);

  // Nothing was ever started, so the log is empty: the restart issues new codes and discards the credentials and consent.
  await stack.restartRuntime();
  expect(stack.codes.tech_lead).not.toBe(oldCode);
  await expect(page.getByText("You are signed out of this session: ask your facilitator for a new code.")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "Signed out" })).toBeVisible();
  // The page does not keep retrying: a reload with the cleared cookie reads the same.
  await page.reload();
  await expect(page.getByText("You are signed out of this session: ask your facilitator for a new code.")).toBeVisible({ timeout: 30_000 });

  // The facilitator's new code seats the player again.
  await joinAs(page, stack, "tech_lead", "Tomás");
});

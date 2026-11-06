import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { checkBothSchemes as checkSchemes, noHorizontalScroll as noOverflow } from "./helpers/console";
import { dismiss, endedSession, issueLink, openPanel, releaseRole, seedDraft } from "./helpers/reports";
import { startLauncherStack, type LauncherStack } from "./helpers/start-launcher-stack";
import { joinUrl, playerContext, PLAYERS, say, seat, type Player } from "./helpers/players";
import { SESSION_ID, startStack, type Stack } from "./helpers/start-stack";

// Accessibility on the participant screens (join, lobby, session view, and the other-tab, connection-closed and ended screens), in the light and the dark scheme (prefers-color-scheme emulated), and the phone
// width. Styling is class-only (the CSP allows only nonce'd styles), so what Axe sees is what a participant sees.

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

let stack: Stack | null = null;
let launcher: LauncherStack | null = null;
const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  await stack?.stop();
  stack = null;
  for (const c of contexts.splice(0)) await c.close().catch(() => undefined);
  await launcher?.stop();
  launcher = null;
});

/** Serious and critical violations only, reduced to what a failure message needs. */
async function seriousViolations(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target.join(" ")) }));
}
async function checkBothSchemes(page: Page, screen: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), `${screen}: the ${scheme} scheme is in effect`).toBe(scheme === "dark");
    // Switching the scheme starts the buttons' background-colour transition while their text colour flips at once; Axe measures
    // computed colours, so measuring mid-transition reads a half-way background (seen in CI as a failing button contrast). Wait for
    // every animation and transition on the page to finish first.
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" && !a.pending));
    expect(await seriousViolations(page), `${screen} (${scheme})`).toEqual([]);
  }
}
const noHorizontalScroll = (page: Page) => page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));

/** All three seats joined and consented (the session is not started yet), each page at `width`. */
async function seatedAndConsented(browser: Browser, width?: number): Promise<Record<Player, Page>> {
  const pages = {} as Record<Player, Page>;
  for (const role of PLAYERS) pages[role] = (await seat(browser, stack!, role, `Person ${role}`, { width })).page;
  return pages;
}

test("no serious or critical Axe violations on /join, the lobby, the session view and the final screens, in light and dark", async ({ browser }) => {
  test.setTimeout(240_000);
  stack = await startStack();

  const joinCtx = await playerContext(browser);
  const join = await joinCtx.newPage();
  await join.goto(joinUrl(stack, "delivery_lead"));
  await expect(join.getByRole("heading", { level: 1 })).toBeVisible();
  await checkBothSchemes(join, "/join");
  // The join page with a refusal on it (the alert text and the field states).
  await join.getByLabel("Your name").fill("Dana");
  await join.getByLabel("Your join code").fill("WRONG-CODE");
  await join.getByRole("button", { name: "Join" }).click();
  await expect(join.locator("p.err[role=alert]")).toBeVisible();
  await checkBothSchemes(join, "/join (refused)");

  const pages = await seatedAndConsented(browser);
  await checkBothSchemes(pages.delivery_lead, "the lobby");

  await stack.terminalFacilitator.start();
  for (const role of PLAYERS) await expect(pages[role].getByRole("heading", { name: "Play the scene" })).toBeVisible();
  await say(pages.tech_lead, "A line so the transcript has a colleague in it.");
  await say(pages.delivery_lead, "And one of my own.");
  await checkBothSchemes(pages.delivery_lead, "the session view");
  await stack.terminalFacilitator.command({ command: "pause" });
  await expect(pages.delivery_lead.getByLabel("Say something")).toBeDisabled();
  await checkBothSchemes(pages.delivery_lead, "the session view (paused)");

  // The final screens: another tab took the seat; a stream the browser closed (no cookie, a 401); the end with the transcript kept.
  const second = await pages.delivery_lead.context().newPage();
  await second.goto(`${stack.baseUrl}/session/${SESSION_ID}`);
  await expect(pages.delivery_lead.getByRole("heading", { name: "Open in another tab" })).toBeVisible({ timeout: 30_000 });
  await checkBothSchemes(pages.delivery_lead, "open in another tab");
  const stranger = await (await playerContext(browser)).newPage();
  await stranger.goto(`${stack.baseUrl}/session/${SESSION_ID}`);
  await expect(stranger.getByRole("heading", { name: "Connection closed" })).toBeVisible({ timeout: 30_000 });
  await checkBothSchemes(stranger, "connection closed");
  await stack.terminalFacilitator.command({ command: "resume" });
  for (let i = 0; i < 3; i++) await stack.terminalFacilitator.command({ command: "advance" });
  await expect(pages.tech_lead.getByRole("heading", { name: "The session has ended" })).toBeVisible({ timeout: 30_000 });
  await checkBothSchemes(pages.tech_lead, "the end");
});

test("no horizontal scroll at 400 px", async ({ browser }) => {
  test.setTimeout(150_000);
  stack = await startStack();
  const ctx = await playerContext(browser, { width: 400 });
  const join = await ctx.newPage();
  await join.goto(joinUrl(stack, "account_manager"));
  await expect(join.getByLabel("Your join code")).toBeVisible();
  expect(await noHorizontalScroll(join)).toEqual({ scroll: 400, client: 400 });

  const pages = await seatedAndConsented(browser, 400);
  expect(await noHorizontalScroll(pages.delivery_lead), "the lobby").toEqual({ scroll: 400, client: 400 });
  await stack.terminalFacilitator.start();
  for (const role of PLAYERS) await expect(pages[role].getByRole("heading", { name: "Play the scene" })).toBeVisible();
  // A long unbroken word must wrap, not widen the page.
  await say(pages.tech_lead, `A${"a".repeat(180)}h, said without a single space to break it.`);
  await say(pages.delivery_lead, "A short reply.");
  for (const role of PLAYERS) expect(await noHorizontalScroll(pages[role]), `the session view (${role})`).toEqual({ scroll: 400, client: 400 });
});

// ---- US-0063: the participant report page's states and the console panel's draft rows (launcher stack, seeded review folders) ----

const WIDTHS = [1280, 400];
async function checkAt(page: Page, screen: string): Promise<void> {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 860 });
    await checkSchemes(page, `${screen} (${width}px)`);
    await noOverflow(page, width);
  }
}

/** A draft player's session: ended, one review with bob still a draft, a link issued and opened in a fresh participant context. */
async function draftParticipant(browser: Browser): Promise<{ fac: Page; participant: Page; sessionId: string; link: string }> {
  const l = launcher!;
  const { fac, sessionId } = await endedSession(browser, l);
  contexts.push(fac.context());
  await seedDraft(l, sessionId);
  await openPanel(fac, l, sessionId);
  const link = await issueLink(fac);
  await dismiss(fac);
  const ctx = await browser.newContext({ extraHTTPHeaders: { "X-Forwarded-For": "127.0.0.1" }, viewport: { width: 1280, height: 860 } });
  contexts.push(ctx);
  const participant = await ctx.newPage();
  await participant.goto(link);
  await participant.waitForURL("**/report");
  await expect(participant.getByRole("button", { name: "Save my ratings" })).toBeVisible();
  return { fac, participant, sessionId, link };
}

test("Axe: the self-rating form, its busy error, and the released page with the table, responses and forms; and the console panel with a draft row", async ({ browser }) => {
  test.setTimeout(300_000);
  launcher = await startLauncherStack();
  const { fac, participant, sessionId } = await draftParticipant(browser);

  // The console panel with a draft row (Bob) and a released row (Alice), at both widths in both schemes.
  await openPanel(fac, launcher, sessionId);
  await expect(fac.getByText("Rated 0 of 3 criteria")).toBeVisible();
  await checkAt(fac, "the report links panel with a draft row");

  // The form as it first opens, then with choices and a note, then with the save error summary the busy answer produces.
  await checkAt(participant, "the self-rating form");
  await participant.getByRole("group", { name: "Discovery", exact: true }).getByRole("radio", { name: /^Developing/ }).check();
  await participant.getByRole("group", { name: "Discovery", exact: true }).getByLabel("Note (optional)").fill("A note so the counter has a value.");
  await checkAt(participant, "the self-rating form with a note");

  // The busy state is hard to produce through the real stack (it needs a held review lock), so the BFF's answer is intercepted.
  await participant.route("**/api/v1/report/self-ratings", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ success: false, data: { state: "busy" }, error: { code: "busy", message: "" } }) }),
  );
  await participant.getByRole("button", { name: "Save my ratings" }).click();
  await expect(participant.locator("[role=alert].banner")).toContainText("Busy, try again");
  await checkAt(participant, "the self-rating form (busy)");
  await participant.unroute("**/api/v1/report/self-ratings");

  // Released, with a response and a dispute on the page: the table, the responses list and the response form.
  await releaseRole(launcher, sessionId);
  await participant.reload();
  await expect(participant.getByRole("heading", { name: "Your report" })).toBeVisible();
  const respond = participant.getByRole("form", { name: "Send a response" });
  await respond.getByLabel("Your response").fill("I disagree with the level on this one.");
  await respond.getByRole("checkbox", { name: "I disagree with this" }).check();
  await respond.getByRole("button", { name: "Send", exact: true }).click();
  await expect(participant.getByText("1 of 50 used")).toBeVisible();
  await checkAt(participant, "the released report with the table, responses and forms");
});

test("Axe: the closed, old_schema, throttled and not_released states of /report", async ({ browser }) => {
  test.setTimeout(300_000);
  launcher = await startLauncherStack();
  const { participant } = await draftParticipant(browser);

  // These states are hard to produce through the real stack (a closed or old-schema review needs a different seeded log, throttling
  // needs a burst of reads), so the BFF's GET /api/v1/report answer is intercepted in the browser with the fixed body control would give.
  const states: { name: string; status: number; body: unknown; text: RegExp }[] = [
    { name: "closed", status: 200, body: { success: true, data: { state: "closed" }, error: null }, text: /Ratings for this review are closed/ },
    { name: "old_schema", status: 200, body: { success: true, data: { state: "old_schema" }, error: null }, text: /opened before online ratings/ },
    { name: "not_released", status: 200, body: { success: true, data: { state: "not_released" }, error: null }, text: /not available right now/ },
    { name: "throttled", status: 429, body: { success: false, data: null, error: { code: "throttled", message: "" } }, text: /Too many requests/ },
  ];
  for (const st of states) {
    const handler = (route: import("@playwright/test").Route) =>
      route.fulfill({ status: st.status, contentType: "application/json", headers: st.status === 429 ? { "Retry-After": "30" } : {}, body: JSON.stringify(st.body) });
    await participant.route("**/api/v1/report", handler);
    await participant.reload();
    await expect(participant.getByRole("status")).toContainText(st.text);
    await checkAt(participant, `/report ${st.name}`);
    await participant.unroute("**/api/v1/report", handler);
  }
});

// ---- US-0064 part A: the console Report panel's states (launcher stack; the draft is seeded, see report-moderation.spec.ts) ----

test("Axe: the Report panel ready to evaluate, with a refused name, the evaluate confirmation, in review with the subject list, and a subject view with an open edit form", async ({ browser }) => {
  test.setTimeout(300_000);
  launcher = await startLauncherStack();
  const { fac, sessionId } = await endedSession(browser, launcher);
  contexts.push(fac.context());
  const report = fac.getByRole("region", { name: "Report", exact: true });

  // not_evaluated: the ready sentence and Evaluate; first with a name the rule refuses (the alert), then with a valid one.
  await expect(report.getByText("Evaluate this session to draft a report for each player and the group.")).toBeVisible();
  await report.getByLabel("Your name for the review record").fill("priya console");
  await expect(report.getByRole("alert")).toBeVisible();
  await checkAt(fac, "the Report panel with a refused name");
  await report.getByLabel("Your name for the review record").fill("priya");
  await expect(report.getByRole("button", { name: "Evaluate…" })).toBeEnabled();
  await checkAt(fac, "the Report panel ready to evaluate");

  // The confirmation dialog (cancelled: this test spends nothing).
  await report.getByRole("button", { name: "Evaluate…" }).click();
  await expect(fac.getByRole("dialog")).toContainText("makes up to 8 model calls");
  await checkAt(fac, "the evaluate confirmation");
  await fac.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(fac.getByRole("dialog")).toHaveCount(0);

  // in_review: the run summary and the subject list (the seed opens the review), then bob's view, then its edit form.
  await seedDraft(launcher, sessionId);
  await fac.reload();
  await expect(report.getByText("The reports are drafted and the review is open.")).toBeVisible();
  await expect(report.getByRole("button", { name: "Review Bob" })).toBeVisible();
  await checkAt(fac, "the Report panel in review with the subject list");
  await report.getByRole("button", { name: "Review Bob" }).click();
  await expect(report.getByRole("button", { name: "Edit Discovery" })).toBeEnabled();
  await checkAt(fac, "the subject view");
  await report.getByRole("button", { name: "Edit Discovery" }).click();
  await expect(report.getByLabel("Reason (required; shown to the participant)")).toBeVisible();
  await checkAt(fac, "the subject view with an open edit form");
});

// ---- US-0064 part B: the release, amend and withdraw dialogs, the dispute panel and the export menu (launcher stack, seeded draft) ----

test("Axe: the release, amend and withdraw dialogs, the open-dispute panel and the export menu", async ({ browser }) => {
  test.setTimeout(300_000);
  launcher = await startLauncherStack();
  const { fac, participant, sessionId } = await draftParticipant(browser);

  // Bob released (the terminal's own function), then a dispute from his page: the console then has a dispute to resolve.
  await releaseRole(launcher, sessionId);
  await participant.reload();
  await expect(participant.getByRole("heading", { name: "Your report" })).toBeVisible();
  const respond = participant.getByRole("form", { name: "Send a response" });
  await respond.getByLabel("Your response").fill("I disagree with the level on this one.");
  await respond.getByRole("checkbox", { name: "I disagree with this" }).check();
  await respond.getByRole("button", { name: "Send", exact: true }).click();
  await expect(participant.getByText("1 of 50 used")).toBeVisible();

  await fac.goto(`${launcher.baseUrl}/console/${sessionId}`);
  const report = fac.getByRole("region", { name: "Report", exact: true });
  await report.getByLabel("Your name for the review record").fill("priya");
  await expect(report.getByRole("button", { name: "Review Bob" })).toBeVisible();

  // The export menu (alice and bob are released) and bob's view with the open dispute and its resolve form.
  await expect(report.getByRole("region", { name: "Export" }).getByRole("button", { name: "Download" })).toBeEnabled();
  await report.getByRole("button", { name: "Review Bob" }).click();
  await expect(report.locator(".report-disputes").getByLabel("Reason shown to the participant (required)")).toBeVisible();
  await checkAt(fac, "the subject view with an open dispute, and the export menu");

  // Each dialog, opened and cancelled (this test changes nothing).
  const dialog = fac.getByRole("dialog");
  const cancel = async () => {
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  };
  await report.getByRole("region", { name: "Release" }).getByRole("button", { name: "Release everything…" }).click();
  await expect(dialog.getByText("Every participant, with the other participants' individual results removed")).toBeVisible();
  await checkAt(fac, "the release dialog");
  await cancel();
  await report.getByRole("button", { name: "Amend Bob" }).click();
  await expect(dialog.getByLabel("Reason for the amendment (required)")).toBeVisible();
  await checkAt(fac, "the amend dialog");
  await cancel();
  await report.getByRole("button", { name: "Withdraw Alice" }).click();
  await expect(dialog.getByText("Withdrawing cannot be undone.")).toBeVisible();
  await checkAt(fac, "the withdraw dialog");
  await cancel();
});

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { checkBothSchemes, noHorizontalScroll } from "./helpers/console";
import { playerContext } from "./helpers/players";
import {
  BOB,
  CANARY_LEVEL,
  CANARY_RATIONALE,
  dismiss,
  endedSession,
  issueLink,
  openPanel,
  OLD_RUN_TEXT,
  REFUSED,
  reissue,
  revoke,
  RERUN_TEXT,
  RESOLVE_REASON,
  releaseRole,
  resolveDispute,
  seedDraft,
  seedReports,
} from "./helpers/reports";
import { startLauncherStack, type LauncherStack } from "./helpers/start-launcher-stack";

// US-0062: participant report access in the browser, against the real control service (mock models, temp data dir with a released
// review and a re-run seeded under reports/) and `next start` in launcher mode. Every wait is on an effect; no fixed sleep and no
// assertion on elapsed time.

let stack: LauncherStack | null = null;
const opened: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of opened.splice(0)) await c.close().catch(() => undefined);
  await stack?.stop();
  stack = null;
});

/** A fresh browser context, nobody signed in: what a participant has. `address` is the client address the BFF throttles on. */
async function fresh(browser: Browser, o: { address?: string; width?: number; javaScriptEnabled?: boolean } = {}): Promise<BrowserContext> {
  const c = await browser.newContext({
    extraHTTPHeaders: { "X-Forwarded-For": o.address ?? "127.0.0.1" },
    viewport: { width: o.width ?? 1200, height: 860 },
    javaScriptEnabled: o.javaScriptEnabled ?? true,
  });
  opened.push(c);
  return c;
}

const DRAFT_KEY = "scenecoach-report-draft";
const REPORT_COOKIE = "__Host-scenecoach-report";
const CLOSED = "Ratings for this review are closed.";

/** Opens a draft player's link and waits for the self-rating form (the report does not exist for them yet). */
async function openForm(page: Page, link: string): Promise<void> {
  await page.goto(link);
  await page.waitForURL("**/report");
  await expect(page.getByRole("button", { name: "Save my ratings" })).toBeVisible();
}

/** One criterion's fieldset (its legend is the criterion name). */
const criterion = (page: Page, name: string) => page.getByRole("group", { name, exact: true });
/** Picks a level of the generic scale for a criterion by its label ("Developing", "Proficient", "Advanced", ...). */
const rate = (page: Page, name: string, label: string) => criterion(page, name).getByRole("radio", { name: new RegExp(`^${label}`) }).check();
const hasDraft = (page: Page) => page.evaluate((k) => sessionStorage.getItem(k) !== null, DRAFT_KEY);
const reportCookies = (page: Page) => page.context().cookies().then((c) => c.filter((x) => x.name === REPORT_COOKIE));

type Recorded = { url: string; method: string; body: Promise<string | null> };
/** Starts recording every response the page receives (HTML, JSON, scripts), for the canary checks. Await `settle()` before asserting on the bodies. */
function recordBodies(page: Page): { settle(): Promise<{ url: string; method: string; body: string }[]> } {
  const all: Recorded[] = [];
  page.on("response", (r) => {
    // A redirect or an aborted request has no body: it resolves to null. The promise is kept, never dropped, so nothing is read late.
    all.push({ url: r.url(), method: r.request().method(), body: r.text().then((t) => t, () => null) });
  });
  return {
    async settle() {
      const done = await Promise.all(all.map(async (x) => ({ url: x.url, method: x.method, body: await x.body })));
      return done.filter((x): x is { url: string; method: string; body: string } => x.body !== null);
    },
  };
}

/** Opens a report link in a page and waits for the report. The address bar must carry no fragment once the page is up. */
async function openReport(page: Page, link: string): Promise<void> {
  await page.goto(link);
  await page.waitForURL("**/report");
  await expect(page.getByRole("heading", { name: "Your report" })).toBeVisible();
}

test("issue, open in a fresh browser, revoke, reissue: the old link is refused and the new one works; the re-run is the report that shows", async ({ browser }) => {
  test.setTimeout(300_000);
  const output: string[] = [];
  stack = await startLauncherStack({ onOutput: (l) => output.push(l) });
  const { fac, sessionId } = await endedSession(browser, stack);
  opened.push(fac.context());
  await seedReports(stack, sessionId);
  await openPanel(fac, stack, sessionId);

  // Issue a link for bob and open it in a context that has never seen the console.
  const first = await issueLink(fac);
  const participant = await (await fresh(browser)).newPage();
  await openReport(participant, first);
  const own = participant.locator("pre.report-text").first();
  await expect(own).toContainText(RERUN_TEXT); // the live re-run (-2), not the superseded first run
  expect(await own.innerText()).not.toContain(OLD_RUN_TEXT); // the superseded first run's strength line is not shown
  await expect(participant.getByText(/^Available until /)).toBeVisible();
  expect(new URL(participant.url()).hash).toBe("");
  const [tokenId, tokenSecret] = first.split("#")[1]!.split(".");
  expect(participant.url()).not.toContain(tokenSecret!);

  // Back: the link page replaced itself, so it is not in the history and nothing in it holds the token.
  await participant.goBack();
  expect(participant.url()).not.toContain("/report/enter");
  expect(participant.url()).not.toContain(tokenSecret!);
  expect(await participant.evaluate(() => history.length)).toBeLessThanOrEqual(2);
  expect(await participant.evaluate(() => document.referrer)).toBe("");
  await participant.goto(`${stack.baseUrl}/report`); // the cookie is still valid: the report shows without the link
  await expect(participant.locator("pre.report-text").first()).toContainText(RERUN_TEXT);

  // The pages themselves (not only the API) are private: no-store and no-referrer in the real response headers.
  for (const path of ["/report", "/report/enter"]) {
    const res = await participant.context().request.get(`${stack.baseUrl}${path}`);
    expect(res.headers()["cache-control"], `${path} cache-control`).toContain("no-store");
    expect(res.headers()["referrer-policy"], `${path} referrer-policy`).toBe("no-referrer");
  }

  // Neither the control service nor `next start` ever printed the token (its id or its secret).
  const printed = output.join("\n");
  expect(printed).not.toContain(tokenSecret!);
  expect(printed).not.toContain(tokenId!);

  // Revoke in the console; the next read in that same browser is refused.
  await dismiss(fac);
  await revoke(fac);
  await participant.reload();
  await expect(participant.getByRole("status")).toHaveText(REFUSED);
  await expect(participant.locator("pre.report-text")).toHaveCount(0);

  // Issue again, then reissue: the link shown by the issue stops working at once, the reissued one works.
  const second = await issueLink(fac);
  await dismiss(fac);
  const third = await reissue(fac);
  expect(third).not.toBe(second);
  const old = await (await fresh(browser)).newPage();
  await old.goto(second);
  await expect(old.getByRole("status")).toHaveText(REFUSED);
  const current = await (await fresh(browser)).newPage();
  await openReport(current, third);
  await expect(current.locator("pre.report-text").first()).toContainText(RERUN_TEXT);
  expect(new URL(current.url()).hash).toBe("");
});

test("with JavaScript off the link page says so and sends nothing; five bad tokens are refused, then the address is told to wait", async ({ browser }) => {
  test.setTimeout(240_000);
  stack = await startLauncherStack();

  const noJs = await (await fresh(browser, { javaScriptEnabled: false })).newPage();
  const requests: string[] = [];
  noJs.on("request", (r) => requests.push(new URL(r.url()).pathname));
  const doc = await noJs.goto(`${stack.baseUrl}/report/enter#x`);
  // Chromium's script-disabled emulation keeps <noscript> hidden (a browser with scripting off shows it), so the check is on what the
  // server sent. The page says nothing else and the address bar keeps the fragment: nothing ran.
  expect(await doc!.text()).toContain(
    '<noscript><p class="banner warn">This link needs JavaScript to open. Turn it on for this site, or ask your facilitator for help.</p></noscript>',
  );
  await expect(noJs.getByRole("heading", { name: "Open your report" })).toBeVisible();
  await expect(noJs.getByRole("status")).toHaveText(""); // no "Opening…" next to the no-script sentence
  expect(new URL(noJs.url()).hash).toBe("#x");
  expect(requests.filter((p) => p.startsWith("/api/"))).toEqual([]);

  // A client address of its own: the throttle is per address and the other tests share the default one.
  const ctx = await fresh(browser, { address: "10.20.30.40" });
  const attempt = async (n: number) => {
    const page = await ctx.newPage();
    await page.goto(`${stack!.baseUrl}/report/enter#bad${n}.token${n}`);
    return page;
  };
  // The join's limits: more than 5 failures in 60 s block the address, so the sixth bad token is still refused (and tips the count) ...
  for (let n = 1; n <= 6; n++) {
    const page = await attempt(n);
    await expect(page.getByRole("status")).toHaveText(REFUSED);
    await page.close();
  }
  // ... and the seventh attempt is told to wait instead of getting another "no longer works".
  const blocked = await attempt(7);
  await expect(blocked.getByRole("status")).toHaveText("Too many attempts. Wait a minute and try again.");
  await expect(blocked.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("Axe: /report (report and refused) and the console panel, at 400 and 1280 px, light and dark", async ({ browser }) => {
  test.setTimeout(300_000);
  stack = await startLauncherStack();
  const { fac, sessionId } = await endedSession(browser, stack);
  opened.push(fac.context());
  await seedReports(stack, sessionId);
  await openPanel(fac, stack, sessionId);

  // The console panel: the list, then the once-shown link, at both widths.
  for (const width of [1280, 400]) {
    await fac.setViewportSize({ width, height: 860 });
    await checkBothSchemes(fac, `the report links panel (${width}px)`);
    await noHorizontalScroll(fac, width);
  }
  const link = await issueLink(fac);
  for (const width of [1280, 400]) {
    await fac.setViewportSize({ width, height: 860 });
    await checkBothSchemes(fac, `the report links panel with a link shown (${width}px)`);
    await noHorizontalScroll(fac, width);
  }

  const participant = await (await fresh(browser)).newPage();
  await openReport(participant, link);
  for (const width of [1280, 400]) {
    await participant.setViewportSize({ width, height: 860 });
    await checkBothSchemes(participant, `/report (${width}px)`);
    await noHorizontalScroll(participant, width);
  }

  await dismiss(fac);
  await revoke(fac);
  await participant.reload();
  await expect(participant.getByRole("status")).toHaveText(REFUSED);
  for (const width of [1280, 400]) {
    await participant.setViewportSize({ width, height: 860 });
    await checkBothSchemes(participant, `/report refused (${width}px)`);
    await noHorizontalScroll(participant, width);
  }
});

test("a draft player rates with the runtime exited and never sees the evaluator; release, then the table and form appear; a dispute is resolved and its reason shows", async ({ browser }) => {
  test.setTimeout(300_000);
  stack = await startLauncherStack();
  const { fac, sessionId } = await endedSession(browser, stack);
  opened.push(fac.context());
  await seedDraft(stack, sessionId);
  await openPanel(fac, stack, sessionId);

  // The console lists the draft role, with its progress and the release warning; issue a link for it (the runtime has exited).
  const row = fac.locator("li.code-row", { has: fac.getByRole("heading", { name: BOB, level: 3 }) });
  await expect(row.getByText("Rated 0 of 3 criteria")).toBeVisible();
  await expect(fac.getByText(/Releasing a report closes self-rating/)).toBeVisible();
  const link = await issueLink(fac);
  await dismiss(fac);

  const participant = await (await fresh(browser)).newPage();
  const bodies = recordBodies(participant);
  await openForm(participant, link);
  await expect(participant.getByRole("heading", { name: "Your report" })).toHaveCount(0);

  // Rate all three criteria with notes, save, and see it confirmed.
  await rate(participant, "Discovery", "Advanced");
  await criterion(participant, "Discovery").getByLabel("Note (optional)").fill("My own view of discovery.");
  await rate(participant, "Listening", "Proficient");
  await rate(participant, "Negotiation", "Developing");
  expect(await hasDraft(participant)).toBe(true); // touched fields are kept in the browser until saved
  await participant.getByRole("button", { name: "Save my ratings" }).click();
  await expect(participant.getByRole("status").filter({ hasText: "Your ratings are saved" })).toBeVisible();
  expect(await hasDraft(participant)).toBe(false);

  // Reload: the saved ratings come back from the server; and nothing the evaluator wrote ever reached the page or the wire.
  await participant.reload();
  await expect(participant.getByRole("button", { name: "Save my ratings" })).toBeVisible();
  await expect(criterion(participant, "Discovery").getByRole("radio", { name: /^Advanced/ })).toBeChecked();
  await expect(criterion(participant, "Discovery").getByLabel("Note (optional)")).toHaveValue("My own view of discovery.");

  // Not observed: choose it for one criterion, save, reload; it is still checked. This sends control's real self_assess body (level null)
  // through the BFF parser and back, which a saved "Not observed" once broke.
  await criterion(participant, "Negotiation").getByRole("radio", { name: "Not observed" }).check();
  await participant.getByRole("button", { name: "Save my ratings" }).click();
  await expect(participant.getByRole("status").filter({ hasText: "Your ratings are saved" })).toBeVisible();
  await participant.reload();
  await expect(participant.getByRole("button", { name: "Save my ratings" })).toBeVisible();
  await expect(criterion(participant, "Negotiation").getByRole("radio", { name: "Not observed" })).toBeChecked();
  // Put the rating back so the release assertions below are unchanged.
  await rate(participant, "Negotiation", "Developing");
  await participant.getByRole("button", { name: "Save my ratings" }).click();
  await expect(participant.getByRole("status").filter({ hasText: "Your ratings are saved" })).toBeVisible();
  await participant.reload();
  await expect(criterion(participant, "Negotiation").getByRole("radio", { name: /^Developing/ })).toBeChecked();
  const pageText = await participant.locator("body").innerText();
  const html = await participant.content();
  // Every body is read to the end before anything is asserted. The rationale canary is the real post-release detector (the released view
  // is where evaluator prose lives); the level canary only catches a raw draft passthrough, since a level alone is a number the page may show.
  const recorded = await bodies.settle();
  for (const canary of [CANARY_LEVEL, CANARY_RATIONALE]) {
    expect(pageText, `page text holds ${canary}`).not.toContain(canary);
    expect(html, `page html holds ${canary}`).not.toContain(canary);
    expect(recorded.filter((r) => r.body.includes(canary)).map((r) => r.url), `a response body holds ${canary}`).toEqual([]);
  }
  // Positive control: the recorder saw the GET /api/v1/report JSON itself (not bundle text that merely mentions the words).
  const reads = recorded.filter((r) => r.method === "GET" && new URL(r.url).pathname === "/api/v1/report");
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.some((r) => { try { return (JSON.parse(r.body) as { data?: { state?: string } }).data?.state === "self_assess"; } catch { return false; } })).toBe(true);
  expect(reads.some((r) => r.body.includes('"self_assess"'))).toBe(true);

  // The console shows who has rated (a fresh load of the panel).
  await openPanel(fac, stack, sessionId);
  await expect(row.getByText("Rated 3 of 3 criteria")).toBeVisible();

  // Release (the runtime's own function, in a child process) and reload: the report, the table and the response form appear.
  await releaseRole(stack, sessionId);
  await participant.reload();
  await expect(participant.getByRole("heading", { name: "Your report" })).toBeVisible();
  await expect(participant.locator("pre.report-text").first()).toContainText(CANARY_RATIONALE); // the canary is what a leak would show
  const table = participant.getByRole("table");
  await expect(table.getByRole("columnheader", { name: "Evaluator's level" })).toBeVisible();
  const discovery = table.getByRole("row", { name: /Discovery/ });
  await expect(discovery.getByRole("cell")).toHaveText(["Developing", "Advanced", "My own view of discovery."]); // evaluator level beside the participant's own rating
  await expect(table.getByRole("row", { name: /Listening/ }).getByRole("cell").nth(0)).toHaveText("Proficient");
  await expect(table.getByRole("row", { name: /Listening/ }).getByRole("cell").nth(1)).toHaveText("Proficient");
  await expect(table.getByRole("row", { name: /Negotiation/ }).getByRole("cell").nth(1)).toHaveText("Developing");
  await expect(participant.getByRole("button", { name: "Save my ratings" })).toHaveCount(0);
  await expect(participant.getByRole("heading", { name: "Send a response" })).toBeVisible();
  await expect(participant.getByText("0 of 50 used")).toBeVisible();

  // A plain response, then a dispute about one criterion.
  const respond = participant.getByRole("form", { name: "Send a response" });
  await respond.getByLabel("Your response").fill("Thank you, this is a fair summary.");
  await respond.getByRole("button", { name: "Send", exact: true }).click();
  await expect(participant.getByText("1 of 50 used")).toBeVisible();
  await respond.getByLabel("About").selectOption({ label: "Listening" });
  await respond.getByLabel("Your response").fill("I asked three open questions, so I disagree with this level.");
  await respond.getByRole("checkbox", { name: "I disagree with this" }).check();
  await respond.getByRole("button", { name: "Send", exact: true }).click();
  await expect(participant.getByText("2 of 50 used")).toBeVisible();
  const list = participant.getByRole("region", { name: "Your responses" });
  await expect(list.getByText("I asked three open questions, so I disagree with this level.")).toBeVisible();
  await expect(list.getByText("Disagreement")).toHaveCount(1);
  await expect(list.getByText(/^Outcome:/)).toHaveCount(0);

  // The facilitator resolves the dispute (runtime function in a child process); after a reload the outcome and the reason show.
  await resolveDispute(stack, sessionId, "upheld", RESOLVE_REASON);
  await participant.reload();
  const after = participant.getByRole("region", { name: "Your responses" });
  await expect(after.getByText("Outcome: upheld")).toBeVisible();
  await expect(after.getByText(`Facilitator's reason: ${RESOLVE_REASON}`)).toBeVisible();
  await expect(after.getByText("2 of 50 used")).toBeVisible();

  // A long unbroken response and a note keep the page inside a 400 px screen.
  const respondAgain = participant.getByRole("form", { name: "Send a response" });
  await respondAgain.getByLabel("Your response").fill("W".repeat(1500));
  await respondAgain.getByRole("button", { name: "Send", exact: true }).click();
  await expect(participant.getByText("3 of 50 used")).toBeVisible();
  await participant.setViewportSize({ width: 400, height: 860 });
  await noHorizontalScroll(participant, 400);
});

test("revoke while the participant's cookie exists: the next write is refused and the page shows the refused state", async ({ browser }) => {
  test.setTimeout(300_000);
  stack = await startLauncherStack();
  const { fac, sessionId } = await endedSession(browser, stack);
  opened.push(fac.context());
  await seedDraft(stack, sessionId);
  await openPanel(fac, stack, sessionId);
  const link = await issueLink(fac);
  await dismiss(fac);

  const participant = await (await fresh(browser)).newPage();
  await openForm(participant, link);
  expect(await reportCookies(participant)).toHaveLength(1);
  await rate(participant, "Discovery", "Developing");
  expect(await hasDraft(participant)).toBe(true);

  await revoke(fac);

  const write = participant.waitForResponse((r) => r.url().endsWith("/api/v1/report/self-ratings") && r.request().method() === "PUT");
  await participant.getByRole("button", { name: "Save my ratings" }).click();
  expect((await write).status()).toBe(404);
  await expect(participant.getByRole("status")).toHaveText(REFUSED);
  await expect(participant.getByRole("button", { name: "Save my ratings" })).toHaveCount(0);
  expect(await reportCookies(participant)).toHaveLength(0); // the 404 cleared the cookie
  expect(await hasDraft(participant)).toBe(false);
});

test("reissue mid-rating: the old tab is refused (cookie and draft cleared); the new link shows the earlier ratings and no old draft", async ({ browser }) => {
  test.setTimeout(300_000);
  stack = await startLauncherStack();
  const { fac, sessionId } = await endedSession(browser, stack);
  opened.push(fac.context());
  await seedDraft(stack, sessionId);
  await openPanel(fac, stack, sessionId);
  const first = await issueLink(fac);
  await dismiss(fac);

  const tab = await (await fresh(browser)).newPage();
  await openForm(tab, first);
  await rate(tab, "Discovery", "Developing");
  await criterion(tab, "Discovery").getByLabel("Note (optional)").fill("Saved before the reissue.");
  await tab.getByRole("button", { name: "Save my ratings" }).click();
  await expect(tab.getByRole("status").filter({ hasText: "Your ratings are saved" })).toBeVisible();
  // More typing that is never saved: this stays only in the browser's draft.
  await rate(tab, "Listening", "Advanced");
  expect(await hasDraft(tab)).toBe(true);

  const second = await reissue(fac);
  expect(second).not.toBe(first);

  const write = tab.waitForResponse((r) => r.url().endsWith("/api/v1/report/self-ratings") && r.request().method() === "PUT");
  await tab.getByRole("button", { name: "Save my ratings" }).click();
  expect((await write).status()).toBe(404);
  await expect(tab.getByRole("status")).toHaveText(REFUSED);
  expect(await reportCookies(tab)).toHaveLength(0);
  expect(await hasDraft(tab)).toBe(false);

  // The new link, opened in the very same browser (same sessionStorage): the earlier saved rating is there (found by role), the unsaved one is not.
  await openForm(tab, second);
  await expect(criterion(tab, "Discovery").getByRole("radio", { name: /^Developing/ })).toBeChecked();
  await expect(criterion(tab, "Discovery").getByLabel("Note (optional)")).toHaveValue("Saved before the reissue.");
  for (const radio of await criterion(tab, "Listening").getByRole("radio").all()) await expect(radio).not.toBeChecked();
  expect(await hasDraft(tab)).toBe(false);
});

test("a stale form after release: Save says the ratings are closed and keeps what was typed", async ({ browser }) => {
  test.setTimeout(300_000);
  stack = await startLauncherStack();
  const { fac, sessionId } = await endedSession(browser, stack);
  opened.push(fac.context());
  await seedDraft(stack, sessionId);
  await openPanel(fac, stack, sessionId);
  const link = await issueLink(fac);
  await dismiss(fac);

  const participant = await (await fresh(browser)).newPage();
  await openForm(participant, link);
  await rate(participant, "Discovery", "Advanced");
  await criterion(participant, "Discovery").getByLabel("Note (optional)").fill("Typed before the release.");

  await releaseRole(stack, sessionId);

  const write = participant.waitForResponse((r) => r.url().endsWith("/api/v1/report/self-ratings") && r.request().method() === "PUT");
  await participant.getByRole("button", { name: "Save my ratings" }).click();
  expect((await write).status()).toBe(409);
  await expect(participant.locator("[role=alert].banner")).toContainText(CLOSED);
  // What was typed is still in the form, and nothing was refused or lost.
  await expect(criterion(participant, "Discovery").getByRole("radio", { name: /^Advanced/ })).toBeChecked();
  await expect(criterion(participant, "Discovery").getByLabel("Note (optional)")).toHaveValue("Typed before the release.");
  expect(await reportCookies(participant)).toHaveLength(1);

  // A reload now shows the released report, and the closed rating was never written.
  await participant.reload();
  await expect(participant.getByRole("heading", { name: "Your report" })).toBeVisible();
  await expect(participant.getByRole("table").getByRole("row", { name: /Discovery/ }).getByRole("cell").nth(1)).toHaveText("Not rated");
});

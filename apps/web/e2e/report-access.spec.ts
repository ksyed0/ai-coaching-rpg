import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { checkBothSchemes, noHorizontalScroll } from "./helpers/console";
import { playerContext } from "./helpers/players";
import {
  dismiss,
  endedSession,
  issueLink,
  openPanel,
  OLD_RUN_TEXT,
  REFUSED,
  reissue,
  revoke,
  RERUN_TEXT,
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

/** Opens a report link in a page and waits for the report. The address bar must carry no fragment once the page is up. */
async function openReport(page: Page, link: string): Promise<void> {
  await page.goto(link);
  await page.waitForURL("**/report");
  await expect(page.getByRole("heading", { name: "Your report" })).toBeVisible();
}

test("issue, open in a fresh browser, revoke, reissue: the old link is refused and the new one works; the re-run is the report that shows", async ({ browser }) => {
  test.setTimeout(300_000);
  stack = await startLauncherStack();
  const { fac, sessionId } = await endedSession(browser, stack);
  opened.push(fac.context());
  await seedReports(stack, sessionId);
  await openPanel(fac, stack, sessionId);

  // Issue a link for bob and open it in a context that has never seen the console.
  const first = await issueLink(fac);
  const participant = await (await fresh(browser)).newPage();
  const enterRequests: string[] = [];
  participant.on("request", (r) => {
    if (r.url().includes("/report/enter")) enterRequests.push(r.url());
  });
  await openReport(participant, first);
  const own = participant.locator("pre.report-text").first();
  await expect(own).toContainText(RERUN_TEXT); // the live re-run (-2), not the superseded first run
  expect(await own.innerText()).not.toContain(OLD_RUN_TEXT); // the superseded first run's strength line is not shown
  await expect(participant.getByText(/^Available until /)).toBeVisible();
  expect(new URL(participant.url()).hash).toBe("");
  expect(participant.url()).not.toContain(first.split("#")[1]!);
  // The token went to the enter route in a POST body only; the document request for /report/enter carried no token (a fragment is never sent).
  expect(enterRequests.every((u) => !u.includes("#") && !u.includes(first.split("#")[1]!))).toBe(true);

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
  // server sent. The page stays on "Opening your report…" and the address bar keeps the fragment: nothing ran.
  expect(await doc!.text()).toContain(
    '<noscript><p class="banner warn">This link needs JavaScript to open. Turn it on for this site, or ask your facilitator for help.</p></noscript>',
  );
  await expect(noJs.getByRole("heading", { name: "Open your report" })).toBeVisible();
  await expect(noJs.getByRole("status")).toHaveText("Opening your report…");
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

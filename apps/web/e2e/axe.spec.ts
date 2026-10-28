import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { joinUrl, playerContext, PLAYERS, say, seat, type Player } from "./helpers/players";
import { startStack, type Stack } from "./helpers/start-stack";

// Accessibility on the three participant screens, in the light and the dark scheme (prefers-color-scheme emulated), and the phone
// width. Styling is class-only (the CSP allows only nonce'd styles), so what Axe sees is what a participant sees.

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

let stack: Stack | null = null;
test.afterEach(async () => { await stack?.stop(); stack = null; });

/** Serious and critical violations only, reduced to what a failure message needs. */
async function seriousViolations(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target.join(" ")) }));
}
async function checkBothSchemes(page: Page, screen: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), `${screen}: the ${scheme} scheme is in effect`).toBe(scheme === "dark");
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

test("no serious or critical Axe violations on /join, the lobby and the session view, in light and dark", async ({ browser }) => {
  test.setTimeout(150_000);
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
  await expect(pages.delivery_lead.getByRole("heading", { name: "Play the scene" })).toBeVisible();
  // A long unbroken word must wrap, not widen the page.
  await say(pages.tech_lead, `A${"a".repeat(180)}h, said without a single space to break it.`);
  await say(pages.delivery_lead, "A short reply.");
  for (const role of PLAYERS) expect(await noHorizontalScroll(pages[role]), `the session view (${role})`).toEqual({ scroll: 400, client: 400 });
});

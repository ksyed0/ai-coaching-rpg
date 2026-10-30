import AxeBuilder from "@axe-core/playwright";
import { expect, type Browser, type Page } from "@playwright/test";
import { playerContext, PLAYERS, type Player } from "./players";

// Browser-side helpers for the facilitator console specs: sign in, create a session and read the codes the page shows once.

export const FAC_NAME = "Ann Facilitator";
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
/** The join page's refusal (the same sentence for a wrong code, an old code and an unknown session). */
export const JOIN_REFUSED =
  "That did not work. Check the link and the code, or ask your facilitator for a new code.";

export const ROLE_LABEL: Record<Player, string> = {
  delivery_lead: "Delivery lead",
  tech_lead: "Tech lead",
  account_manager: "Account manager",
};

export async function signIn(
  page: Page,
  baseUrl: string,
  secret: string,
  name = FAC_NAME,
): Promise<void> {
  await page.goto(`${baseUrl}/console`);
  await page.getByLabel("Facilitator secret").fill(secret);
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${name}`)).toBeVisible();
}

/** A facilitator page (signed in) in a fresh context. */
export async function facilitator(
  browser: Browser,
  baseUrl: string,
  secret: string,
  width = 1280,
): Promise<Page> {
  const page = await (await playerContext(browser, { width })).newPage();
  await signIn(page, baseUrl, secret);
  return page;
}

/** The codes the CodesPanel on the page shows, by role id. */
export async function shownCodes(page: Page): Promise<Record<Player, string>> {
  const out = {} as Record<Player, string>;
  for (const role of PLAYERS) {
    const row = page
      .locator(".code-row")
      .filter({
        has: page.locator(".code-role", {
          hasText: new RegExp(`^${ROLE_LABEL[role]}$`),
        }),
      });
    out[role] = (await row.locator("code").innerText()).trim();
    expect(out[role]).not.toBe("");
  }
  return out;
}

/** /console/new -> pick the scenario -> Create; returns the session id (from the Open link) and the codes shown once. */
export async function createSession(
  page: Page,
  baseUrl: string,
  o: { alreadyOnForm?: boolean } = {},
): Promise<{ sessionId: string; codes: Record<Player, string> }> {
  if (!o.alreadyOnForm) await page.goto(`${baseUrl}/console/new`);
  await page.getByLabel("Scenario").selectOption("friday-escalation");
  await page.getByRole("button", { name: "Create session" }).click();
  const open = page.getByRole("link", { name: "Open session" });
  await expect(open).toBeVisible({ timeout: 90_000 });
  const href = await open.getAttribute("href");
  const sessionId = href!.replace(/^\/console\//, "");
  expect(sessionId).toMatch(/^[A-Za-z0-9_-]+$/);
  return { sessionId, codes: await shownCodes(page) };
}

const seatRow = (page: Page, role: Player) =>
  page
    .locator("tbody tr")
    .filter({
      has: page.getByRole("rowheader", { name: ROLE_LABEL[role], exact: true }),
    });

/** Waits until the readiness roster shows `role` as Joined and Consented (the page polls by itself). */
export async function expectSeatReady(
  page: Page,
  role: Player,
  timeout = 60_000,
): Promise<void> {
  const cells = seatRow(page, role).locator("td");
  await expect(cells.nth(1)).toHaveText(/Yes/, { timeout }); // Joined
  await expect(cells.nth(2)).toHaveText(/Yes/, { timeout }); // Consented
}

export const startButton = (page: Page) =>
  page.getByRole("button", { name: "Start", exact: true });

// ---- Axe ----

/** Serious and critical violations only, reduced to what a failure message needs. */
async function seriousViolations(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  return r.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => n.target.join(" ")),
    }));
}

export async function checkBothSchemes(
  page: Page,
  screen: string,
): Promise<void> {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    expect(
      await page.evaluate(
        () => matchMedia("(prefers-color-scheme: dark)").matches,
      ),
      `${screen}: the ${scheme} scheme is in effect`,
    ).toBe(scheme === "dark");
    // Buttons transition their background while the text colour flips at once: measure only after every animation has finished.
    await page.waitForFunction(() =>
      document
        .getAnimations()
        .every((a) => a.playState !== "running" && !a.pending),
    );
    expect(await seriousViolations(page), `${screen} (${scheme})`).toEqual([]);
  }
}

export const noHorizontalScroll = (page: Page, width: number) =>
  page
    .evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }))
    .then((m) => expect(m).toEqual({ scroll: width, client: width }));

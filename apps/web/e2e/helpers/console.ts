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
  await page.getByText("Use the shared secret instead").click();
  await page.getByLabel("Facilitator secret").fill(secret);
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Sign in with the secret" }).click();
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
    // The code only: the row also holds the join link in its own <code class="code-url">.
    out[role] = (await row.locator("code.code-value").innerText()).trim();
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

/** Waits until the AI player's row shows it as the seat's holder, joined (its bot is in) and connected; consent is "Not needed". */
export async function expectAiSeatReady(
  page: Page,
  role: Player,
  timeout = 60_000,
): Promise<void> {
  const row = seatRow(page, role);
  const cells = row.locator("td");
  await expect(cells.nth(0)).toContainText("AI player", { timeout });
  await expect(cells.nth(1)).toHaveText(/Yes/, { timeout }); // Joined
  await expect(cells.nth(2)).toHaveText(/Not needed/);
  await expect(cells.nth(3)).toHaveText(/Yes/, { timeout }); // Connected
}

/**
 * Presses "Make <role> an AI player" and, unless `confirm` is false, the dialog's "Use AI player" (the dialog is gone afterwards and
 * the switch has been answered); otherwise it leaves the dialog open. The failure names the notice the page shows, if any.
 */
export async function makeAiPlayer(
  page: Page,
  role: Player,
  o: { confirm?: boolean } = {},
): Promise<void> {
  await page
    .getByRole("button", { name: `Make ${ROLE_LABEL[role]} an AI player` })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  if (o.confirm === false) return;
  await dialog.getByRole("button", { name: "Use AI player" }).click();
  try {
    await expect(dialog).toHaveCount(0);
  } catch (err) {
    const shown = await page.locator("[role=alert]").allInnerTexts();
    throw new Error(
      `the switch to an AI player was not answered; the page shows: ${JSON.stringify(shown)}`,
      { cause: err },
    );
  }
}

/** Presses "Make <role> human" and confirms "Switch to human". */
export async function makeHuman(page: Page, role: Player): Promise<void> {
  await page
    .getByRole("button", { name: `Make ${ROLE_LABEL[role]} human` })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Switch to human" }).click();
  try {
    await expect(dialog).toHaveCount(0);
  } catch (err) {
    const shown = await page.locator("[role=alert]").allInnerTexts();
    throw new Error(
      `the switch to a human was not answered; the page shows: ${JSON.stringify(shown)}`,
      { cause: err },
    );
  }
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

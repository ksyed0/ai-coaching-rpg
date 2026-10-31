import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { playerContext } from "./helpers/players";
import {
  startLauncherStack,
  type LauncherStack,
} from "./helpers/start-launcher-stack";
import { startStack, type Stack } from "./helpers/start-stack";

// The facilitator console's sign-in and shell: a wrong secret, a right one, noindex on the page, robots.txt, and Axe on both states at
// 400 px and laptop width in light and dark. It runs on the launcher stack (the real control service, empty), because the signed-in
// shell lists the sessions through the BFF. The "not set up" test needs no control service and keeps the plain stack.

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const NAME = "Ann Facilitator";
const WIDTHS = [400, 1280] as const;

let stack: LauncherStack | null = null;
let plain: Stack | null = null;
test.afterEach(async () => {
  await stack?.stop();
  stack = null;
  await plain?.stop();
  plain = null;
});

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
async function checkBothSchemes(page: Page, screen: string) {
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
const noHorizontalScroll = (page: Page, width: number) =>
  page
    .evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }))
    .then((m) => expect(m).toEqual({ scroll: width, client: width }));

async function signIn(
  page: Page,
  s: LauncherStack,
  secret = s.facilitatorSecret,
  name = NAME,
) {
  await page.goto(`${s.baseUrl}/console`);
  await page.getByLabel("Facilitator secret").fill(secret);
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Sign in" }).click();
}
const newPage = async (browser: Browser, width = 1280) =>
  (await playerContext(browser, { width })).newPage();

test("wrong secret shows the neutral message", async ({ browser }) => {
  test.setTimeout(150_000);
  stack = await startLauncherStack();
  const page = await newPage(browser);
  await signIn(page, stack, "this-is-not-the-secret-at-all");
  await expect(
    page.getByText(
      "That did not work. Check the secret and the name and try again.",
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Facilitator secret")).toHaveValue("");
  await expect(page.getByText(/Signed in as/)).toHaveCount(0);
  expect(
    (await page.context().cookies()).filter((c) =>
      c.name.startsWith("__Host-scenecoach-fac"),
    ),
  ).toEqual([]);
});

test("right secret reaches the shell and /console sends noindex", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  stack = await startLauncherStack();
  const page = await newPage(browser);
  const response = await page.goto(`${stack.baseUrl}/console`);
  expect(response!.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  await page.getByLabel("Facilitator secret").fill(stack.facilitatorSecret);
  await page.getByLabel("Your name").fill(NAME);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${NAME}`)).toBeVisible();
  await expect(page.getByText("No sessions yet")).toBeVisible();
  const again = await page.reload();
  expect(again!.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  await expect(page.getByText(`Signed in as ${NAME}`)).toBeVisible();
  // The cookie is HttpOnly: the page's script cannot read it.
  expect(await page.evaluate(() => document.cookie)).toBe("");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Facilitator secret")).toBeVisible();
  await expect(page.getByText(/Signed in as/)).toHaveCount(0);
});

test("robots.txt disallows /console", async () => {
  test.setTimeout(150_000);
  stack = await startLauncherStack();
  const text = await (await fetch(`${stack.baseUrl}/robots.txt`)).text();
  expect(text.split("\n")).toContain("Disallow: /console");
});

test("without the console settings the page says it is not set up and has no form", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  plain = await startStack();
  const page = await newPage(browser);
  await page.goto(`${plain.baseUrl}/console`);
  await expect(
    page.getByText("The console is not set up on this server."),
  ).toBeVisible();
  await expect(page.locator("form, input")).toHaveCount(0);
});

for (const width of WIDTHS) {
  test(`no serious or critical Axe violations on the console, signed out and signed in, at ${width} px, in light and dark`, async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    stack = await startLauncherStack();
    const page = await newPage(browser, width);
    await page.goto(`${stack.baseUrl}/console`);
    await expect(page.getByLabel("Facilitator secret")).toBeVisible();
    await checkBothSchemes(page, `the console sign-in at ${width} px`);
    await noHorizontalScroll(page, width);
    // The refused state (the error text and the field states).
    await page
      .getByLabel("Facilitator secret")
      .fill("this-is-not-the-secret-at-all");
    await page.getByLabel("Your name").fill(NAME);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(/That did not work/)).toBeVisible();
    await checkBothSchemes(
      page,
      `the console sign-in, refused, at ${width} px`,
    );

    await page.getByLabel("Facilitator secret").fill(stack.facilitatorSecret);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(`Signed in as ${NAME}`)).toBeVisible();
    await checkBothSchemes(page, `the console shell at ${width} px`);
    await noHorizontalScroll(page, width);
  });
}

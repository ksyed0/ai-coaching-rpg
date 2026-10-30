import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { CLIENT_ADDRESS, SESSION_ID, type Stack } from "./start-stack";

// Browser-side helpers shared by the specs: a player's context and the join and consent steps, driven through the real pages.

export const PLAYERS = ["delivery_lead", "tech_lead", "account_manager"] as const;
export type Player = (typeof PLAYERS)[number];

/**
 * A browser context for one person. The browser talks to `next start` directly, so there is no Caddy to set X-Forwarded-For: each
 * context sends the one local address Caddy would append (a single entry, as in production), so the BFF and the runtime key their
 * throttles and caps on that address. (Without it `next start` would fill in the socket address, also local here.)
 */
export function playerContext(browser: Browser, o: { width?: number; colorScheme?: "light" | "dark" } = {}): Promise<BrowserContext> {
  return browser.newContext({
    extraHTTPHeaders: { "X-Forwarded-For": CLIENT_ADDRESS },
    viewport: { width: o.width ?? 1200, height: 860 },
    colorScheme: o.colorScheme ?? "light",
  });
}

export const joinUrl = (stack: Stack, role: string) => `${stack.baseUrl}/join?session=${SESSION_ID}&role=${role}`;

/** Fills the join form and lands on the session page with the stream open (the consent panel or the lobby is shown). */
export async function joinAs(page: Page, stack: Stack, role: Player, name: string, code = stack.codes[role]!): Promise<void> {
  await page.goto(joinUrl(stack, role));
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Your join code").fill(code);
  await page.getByRole("button", { name: "Join" }).click();
  await page.waitForURL(`**/session/${SESSION_ID}`);
  await expect(page.getByRole("heading", { name: /Consent, notice/ })).toBeVisible();
}

/** Ticks the box and agrees; the page then says so. */
export async function consent(page: Page): Promise<void> {
  await page.getByLabel("I have read this notice and agree to take part.").check();
  await page.getByRole("button", { name: "I agree" }).click();
  await expect(page.getByText(/^You agreed to notice/)).toBeVisible();
}

/** A new context and page for `role`, joined and (unless told otherwise) consented. */
export async function seat(browser: Browser, stack: Stack, role: Player, name: string, o: { consent?: boolean; width?: number; colorScheme?: "light" | "dark" } = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await playerContext(browser, o);
  const page = await context.newPage();
  await joinAs(page, stack, role, name);
  if (o.consent !== false) await consent(page);
  return { context, page };
}

/**
 * Says a line through the say box and waits until it is in this page's transcript. It first waits for a settled box (enabled, not
 * busy, holding exactly the typed text), then requires the BFF to accept the POST: a refused line fails here with the BFF's answer,
 * instead of as a transcript line that never comes.
 */
export async function say(page: Page, text: string): Promise<void> {
  const box = page.getByLabel("Say something");
  const button = page.getByRole("button", { name: "Say", exact: true });
  await expect(box).toBeEnabled();
  await expect(box).not.toHaveAttribute("aria-busy", "true");
  await box.fill(text);
  await expect(box).toHaveValue(text);
  await expect(button).toBeEnabled();
  const [answer] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/say" && r.request().method() === "POST"),
    button.click(),
  ]);
  expect(answer.status(), `POST /api/v1/say answered ${answer.status()}: ${await answer.text()}`).toBe(200);
  try {
    await expect(transcript(page).getByText(text, { exact: true })).toHaveCount(1);
  } catch (err) {
    // The runtime may refuse a line after the BFF's short send window (the refusal then reaches the page as a notice): say what the
    // page shows, so a CI failure names its cause.
    const shown = await page.locator("[role=status], [role=alert]").allInnerTexts();
    throw new Error(`the line never reached the transcript; the page shows: ${JSON.stringify(shown)}`, { cause: err });
  }
}

export const transcript = (page: Page) => page.getByRole("list", { name: "Transcript" });

/**
 * Every stream request the page makes from now on: the Last-Event-ID it carried (null on a first open) and the status of its
 * response (null while none came, or for good when the request failed, such as a retry that met a closed port).
 */
export type StreamOpen = { lastEventId: string | null; status: number | null };
export function trackStreams(page: Page): StreamOpen[] {
  const seen: StreamOpen[] = [];
  const byRequest = new WeakMap<object, StreamOpen>();
  page.on("request", (r) => {
    if (new URL(r.url()).pathname !== "/api/v1/stream") return;
    const entry: StreamOpen = { lastEventId: null, status: null };
    seen.push(entry);
    byRequest.set(r, entry);
    // allHeaders: the headers the network stack really sent (Last-Event-ID is added below the page).
    void r.allHeaders().then((h) => { entry.lastEventId = h["last-event-id"] ?? null; }, () => undefined);
  });
  page.on("response", (res) => { const entry = byRequest.get(res.request()); if (entry) entry.status = res.status(); });
  return seen;
}

// ---- launcher mode (the session id and the origin come from the control service and the stack, not from SESSION_ID) ----

/** Fills the join form for a launcher-mode session and lands on its session page with the stream open. */
export async function joinAsLauncher(page: Page, baseUrl: string, sessionId: string, role: string, code: string, name: string): Promise<void> {
  await page.goto(`${baseUrl}/join?session=${sessionId}&role=${role}`);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Your join code").fill(code);
  await page.getByRole("button", { name: "Join" }).click();
  await page.waitForURL(`**/session/${sessionId}`);
  await expect(page.getByRole("heading", { name: /Consent, notice|Play the scene/ })).toBeVisible();
}

/** A new context and page for `role` in a launcher-mode session, joined and (unless told otherwise) consented. */
export async function seatLauncher(browser: Browser, baseUrl: string, sessionId: string, role: Player, code: string, name: string, o: { consent?: boolean; width?: number; colorScheme?: "light" | "dark" } = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await playerContext(browser, o);
  const page = await context.newPage();
  await joinAsLauncher(page, baseUrl, sessionId, role, code, name);
  if (o.consent !== false) await consent(page);
  return { context, page };
}

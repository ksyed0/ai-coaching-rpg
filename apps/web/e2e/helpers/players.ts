import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { CLIENT_ADDRESS, SESSION_ID, type Stack } from "./start-stack";

// Browser-side helpers shared by the specs: a player's context and the join and consent steps, driven through the real pages.

export const PLAYERS = ["delivery_lead", "tech_lead", "account_manager"] as const;
export type Player = (typeof PLAYERS)[number];

/**
 * A browser context for one person. The browser talks to `next start` directly, so there is no Caddy to set X-Forwarded-For: each
 * context sends the one local address Caddy would append (a single entry, as in production), so the BFF and the runtime key their
 * throttles and caps on a real address rather than the shared "unknown" key of a proxy-less deployment.
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

/** Says a line through the say box and waits until it is in this page's transcript. */
export async function say(page: Page, text: string): Promise<void> {
  const box = page.getByLabel("Say something");
  await expect(box).toBeEnabled();
  await box.fill(text);
  await page.getByRole("button", { name: "Say", exact: true }).click();
  await expect(transcript(page).getByText(text, { exact: true })).toHaveCount(1);
}

export const transcript = (page: Page) => page.getByRole("list", { name: "Transcript" });

/** Every stream request the page makes from now on, with the Last-Event-ID it carried (null on a first open). */
export function trackStreams(page: Page): { lastEventId: string | null }[] {
  const seen: { lastEventId: string | null }[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname !== "/api/v1/stream") return;
    const entry: { lastEventId: string | null } = { lastEventId: null };
    seen.push(entry);
    // allHeaders: the headers the network stack really sent (Last-Event-ID is added below the page).
    void r.allHeaders().then((h) => { entry.lastEventId = h["last-event-id"] ?? null; }, () => undefined);
  });
  return seen;
}

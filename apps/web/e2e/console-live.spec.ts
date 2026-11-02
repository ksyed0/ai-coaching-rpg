import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  checkBothSchemes,
  createSession,
  expectSeatReady,
  facilitator,
  noHorizontalScroll,
  ROLE_LABEL,
  startButton,
} from "./helpers/console";
import { PLAYERS, say, seatLauncher, type Player } from "./helpers/players";
import {
  startLauncherStack,
  type LauncherStack,
} from "./helpers/start-launcher-stack";

// The facilitator's live view against the real control service (mock models, temp data dir) and `next start` in launcher mode:
// after Start the console follows the session read-only. Every wait is on an effect (auto-retrying expect); no fixed sleep and no
// assertion on elapsed time.

let stack: LauncherStack | null = null;
const opened: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of opened.splice(0)) await c.close().catch(() => undefined);
  await stack?.stop();
  stack = null;
});

const NAMES: Record<Player, string> = {
  delivery_lead: "Dana Lead",
  tech_lead: "Tomás Tech",
  account_manager: "Ama Accounts",
};
// The fixed line the console shows for an info alert, whatever text the runtime carried (apps/web/src/server/facilitator-copies.ts).
const ALERT_INFO = "The runtime posted a notice. Details are in the facilitator log.";
const HOSTILE = "<img src=x onerror=alert(1)> reversed ‮evil";

type Live = {
  stack: LauncherStack;
  fac: Page;
  sessionId: string;
  players: Record<Player, { context: BrowserContext; page: Page }>;
  codes: Record<Player, string>;
};

/** A started session: three players joined and consented, the facilitator's console on the live view. */
async function startedSession(browser: Browser, onFac?: (fac: Page) => Promise<void>): Promise<Live> {
  stack = await startLauncherStack();
  const fac = await facilitator(browser, stack.baseUrl, stack.facilitatorSecret);
  if (onFac) await onFac(fac);
  const { sessionId, codes } = await createSession(fac, stack.baseUrl);
  const players = {} as Live["players"];
  for (const role of PLAYERS)
    players[role] = await seatLauncher(browser, stack.baseUrl, sessionId, role, codes[role], NAMES[role]);
  await fac.goto(`${stack.baseUrl}/console/${sessionId}`);
  for (const role of PLAYERS) await expectSeatReady(fac, role);
  await startButton(fac).click();
  await expect(fac.getByText("The session has started.", { exact: true })).toBeVisible();
  await expect(fac.getByRole("heading", { name: "Live session" })).toBeVisible();
  opened.push(fac.context(), ...PLAYERS.map((r) => players[r].context));
  return { stack, fac, sessionId, players, codes };
}

const timeline = (p: Page) => p.getByRole("list", { name: "Transcript and notices" });
const wordsSpoken = (p: Page) => p.getByRole("region", { name: "Words spoken" });
const alerts = (p: Page) => timeline(p).locator("li.alert");

test("after Start the console shows the first scene and its timer, a player's line, Words spoken for that player, and the reissue alert after a reissue after the start", async ({ browser }) => {
  test.setTimeout(300_000);
  const { fac, players } = await startedSession(browser);

  await expect(fac.getByText(/^Scene 1 of [23]: Team huddle$/)).toBeVisible();
  await expect(fac.getByRole("timer")).toContainText(/\d+:\d{2}/);

  const line = "I will take the customer call after lunch";
  await say(players.delivery_lead.page, line);
  await expect(timeline(fac).locator("li.msg").filter({ hasText: line })).toHaveCount(1);
  const row = wordsSpoken(fac).getByRole("table", { name: "Players" }).locator("tbody tr").filter({ hasText: NAMES.delivery_lead });
  await expect(row).toHaveCount(1);
  await expect(row.locator("td").nth(0)).toHaveText("8");
  await expect(row.locator("td").nth(1)).toHaveText("1");

  // Reissue the tech lead's code after the start: the runtime appends a facilitator-only alert; the console shows its fixed line only.
  const before = await alerts(fac).count();
  await fac.getByRole("button", { name: `Reissue code for ${ROLE_LABEL.tech_lead}` }).click();
  const dialog = fac.getByRole("dialog");
  await dialog.getByRole("button", { name: "Reissue code", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(alerts(fac)).toHaveCount(before + 1);
  const added = alerts(fac).last();
  // The reissue always raises the info-level alert (SessionHost.noteFacilitator).
  await expect(added.locator(".pill")).toHaveText("Alert:");
  await expect(added.locator(".line")).toHaveText(ALERT_INFO);
  // The runtime's own wording (who was rebound) never reaches the page.
  await expect(fac.locator("body")).not.toContainText("rebound after a code reissue");
  expect(await fac.content()).not.toContain("rebound after a code reissue");
});

test("the live view raises no securitypolicyviolation", async ({ browser }) => {
  test.setTimeout(300_000);
  const live = await startedSession(browser, async (fac) => {
    const install = async (p: Page) =>
      p.addInitScript(() => {
        const w = window as unknown as { __csp: string[] };
        w.__csp = [];
        document.addEventListener("securitypolicyviolation", (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
      });
    await install(fac);
    // The init script runs on the next navigation; the facilitator page then reloads below.
  });
  const { fac, players, sessionId, stack: s } = live;
  const dialogs: string[] = [];
  fac.on("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });

  await say(players.delivery_lead.page, HOSTILE);
  await fac.goto(`${s.baseUrl}/console/${sessionId}`);
  await expect(fac.getByRole("heading", { name: "Live session" })).toBeVisible();
  const entry = timeline(fac).locator("li.msg").filter({ hasText: "reversed" });
  await expect(entry).toHaveCount(1);
  await expect(entry.locator(".line")).toHaveText(HOSTILE);
  await expect(timeline(fac).locator("img")).toHaveCount(0);
  await expect(fac.locator("main img, body img")).toHaveCount(0);

  const raw = await fac.context().request.get(`${s.baseUrl}/console/${sessionId}`);
  const html = (await raw.text()) + (await fac.content());
  for (const word of ["hiddenFacts", "participantId"]) expect(html, `the page never carries ${word}`).not.toContain(word);

  expect(dialogs).toEqual([]);
  expect(await fac.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
});

test("a reload keeps the line and a second console tab follows the same events", async ({ browser }) => {
  test.setTimeout(300_000);
  const { fac, players, sessionId, stack: s } = await startedSession(browser);
  const first = "We should look at the logs first";
  await say(players.tech_lead.page, first);
  const hasLine = (p: Page, t: string) => timeline(p).locator("li.msg").filter({ hasText: t });
  await expect(hasLine(fac, first)).toHaveCount(1);

  await fac.reload();
  await expect(hasLine(fac, first)).toHaveCount(1);

  const second = await fac.context().newPage(); // closed with the facilitator's context
  await second.goto(`${s.baseUrl}/console/${sessionId}`);
  await expect(hasLine(second, first)).toHaveCount(1);

  const next = "Agreed, then we call the customer";
  await say(players.account_manager.page, next);
  await expect(hasLine(fac, next)).toHaveCount(1);
  await expect(hasLine(second, next)).toHaveCount(1);
  await expect(hasLine(second, first)).toHaveCount(1);
});

test("a player cookie on the console stream URL is 401", async ({ browser }) => {
  test.setTimeout(240_000);
  const { fac, players, sessionId, stack: s } = await startedSession(browser);
  const url = `${s.baseUrl}/api/v1/console/sessions/${sessionId}/stream`;
  const headers = { Accept: "text/event-stream" };
  // The player's cookie is really there and really sent: the same page fetch that carries the facilitator's cookie below, as a player.
  expect((await players.delivery_lead.context.cookies(s.baseUrl)).map((c) => c.name)).toEqual(["__Host-scenecoach"]);
  const asPlayer = await players.delivery_lead.page.evaluate(async (u) => {
    const r = await fetch(u, { headers: { Accept: "text/event-stream" }, credentials: "include" });
    return r.status;
  }, url);
  expect(asPlayer).toBe(401);
  const viaRequest = await players.delivery_lead.context.request.get(url, { headers });
  expect(viaRequest.status()).toBe(401);
  // Without any cookie, too.
  const stranger = await browser.newContext();
  expect((await stranger.request.get(url, { headers })).status()).toBe(401);
  await stranger.close();
  // And the facilitator's own cookie opens the stream (the status is read from the headers; the body never ends, so abort).
  const own = await fac.evaluate(async (u) => {
    const ctl = new AbortController();
    const r = await fetch(u, { headers: { Accept: "text/event-stream" }, signal: ctl.signal });
    ctl.abort();
    return { status: r.status, type: r.headers.get("content-type") };
  }, url);
  expect(own.status).toBe(200);
  expect(own.type).toMatch(/^text\/event-stream/);
});

test("no serious or critical Axe violations on the live view at 1280 px and 400 px, light and dark, with no horizontal scroll at either width", async ({ browser }) => {
  test.setTimeout(420_000);
  const { fac, players } = await startedSession(browser);
  await say(players.delivery_lead.page, "Let us start with the escalation owner");
  await say(players.tech_lead.page, HOSTILE);
  await expect(timeline(fac).locator("li.msg").filter({ hasText: "reversed" })).toHaveCount(1);
  await expect(wordsSpoken(fac).getByRole("table", { name: "Players" })).toBeVisible();

  for (const width of [1280, 400] as const) {
    await fac.setViewportSize({ width, height: 860 });
    await checkBothSchemes(fac, `live view with untrusted text at ${width} px`);
    await noHorizontalScroll(fac, width);
  }
});

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { checkBothSchemes, createSession, expectSeatReady, noHorizontalScroll, startButton } from "./helpers/console";
import { playerContext, PLAYERS, seatLauncher, type Player } from "./helpers/players";
import { startLauncherStack, type LauncherStack } from "./helpers/start-launcher-stack";

// US-0083: facilitator accounts end to end, on the launcher stack (the real control service with a fresh private data dir per test, so
// control writes a new accounts.json holding only the default admin `admin`, active, must change its password; `next start` against
// it). The default admin's first password is control's built-in default (the stack sets no ADMIN_BOOTSTRAP_PASSWORD). Every wait is
// on an effect; no fixed sleep. The stream's heartbeat is 15 s; a revoke ends the account's open streams at once (closeAccount), so the
// waits for that are kept well under one heartbeat.

const DEFAULT_ADMIN = { login: "admin", password: "ChangeMe-Admin-1" };
const ADMIN_NEW = "Admin-Chosen-Passphrase-41";
const FAC1 = { name: "Fran Facilitator", login: "fran@example.test", password: "Fran-Chosen-Passphrase-52" };
const FAC2 = { name: "Sam Second", login: "sam@example.test", password: "Sam-Chosen-Passphrase-63" };
/** Comfortably under the 15 s heartbeat: a revoke must end the stream at once, not at the next beat. */
const AT_ONCE_MS = 8_000;
const CONSOLE_EXPIRED = "Your console sign-in has expired. Sign in again.";
const PLAYER_NAMES: Record<Player, string> = { delivery_lead: "Dana Lead", tech_lead: "Tomás Tech", account_manager: "Ama Accounts" };

let stack: LauncherStack | null = null;
const opened: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of opened.splice(0)) await c.close().catch(() => undefined);
  await stack?.stop();
  stack = null;
});

async function newPage(browser: Browser, width = 1280): Promise<Page> {
  const context = await playerContext(browser, { width });
  opened.push(context);
  return context.newPage();
}

/** Signs in with a login and a password on /console; the caller asserts where it lands. */
async function accountSignIn(page: Page, baseUrl: string, login: string, password: string): Promise<void> {
  await page.goto(`${baseUrl}/console`);
  await page.getByLabel("Login").fill(login);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/** On the forced change page: replaces the current password with `next` and lands on /console. */
async function changePassword(page: Page, current: string, next: string): Promise<void> {
  await page.getByLabel("Current (temporary) password").fill(current);
  await page.getByLabel("New password").fill(next);
  await page.getByLabel("Repeat").fill(next);
  await page.getByRole("button", { name: "Change password" }).click();
  await page.waitForURL((u) => u.pathname === "/console");
}

async function expectForcedChange(page: Page): Promise<void> {
  await page.waitForURL((u) => u.pathname === "/console/password");
  await expect(page.getByRole("heading", { name: "Change password" })).toBeVisible();
  await expect(page.getByText("Choose a new password before you continue.")).toBeVisible();
}

/** The default admin, signed in and past the forced change, on /console. */
async function adminSignedIn(browser: Browser, s: LauncherStack, o: { onForced?: (p: Page) => Promise<void> } = {}): Promise<Page> {
  const admin = await newPage(browser);
  await accountSignIn(admin, s.baseUrl, DEFAULT_ADMIN.login, DEFAULT_ADMIN.password);
  await expectForcedChange(admin);
  if (o.onForced) await o.onForced(admin);
  await changePassword(admin, DEFAULT_ADMIN.password, ADMIN_NEW);
  await expect(admin.getByText("Signed in as Administrator")).toBeVisible();
  return admin;
}

/** Creates an account on /console/admin and returns the temporary password the page shows once. */
async function createAccount(admin: Page, who: { name: string; login: string }): Promise<string> {
  await admin.getByLabel("Name", { exact: true }).fill(who.name);
  await admin.getByLabel("Email (their login)").fill(who.login);
  await admin.getByRole("button", { name: "Create facilitator" }).click();
  const panel = admin.getByRole("region", { name: "Sign-in details" });
  await expect(panel).toBeVisible();
  await expect(panel.locator(".code-row").filter({ hasText: "Login" }).locator("code")).toHaveText(who.login);
  const temp = (await panel.locator(".code-row").filter({ hasText: "Temporary password" }).locator("code").innerText()).trim();
  expect(temp.length).toBeGreaterThanOrEqual(10);
  return temp;
}

const accountRow = (admin: Page, name: string) =>
  admin.locator("table tbody tr").filter({ has: admin.getByRole("rowheader", { name, exact: true }) });

/** A facilitator page signed in with its temporary password and past the forced change, on /console. */
async function facilitatorSignedIn(browser: Browser, s: LauncherStack, who: typeof FAC1, temp: string): Promise<Page> {
  const page = await newPage(browser);
  await accountSignIn(page, s.baseUrl, who.login, temp);
  await expectForcedChange(page);
  // Every other console page sends a must-change account back to the change.
  await page.goto(`${s.baseUrl}/console`);
  await expectForcedChange(page);
  await changePassword(page, temp, who.password);
  await expect(page.getByText(`Signed in as ${who.name}`)).toBeVisible();
  // A facilitator sees neither the Admin link nor any owner.
  await expect(page.getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Owner" })).toHaveCount(0);
  return page;
}

/**
 * A same-origin call from the page (its own cookie, the browser's Origin and Sec-Fetch-Site): the status and the parsed body. With a
 * body it also sends X-Requested-With, like the pages' postJson (the BFF's CSRF check on a state change).
 */
function call(page: Page, url: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({ url, method, body }) => {
      const r = await fetch(url, {
        method: method ?? "GET",
        headers: body === undefined ? {} : { "Content-Type": "application/json", "X-Requested-With": "scenecoach" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let parsed: unknown = null;
      try {
        parsed = await r.json();
      } catch {
        /* not JSON */
      }
      return { status: r.status, body: parsed };
    },
    { url, method: init.method, body: init.body },
  );
}

/** The status of a console stream request from the page (as its EventSource sends it); the body is never read, the request is aborted. */
function streamStatus(page: Page, sessionId: string): Promise<number> {
  return page.evaluate(async (u) => {
    const ctl = new AbortController();
    const r = await fetch(u, { headers: { Accept: "text/event-stream" }, signal: ctl.signal });
    ctl.abort();
    return r.status;
  }, `/api/v1/console/sessions/${sessionId}/stream`);
}

const errorCode = (body: unknown) => (body as { error?: { code?: string } } | null)?.error?.code;

/**
 * Opens a second, raw reader on the console stream from the page (beside the page's own EventSource) and records on `window` when its
 * response arrived, the tail of what it read (the final event's frame) and when its body ended. Resolves once the response is 200.
 */
async function openRawStream(page: Page, url: string): Promise<void> {
  await page.evaluate((u) => {
    const w = window as unknown as { __raw: { status: number | null; ended: boolean; tail: string } };
    w.__raw = { status: null, ended: false, tail: "" };
    void fetch(u, { headers: { Accept: "text/event-stream" } })
      .then(async (r) => {
        w.__raw.status = r.status;
        const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          w.__raw.tail = (w.__raw.tail + value).slice(-200);
        }
        w.__raw.ended = true;
      })
      .catch(() => {
        w.__raw.ended = true;
      });
  }, url);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __raw: { status: number | null } }).__raw.status)).toBe(200);
  expect(await page.evaluate(() => (window as unknown as { __raw: { ended: boolean } }).__raw.ended)).toBe(false);
}

test("accounts: the default admin, two facilitators, ownership, a revoke that ends the open stream at once, and a reassignment", async ({ browser }) => {
  test.setTimeout(420_000);
  stack = await startLauncherStack();
  const s = stack;

  // The legacy latch is open on a fresh data dir: the sign-in still offers the shared secret.
  const before = await newPage(browser);
  await before.goto(`${s.baseUrl}/console`);
  await expect(before.getByText("Use the shared secret instead")).toBeVisible();

  // 1. The default admin signs in with the default password and must change it first.
  const admin = await adminSignedIn(browser, s);
  await expect(admin.getByRole("link", { name: "Admin", exact: true })).toBeVisible();
  // The default password no longer works.
  const stale = await newPage(browser);
  await accountSignIn(stale, s.baseUrl, DEFAULT_ADMIN.login, DEFAULT_ADMIN.password);
  await expect(stale.getByText("That did not work. Check the login and the password and try again.")).toBeVisible();

  // 2. The shared secret stops working: no disclosure on the sign-in and the BFF refuses it like a wrong secret.
  const legacy = await newPage(browser);
  await legacy.goto(`${s.baseUrl}/console`);
  await expect(legacy.getByLabel("Login")).toBeVisible();
  await expect(legacy.getByText("Use the shared secret instead")).toHaveCount(0);
  const refused = await call(legacy, "/api/v1/console/login", { method: "POST", body: { secret: s.facilitatorSecret, name: "Ann" } });
  expect(refused.status).toBe(401);
  expect(
    (await legacy.context().cookies()).filter((c) => c.name.startsWith("__Host-scenecoach-fac")),
    "no console cookie from the shared secret",
  ).toEqual([]);

  // 3. The admin creates two facilitators; each temporary password is shown once.
  await admin.getByRole("link", { name: "Admin", exact: true }).click();
  await admin.waitForURL((u) => u.pathname === "/console/admin");
  const temp1 = await createAccount(admin, FAC1);
  await expect(accountRow(admin, FAC1.name).locator("td").nth(2)).toHaveText("Invited");
  await admin.getByRole("button", { name: "I have shared these" }).click();
  await expect(admin.getByRole("region", { name: "Sign-in details" })).toHaveCount(0);
  const temp2 = await createAccount(admin, FAC2);
  expect(temp2).not.toBe(temp1);
  // A reload shows the list again but never the password.
  await admin.reload();
  await expect(accountRow(admin, FAC2.name)).toHaveCount(1);
  await expect(admin.getByRole("region", { name: "Sign-in details" })).toHaveCount(0);
  const html = await admin.content();
  expect(html).not.toContain(temp1);
  expect(html).not.toContain(temp2);

  // 4. The first facilitator signs in, must change the password, and creates a session (it becomes its owner).
  const fac1 = await facilitatorSignedIn(browser, s, FAC1, temp1);
  const { sessionId, codes } = await createSession(fac1, s.baseUrl);
  await fac1.goto(`${s.baseUrl}/console`);
  await expect(fac1.getByRole("link", { name: /^Open session / })).toHaveCount(1);

  // 5. The second facilitator gets the neutral 404 for it (the same answer as for a session that does not exist) and an empty list.
  const fac2 = await facilitatorSignedIn(browser, s, FAC2, temp2);
  await expect(fac2.getByText("No sessions yet")).toBeVisible();
  const foreign = await call(fac2, `/api/v1/console/sessions/${sessionId}`);
  const unknown = await call(fac2, `/api/v1/console/sessions/no-such-session-0000`);
  expect(foreign.status).toBe(404);
  // The same answer apart from the envelope's timestamp.
  const neutral = (r: { status: number; body: unknown }) => ({ status: r.status, error: (r.body as { error?: unknown } | null)?.error });
  expect(neutral(foreign)).toEqual(neutral(unknown));
  expect(errorCode(foreign.body)).toBe("not_found");
  expect(await streamStatus(fac2, sessionId)).toBe(404);
  // The admin can open it, and sees its owner.
  expect((await call(admin, `/api/v1/console/sessions/${sessionId}`)).status).toBe(200);
  await admin.goto(`${s.baseUrl}/console`);
  const owner = admin.getByRole("combobox", { name: /^Owner of session / });
  await expect(owner).toHaveCount(1);
  await expect(admin.locator("table tbody tr td bdi")).toHaveText(FAC1.name);
  await admin.goto(`${s.baseUrl}/console/${sessionId}`);
  await expect(startButton(admin)).toBeVisible();

  // 6. Three players join and the first facilitator starts the session; its console follows it live, with a second raw stream open.
  for (const role of PLAYERS) {
    const seated = await seatLauncher(browser, s.baseUrl, sessionId, role, codes[role], PLAYER_NAMES[role]);
    opened.push(seated.context);
  }
  await fac1.goto(`${s.baseUrl}/console/${sessionId}`);
  for (const role of PLAYERS) await expectSeatReady(fac1, role);
  await startButton(fac1).click();
  await expect(fac1.getByRole("heading", { name: "Live session" })).toBeVisible();
  await openRawStream(fac1, `/api/v1/console/sessions/${sessionId}/stream`);

  // 7. The admin revokes the first facilitator: that person's open console page and stream are refused at once.
  await admin.goto(`${s.baseUrl}/console/admin`);
  await admin.getByRole("button", { name: `Revoke ${FAC1.name}` }).click();
  const dialog = admin.getByRole("dialog");
  await dialog.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(accountRow(admin, FAC1.name).locator("td").nth(2)).toHaveText("Revoked");
  await expect(fac1.getByText(CONSOLE_EXPIRED)).toBeVisible({ timeout: AT_ONCE_MS });
  await expect
    .poll(() => fac1.evaluate(() => (window as unknown as { __raw: { ended: boolean } }).__raw.ended), { timeout: AT_ONCE_MS })
    .toBe(true);
  expect(await fac1.evaluate(() => (window as unknown as { __raw: { tail: string } }).__raw.tail)).toMatch(/event: expired\ndata: \{\}\n\n$/);
  // Every later request with that cookie is refused, a new stream included, and the console asks for a sign-in again.
  expect((await call(fac1, "/api/v1/console/sessions")).status).toBe(401);
  expect(await streamStatus(fac1, sessionId)).toBe(401);
  await fac1.goto(`${s.baseUrl}/console`);
  await expect(fac1.getByLabel("Login")).toBeVisible();
  // And the revoked account cannot sign in again.
  await accountSignIn(fac1, s.baseUrl, FAC1.login, FAC1.password);
  await expect(fac1.getByText("That did not work. Check the login and the password and try again.")).toBeVisible();

  // 8. The session keeps running; the admin assigns it to the second facilitator, who then has it.
  await admin.goto(`${s.baseUrl}/console`);
  await expect(admin.locator("table tbody tr .pill")).toHaveText("Running");
  await expect(owner.locator("option:checked")).toHaveText(`${FAC1.name} (revoked)`);
  await owner.selectOption({ label: FAC2.name });
  await admin.getByRole("button", { name: /^Assign session / }).click();
  await expect(admin.locator("table tbody tr td bdi")).toHaveText(FAC2.name);
  await fac2.reload();
  await expect(fac2.locator("table tbody tr .pill")).toHaveText("Running");
  await fac2.getByRole("link", { name: /^Open session / }).click();
  await fac2.waitForURL((u) => u.pathname === `/console/${sessionId}`);
  await expect(fac2.getByRole("heading", { name: "Live session" })).toBeVisible();
  expect((await call(fac2, `/api/v1/console/sessions/${sessionId}`)).status).toBe(200);
});

test("no serious or critical Axe violations on the forced password change, the admin screen and the Owner column, in light and dark", async ({ browser }) => {
  test.setTimeout(300_000);
  stack = await startLauncherStack();
  const s = stack;

  // The forced change (reached from the default admin's first sign-in), empty and with a refusal on it.
  const admin = await adminSignedIn(browser, s, {
    onForced: async (p) => {
      await checkBothSchemes(p, "/console/password (forced change)");
      await p.getByLabel("Current (temporary) password").fill(DEFAULT_ADMIN.password);
      await p.getByLabel("New password").fill("short");
      await p.getByLabel("Repeat").fill("short");
      await p.getByRole("button", { name: "Change password" }).click();
      await expect(p.getByText("Use at least 10 characters for the new password.")).toBeVisible();
      await checkBothSchemes(p, "/console/password (refused)");
      await p.getByLabel("Current (temporary) password").fill("");
    },
  });

  // The admin screen: the list, the one-time credentials panel, and a confirmation dialog.
  await admin.goto(`${s.baseUrl}/console/admin`);
  await expect(accountRow(admin, "Administrator")).toHaveCount(1);
  await checkBothSchemes(admin, "/console/admin");
  await createAccount(admin, FAC1);
  await checkBothSchemes(admin, "/console/admin (sign-in details shown)");
  await admin.getByRole("button", { name: "I have shared these" }).click();
  await admin.getByRole("button", { name: `Revoke ${FAC1.name}` }).click();
  await expect(admin.getByRole("dialog")).toBeVisible();
  await checkBothSchemes(admin, "/console/admin (revoke dialog)");
  await admin.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  for (const width of [1280, 400] as const) {
    await admin.setViewportSize({ width, height: 860 });
    await noHorizontalScroll(admin, width);
  }
  await admin.setViewportSize({ width: 1280, height: 860 });

  // The admin's session list with the Owner column (a session the admin created: its owner is the admin).
  await createSession(admin, s.baseUrl);
  await admin.goto(`${s.baseUrl}/console`);
  await expect(admin.getByRole("columnheader", { name: "Owner" })).toBeVisible();
  await expect(admin.getByRole("combobox", { name: /^Owner of session / })).toHaveCount(1);
  for (const width of [1280, 400] as const) {
    await admin.setViewportSize({ width, height: 860 });
    await checkBothSchemes(admin, `the console shell with the Owner column at ${width} px`);
    await noHorizontalScroll(admin, width);
  }
});

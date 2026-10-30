import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  checkBothSchemes,
  createSession,
  expectSeatReady,
  facilitator,
  JOIN_REFUSED,
  noHorizontalScroll,
  ROLE_LABEL,
  startButton,
} from "./helpers/console";
import {
  joinAsLauncher,
  playerContext,
  PLAYERS,
  seatLauncher,
} from "./helpers/players";
import {
  startLauncherStack,
  type LauncherStack,
} from "./helpers/start-launcher-stack";

// The facilitator console against the real control service (mock models, temp data dir) and `next start` in launcher mode: sign in,
// create a session, three players join with the codes shown once, readiness, Start, reissue, a control-service restart, the two
// 401 boundaries and Axe. Every wait is on an effect (auto-retrying expect); no fixed sleep and no assertion on elapsed time.

let stack: LauncherStack | null = null;
test.afterEach(async () => {
  await stack?.stop();
  stack = null;
});

const NAMES = {
  delivery_lead: "Dana Lead",
  tech_lead: "Tomás Tech",
  account_manager: "Ama Accounts",
} as const;
const ORIGIN_HEADERS = (baseUrl: string) => ({
  Origin: baseUrl,
  "X-Requested-With": "scenecoach",
});
const sceneHeading = (page: Page) =>
  page.getByRole("heading", { name: "Play the scene" });

test("facilitator logs in, creates a session, three players join with the shown codes and consent, readiness shows all joined and consented, Start becomes enabled and pressing it starts the session (a player sees the scene)", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  stack = await startLauncherStack();
  const fac = await facilitator(
    browser,
    stack.baseUrl,
    stack.facilitatorSecret,
  );
  const { sessionId, codes } = await createSession(fac, stack.baseUrl);

  const players = {} as Record<(typeof PLAYERS)[number], Page>;
  for (const role of PLAYERS)
    players[role] = (
      await seatLauncher(
        browser,
        stack.baseUrl,
        sessionId,
        role,
        codes[role],
        NAMES[role],
      )
    ).page;

  await fac.goto(`${stack.baseUrl}/console/${sessionId}`);
  for (const role of PLAYERS) await expectSeatReady(fac, role);
  await expect(startButton(fac)).toBeEnabled();
  await startButton(fac).click();
  await expect(fac.getByText("The session has started.")).toBeVisible();

  for (const role of PLAYERS) {
    await expect(sceneHeading(players[role])).toBeVisible();
    await expect(
      players[role].getByText(/^Scene 1 of [23]: Team huddle$/),
    ).toBeVisible();
    await expect(
      players[role].getByText(/Email from Priya Raman/),
    ).toBeVisible();
  }
});

test("reissue issues a new code and the old code is refused", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  stack = await startLauncherStack();
  const fac = await facilitator(
    browser,
    stack.baseUrl,
    stack.facilitatorSecret,
  );
  const { sessionId, codes } = await createSession(fac, stack.baseUrl);

  await fac.goto(`${stack.baseUrl}/console/${sessionId}`);
  await fac
    .getByRole("button", { name: `Reissue code for ${ROLE_LABEL.tech_lead}` })
    .click();
  const dialog = fac.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Reissue code", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const row = fac
    .locator(".code-row")
    .filter({
      has: fac.locator(".code-role", {
        hasText: new RegExp(`^${ROLE_LABEL.tech_lead}$`),
      }),
    });
  await expect(row).toBeVisible();
  const fresh = (await row.locator("code").innerText()).trim();
  expect(fresh).not.toBe("");
  expect(fresh).not.toBe(codes.tech_lead);

  // The old code is refused with the neutral join message; the page stays on the join form.
  const stranger = await (await playerContext(browser)).newPage();
  await stranger.goto(
    `${stack.baseUrl}/join?session=${sessionId}&role=tech_lead`,
  );
  await stranger.getByLabel("Your name").fill("Tomás");
  await stranger.getByLabel("Your join code").fill(codes.tech_lead);
  await stranger.getByRole("button", { name: "Join" }).click();
  await expect(stranger.locator("p.err[role=alert]")).toHaveText(JOIN_REFUSED);
  await expect(stranger).toHaveURL(/\/join\?/);

  // The new code seats the player.
  await joinAsLauncher(
    stranger,
    stack.baseUrl,
    sessionId,
    "tech_lead",
    fresh,
    "Tomás",
  );
  await expect(
    stranger.getByRole("heading", { name: /Consent, notice/ }),
  ).toBeVisible();
});

// The console disables per-role Reissue once the session has started (Task 15's UI rule, spec 5.4: the buttons need status idle), so
// this goes through the API route directly with the facilitator's cookie; the runtime does the rebind.
test("reissue after the start rebinds consent: a player who lost their cookie rejoins with the new code and sees the consent notice read-only", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  stack = await startLauncherStack();
  const fac = await facilitator(
    browser,
    stack.baseUrl,
    stack.facilitatorSecret,
  );
  const { sessionId, codes } = await createSession(fac, stack.baseUrl);
  const seated: BrowserContext[] = [];
  for (const role of PLAYERS)
    seated.push(
      (
        await seatLauncher(
          browser,
          stack.baseUrl,
          sessionId,
          role,
          codes[role],
          NAMES[role],
        )
      ).context,
    );

  await fac.goto(`${stack.baseUrl}/console/${sessionId}`);
  for (const role of PLAYERS) await expectSeatReady(fac, role);
  await startButton(fac).click();
  await expect(fac.getByText("The session has started.")).toBeVisible();
  // The UI rule this test works around: with the session running, the per-role button is off.
  await expect(
    fac.getByRole("button", {
      name: `Reissue code for ${ROLE_LABEL.tech_lead}`,
    }),
  ).toBeDisabled();

  const answer = await fac
    .context()
    .request.post(
      `${stack.baseUrl}/api/v1/console/sessions/${sessionId}/reissue`,
      {
        headers: ORIGIN_HEADERS(stack.baseUrl),
        data: { roleId: "tech_lead" },
      },
    );
  expect(answer.status(), await answer.text()).toBe(200);
  const fresh = ((await answer.json()) as { data: { code: string } }).data.code;
  expect(fresh).not.toBe(codes.tech_lead);

  // The tech lead lost their cookie: a fresh context rejoins with the new code, straight into the running scene.
  const again = await seatLauncher(
    browser,
    stack.baseUrl,
    sessionId,
    "tech_lead",
    fresh,
    NAMES.tech_lead,
    { consent: false },
  );
  await expect(sceneHeading(again.page)).toBeVisible();
  const notice = again.page
    .locator("details")
    .filter({ has: again.page.getByText("Consent notice", { exact: true }) });
  await expect(notice).toHaveCount(1);
  await expect(notice).not.toHaveAttribute("open", /.*/);
  await expect(
    again.page.getByRole("heading", { name: /Consent, notice/ }),
  ).toHaveCount(0);
  await expect(
    again.page.getByLabel("I have read this notice and agree to take part."),
  ).toHaveCount(0);
});

test("a control-service restart in the lobby keeps the codes, joined seats and consent", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  stack = await startLauncherStack();
  const fac = await facilitator(
    browser,
    stack.baseUrl,
    stack.facilitatorSecret,
  );
  const { sessionId, codes } = await createSession(fac, stack.baseUrl);
  await seatLauncher(
    browser,
    stack.baseUrl,
    sessionId,
    "delivery_lead",
    codes.delivery_lead,
    NAMES.delivery_lead,
  );
  await seatLauncher(
    browser,
    stack.baseUrl,
    sessionId,
    "tech_lead",
    codes.tech_lead,
    NAMES.tech_lead,
  );

  await stack.restartControl();

  // The runtime came back on a new port with a new facilitator token: the BFF fetches both afresh, and the roster is the same.
  await fac.goto(`${stack.baseUrl}/console/${sessionId}`);
  await expectSeatReady(fac, "delivery_lead");
  await expectSeatReady(fac, "tech_lead");
  await expect(
    fac.locator("tbody tr").filter({ hasText: NAMES.delivery_lead }),
  ).toHaveCount(1);
  await expect(
    fac.locator("tbody tr").filter({ hasText: NAMES.tech_lead }),
  ).toHaveCount(1);
  await expect(startButton(fac)).toBeDisabled();

  // The code shown at creation still works for the third player, from the same address, and Start then goes through.
  await seatLauncher(
    browser,
    stack.baseUrl,
    sessionId,
    "account_manager",
    codes.account_manager,
    NAMES.account_manager,
  );
  for (const role of PLAYERS) await expectSeatReady(fac, role);
  await expect(startButton(fac)).toBeEnabled();
  await startButton(fac).click();
  await expect(fac.getByText("The session has started.")).toBeVisible();
});

test("a player cookie on /api/v1/console/sessions returns 401 and a facilitator cookie on /api/v1/say returns 401", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  stack = await startLauncherStack();
  const fac = await facilitator(
    browser,
    stack.baseUrl,
    stack.facilitatorSecret,
  );
  const { sessionId, codes } = await createSession(fac, stack.baseUrl);
  const player = await seatLauncher(
    browser,
    stack.baseUrl,
    sessionId,
    "delivery_lead",
    codes.delivery_lead,
    NAMES.delivery_lead,
  );
  const headers = ORIGIN_HEADERS(stack.baseUrl);

  // Each cookie is real: the player's opens the session, the facilitator's opens the console.
  const names = async (c: BrowserContext) =>
    (await c.cookies()).map((k) => k.name);
  expect(await names(player.context)).toEqual(["__Host-scenecoach"]);
  expect(await names(fac.context())).toEqual(["__Host-scenecoach-fac"]);

  const playerRequest = player.context.request;
  const asPlayerList = await playerRequest.get(
    `${stack.baseUrl}/api/v1/console/sessions`,
    { headers },
  );
  expect(asPlayerList.status()).toBe(401);
  const asPlayerCreate = await playerRequest.post(
    `${stack.baseUrl}/api/v1/console/sessions`,
    { headers, data: { scenarioId: "friday-escalation" } },
  );
  expect(asPlayerCreate.status()).toBe(401);

  const facRequest = fac.context().request;
  const asFacilitatorSay = await facRequest.post(
    `${stack.baseUrl}/api/v1/say`,
    { headers, data: { text: "I am not a player." } },
  );
  expect(asFacilitatorSay.status()).toBe(401);
  // And the facilitator's own cookie still works where it belongs.
  expect(
    (
      await facRequest.get(`${stack.baseUrl}/api/v1/console/sessions`, {
        headers,
      })
    ).status(),
  ).toBe(200);
});

test("Axe passes on /console, /console/new and /console/[id] at 400 px and laptop width, light and dark", async ({
  browser,
}) => {
  test.setTimeout(420_000);
  stack = await startLauncherStack();
  const fac = await facilitator(
    browser,
    stack.baseUrl,
    stack.facilitatorSecret,
  );
  const seated: BrowserContext[] = [];
  for (const width of [400, 1280] as const) {
    await fac.setViewportSize({ width, height: 860 });
    const at = `at ${width} px`;

    await fac.goto(`${stack.baseUrl}/console/new`);
    await expect(
      fac.getByRole("button", { name: "Create session" }),
    ).toBeEnabled();
    await checkBothSchemes(fac, `New session, before Create ${at}`);
    await noHorizontalScroll(fac, width);
    const { sessionId, codes } = await createSession(fac, stack.baseUrl, {
      alreadyOnForm: true,
    });
    await checkBothSchemes(
      fac,
      `New session, after Create (codes shown) ${at}`,
    );
    await noHorizontalScroll(fac, width);

    await fac.goto(`${stack.baseUrl}/console`);
    await expect(
      fac.getByRole("link", { name: `Open session ${sessionId.slice(0, 8)}` }),
    ).toBeVisible();
    await checkBothSchemes(fac, `the session list ${at}`);
    await noHorizontalScroll(fac, width);

    await fac.goto(`${stack.baseUrl}/console/${sessionId}`);
    await expect(
      fac.getByRole("heading", { name: "Who is in the room" }),
    ).toBeVisible();
    // The roster lists every role, none joined yet: Start is off and says why.
    await expect(
      fac.getByRole("button", {
        name: `Reissue code for ${ROLE_LABEL.delivery_lead}`,
      }),
    ).toBeEnabled();
    await expect(startButton(fac)).toBeDisabled();
    await checkBothSchemes(fac, `readiness, nobody joined ${at}`);
    await noHorizontalScroll(fac, width);

    // The confirmation open: the page behind it must be out of reach for assistive technology.
    await fac
      .getByRole("button", {
        name: `Reissue code for ${ROLE_LABEL.delivery_lead}`,
      })
      .click();
    await expect(fac.getByRole("dialog")).toBeVisible();
    await checkBothSchemes(fac, `readiness, reissue confirmation open ${at}`);
    await noHorizontalScroll(fac, width);
    await fac.getByRole("button", { name: "Cancel" }).click();
    await expect(fac.getByRole("dialog")).toHaveCount(0);

    for (const role of PLAYERS)
      seated.push(
        (
          await seatLauncher(
            browser,
            stack.baseUrl,
            sessionId,
            role,
            codes[role],
            NAMES[role],
          )
        ).context,
      );
    for (const role of PLAYERS) await expectSeatReady(fac, role);
    await expect(startButton(fac)).toBeEnabled();
    await checkBothSchemes(fac, `readiness, everyone joined ${at}`);
    await noHorizontalScroll(fac, width);
  }
});

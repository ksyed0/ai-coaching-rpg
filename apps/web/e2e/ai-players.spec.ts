import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import {
  createSession,
  expectAiSeatReady,
  expectSeatReady,
  facilitator,
  makeAiPlayer,
  makeHuman,
  ROLE_LABEL,
  startButton,
} from "./helpers/console";
import {
  consent,
  joinAsLauncher,
  playerContext,
  say,
  seatLauncher,
  transcript,
  type Player,
} from "./helpers/players";
import {
  startLauncherStack,
  type LauncherStack,
} from "./helpers/start-launcher-stack";

// AI players against the real control service (its bots use the mock model provider, whose reply is "[mock reply]") and `next start`
// in launcher mode. The stack sets AI_PLAYER_SETTLE_MS=0, AI_PLAYER_MIN_GAP_MS=0 and AI_PLAYER_NUDGE_MS=600000: an AI player answers a
// human line at once and never speaks by itself, so the only lines it says are the ones a test causes. Every wait is on an effect
// (auto-retrying expect, a named response); no fixed sleep and no assertion on elapsed time. Every test has its own stack and session.

const MOCK_REPLY = "[mock reply]";
const HINT = "HINT-MARKER-77";
const NAMES: Record<Player, string> = {
  delivery_lead: "Dana Lead",
  tech_lead: "Tomás Tech",
  account_manager: "Ama Accounts",
};
const HUMANS = ["delivery_lead", "account_manager"] as const;

let stack: LauncherStack | null = null;
const opened: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of opened.splice(0)) await c.close().catch(() => undefined);
  await stack?.stop();
  stack = null;
});

const timeline = (p: Page) =>
  p.getByRole("list", { name: "Transcript and notices" });
const sessionUrl = (s: LauncherStack, id: string) =>
  `${s.baseUrl}/console/${id}`;

/** A facilitator with a created session whose Tech lead is an AI player (switched on the created panel, confirmed). */
async function sessionWithAi(browser: Browser) {
  stack = await startLauncherStack();
  const fac = await facilitator(
    browser,
    stack.baseUrl,
    stack.facilitatorSecret,
  );
  opened.push(fac.context());
  const { sessionId, codes } = await createSession(fac, stack.baseUrl);
  await makeAiPlayer(fac, "tech_lead");
  const roles = fac.getByRole("region", { name: "Roles" });
  await expect(
    roles.locator(".code-row").filter({ hasText: ROLE_LABEL.tech_lead }),
  ).toContainText("AI player");
  return { stack, fac, sessionId, codes };
}

/** The two human players join and consent; the AI player is in by itself; the facilitator waits for all three and presses Start. */
async function startWithAi(
  browser: Browser,
  s: LauncherStack,
  fac: Page,
  sessionId: string,
  codes: Record<Player, string>,
  seat: (b: Browser, base: string, id: string, role: Player, code: string, name: string) => Promise<{ context: BrowserContext; page: Page }> = seatLauncher,
) {
  const players = {} as Record<(typeof HUMANS)[number], { context: BrowserContext; page: Page }>;
  for (const role of HUMANS) {
    players[role] = await seat(browser, s.baseUrl, sessionId, role, codes[role], NAMES[role]);
    opened.push(players[role].context);
  }
  await fac.goto(sessionUrl(s, sessionId));
  for (const role of HUMANS) await expectSeatReady(fac, role);
  await expectAiSeatReady(fac, "tech_lead");
  await expect(startButton(fac)).toBeEnabled();
  await startButton(fac).click();
  await expect(
    fac.getByText("The session has started.", { exact: true }),
  ).toBeVisible();
  await expect(fac.getByRole("heading", { name: "Live session" })).toBeVisible();
  return players;
}

test("facilitator creates a session, makes Tech lead an AI player on the created panel (confirm), two players join and consent, readiness shows the AI player ready, Start succeeds, a player says a line and sees an AI player line marked AI with Tech lead", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { stack: s, fac, sessionId, codes } = await sessionWithAi(browser);
  // The AI role's code is gone from the page; the other two are still shown.
  await expect(fac.locator(".code-row code")).toHaveCount(2);
  await expect(
    fac.getByRole("button", { name: "Make Tech lead human" }),
  ).toBeVisible();

  const players = await startWithAi(browser, s, fac, sessionId, codes);
  await expect(fac.getByRole("heading", { name: "AI players" })).toBeVisible();

  const line = "Can someone take the rollback plan to the customer?";
  await say(players.delivery_lead.page, line);
  // The AI player answers the human line (a reply, no prompt): its line is in the human's transcript, marked AI, as Tech lead.
  const ai = transcript(players.delivery_lead.page)
    .locator("li.msg")
    .filter({ hasText: MOCK_REPLY });
  await expect(ai).toHaveCount(1);
  await expect(ai.locator(".h b")).toHaveText("AI player");
  await expect(ai.locator(".pill.ai")).toHaveText("AI");
  await expect(ai.locator(".h .muted")).toHaveText(ROLE_LABEL.tech_lead);
  // The other human sees the same line, and the facilitator's timeline too.
  await expect(
    transcript(players.account_manager.page).locator("li.msg").filter({ hasText: MOCK_REPLY }),
  ).toHaveCount(1);
  await expect(
    timeline(fac).locator("li.msg").filter({ hasText: MOCK_REPLY }).locator(".pill.ai"),
  ).toHaveText("AI");
});

test("untick the option, reload readiness: still unticked; start succeeds", async ({ browser }) => {
  test.setTimeout(300_000);
  const { stack: s, fac, sessionId, codes } = await sessionWithAi(browser);
  const box = fac.getByRole("checkbox", { name: "Include AI players in group scores" });
  // The created panel shows the option (on by default); readiness shows it too and posts the same change.
  await expect(box).toBeChecked();
  await fac.goto(sessionUrl(s, sessionId));
  await expect(box).toBeChecked();
  await Promise.all([
    fac.waitForResponse((r) => /\/ai-roles$/.test(new URL(r.url()).pathname) && r.request().method() === "POST" && r.ok()),
    box.uncheck(),
  ]);
  await expect(box).not.toBeChecked();
  await expect(box).toBeEnabled();
  await fac.reload();
  await expect(box).not.toBeChecked();
  await startWithAi(browser, s, fac, sessionId, codes);
  await expect(fac.getByText("AI players in group scores: off", { exact: true })).toBeVisible();
  await expect(fac.getByRole("checkbox")).toHaveCount(0);
});

test("a joined player switched to AI sees Role filled by an AI player", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  stack = await startLauncherStack();
  const fac = await facilitator(browser, stack.baseUrl, stack.facilitatorSecret);
  opened.push(fac.context());
  const { sessionId, codes } = await createSession(fac, stack.baseUrl);
  const tech = await seatLauncher(browser, stack.baseUrl, sessionId, "tech_lead", codes.tech_lead, NAMES.tech_lead);
  opened.push(tech.context);

  await fac.goto(sessionUrl(stack, sessionId));
  await expectSeatReady(fac, "tech_lead");
  await fac.getByRole("button", { name: "Make Tech lead an AI player" }).click();
  // A seat with a person in it gets the stronger wording: the person is named.
  const dialog = fac.getByRole("dialog");
  await expect(dialog).toContainText(`Replace`);
  await expect(dialog).toContainText(NAMES.tech_lead);
  await dialog.getByRole("button", { name: "Use AI player" }).click();
  await expect(dialog).toHaveCount(0);
  await expectAiSeatReady(fac, "tech_lead");

  await expect(
    tech.page.getByRole("heading", { name: "Role filled by an AI player" }),
  ).toBeVisible();
});

test("switching back to human shows New code for Tech lead once and the code joins the seat", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { stack: s, fac, sessionId } = await sessionWithAi(browser);
  await fac.goto(sessionUrl(s, sessionId));
  await expectAiSeatReady(fac, "tech_lead");

  await makeHuman(fac, "tech_lead");
  const heading = fac.getByRole("heading", { name: "New code for Tech lead" });
  await expect(heading).toHaveCount(1);
  const panel = fac.locator("section").filter({ has: heading });
  const code = (await panel.locator(".code-row code").innerText()).trim();
  expect(code).not.toBe("");
  // The seat is a human seat again: the AI row is gone and Reissue is offered.
  await expect(
    fac.getByRole("button", { name: "Reissue code for Tech lead" }),
  ).toBeVisible();

  const joined = await seatLauncher(browser, s.baseUrl, sessionId, "tech_lead", code, NAMES.tech_lead);
  opened.push(joined.context);
  await expectSeatReady(fac, "tech_lead");
  await expect(
    fac.locator("tbody tr").filter({ hasText: NAMES.tech_lead }),
  ).toHaveCount(1);
  // Still once: the heading did not come back as a second panel.
  await expect(heading).toHaveCount(1);
});

type Seen = { sse: string[]; other: string[]; reads: Promise<void>[] };

/** A joined and consenting player whose page the test watches below the page: every stream message and every other answer. */
async function watchedSeat(
  browser: Browser,
  baseUrl: string,
  sessionId: string,
  role: Player,
  code: string,
  name: string,
  sink: Seen,
) {
  const context = await playerContext(browser);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.eventSourceMessageReceived", (e) => { sink.sse.push(e.data); });
  page.on("response", (r) => {
    if ((r.headers()["content-type"] ?? "").startsWith("text/event-stream")) return; // read as messages, above
    sink.reads.push(r.text().then((t) => { sink.other.push(t); }, () => undefined));
  });
  await joinAsLauncher(page, baseUrl, sessionId, role, code, name);
  await consent(page);
  return { context, page };
}

test("Prompt AI player with the hint HINT-MARKER-77 makes the AI player speak; no player page, no answer delivered to a player and not the console timeline holds the hint, and the recent turns list shows it", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { stack: s, fac, sessionId, codes } = await sessionWithAi(browser);
  const seen: Seen = { sse: [], other: [], reads: [] };
  // Only the Delivery lead's page is captured below the page; the other player is a plain seat.
  const players = await startWithAi(browser, s, fac, sessionId, codes, (b, base, id, role, code, name) =>
    role === "delivery_lead"
      ? watchedSeat(b, base, id, role, code, name, seen)
      : seatLauncher(b, base, id, role, code, name),
  );
  const watched = players.delivery_lead.page;

  const panel = fac.getByRole("region", { name: "AI players" });
  await expect(panel).toBeVisible();
  await panel.getByLabel(/^Hint for the AI player for Tech lead/).fill(HINT);
  const prompt = panel.getByRole("button", { name: "Prompt the AI player for Tech lead" });
  await expect(prompt).toBeEnabled();
  // The bot may not have processed the scene's entry yet, which the route answers with the busy copy: click again only then.
  let refused: string | null = null;
  await expect(async () => {
    const [answer] = await Promise.all([
      fac.waitForResponse((r) => /\/ai-roles\/tech_lead\/prompt$/.test(new URL(r.url()).pathname) && r.request().method() === "POST"),
      prompt.click(),
    ]);
    const text = await answer.text();
    if (answer.status() !== 200 && !text.includes("The AI player is already answering")) {
      refused = `the prompt route answered ${answer.status()}: ${text}`; // any other refusal ends the retries
      return;
    }
    expect(answer.status(), "busy: the bot has not seen the scene yet").toBe(200);
    await expect(panel.getByText("Prompt sent. The AI player will answer shortly.")).toBeVisible();
  }).toPass({ timeout: 30_000 });
  expect(refused).toBeNull();

  // The AI player speaks, and the player sees it.
  await expect(
    transcript(watched).locator("li.msg").filter({ hasText: MOCK_REPLY }),
  ).toHaveCount(1);
  await expect(
    timeline(fac).locator("li.msg").filter({ hasText: MOCK_REPLY }),
  ).toHaveCount(1);
  // The facilitator's notice about the prompt is there; it never carries the hint.
  await expect(timeline(fac).locator("li", { hasText: "prompted by" })).toHaveCount(1);

  // The recent turns show the hint (and that the turn was a prompt that spoke). The entry is written when the line's own event
  // arrives, so the list is opened again until it is there rather than waited for by time.
  const toggle = panel.getByRole("button", { name: /recent turns for Tech lead$/ });
  await expect(async () => {
    if ((await toggle.textContent()) === "Hide recent turns") await toggle.click();
    await toggle.click();
    await expect(panel.locator("ol li")).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  const turn = panel.locator("ol li");
  await expect(turn).toContainText("prompt");
  await expect(turn).toContainText("spoke");
  await expect(turn).toContainText(`Hint: `);
  await expect(turn).toContainText(HINT);

  // The hint is nowhere a player or the shared timeline can see it.
  expect(await timeline(fac).innerText()).not.toContain(HINT);
  for (const role of HUMANS) {
    const page = players[role].page;
    expect(await page.locator("body").innerText(), `${role}'s page`).not.toContain(HINT);
    expect(await page.content(), `${role}'s markup`).not.toContain(HINT);
  }
  // Below the page: the watched player's stream messages and other answers. The stream did deliver the AI line (so the capture sees
  // what a player is sent), and none of it holds the hint.
  expect(seen.sse.some((m) => m.includes(MOCK_REPLY)), "the captured stream carried the AI player's line").toBe(true);
  expect(seen.sse.length).toBeGreaterThan(0);
  expect(seen.sse.filter((m) => m.includes(HINT))).toEqual([]);
  await Promise.all(seen.reads); // every answer body has been read before the assertion
  expect(seen.other.filter((m) => m.includes(HINT))).toEqual([]);
});

test("Reissue is not offered for the AI row and a direct POST answers This role is played by an AI player. Switch it back to human first.", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { stack: s, fac, sessionId } = await sessionWithAi(browser);
  await fac.goto(sessionUrl(s, sessionId));
  await expectAiSeatReady(fac, "tech_lead");

  await expect(
    fac.getByRole("button", { name: "Reissue code for Tech lead" }),
  ).toHaveCount(0);
  await expect(
    fac.getByRole("button", { name: "Remove the participant from Tech lead" }),
  ).toHaveCount(0);
  // The human roles keep theirs.
  await expect(
    fac.getByRole("button", { name: "Reissue code for Delivery lead" }),
  ).toBeVisible();
  await expect(
    fac.getByRole("button", { name: "Reissue code for Account manager" }),
  ).toBeVisible();

  const headers = { Origin: s.baseUrl, "X-Requested-With": "scenecoach" };
  const answer = await fac
    .context()
    .request.post(`${s.baseUrl}/api/v1/console/sessions/${sessionId}/reissue`, {
      headers,
      data: { roleId: "tech_lead" },
    });
  const body = (await answer.json()) as { success: boolean; error: { code: string; message: string } | null };
  expect(answer.status(), JSON.stringify(body)).toBe(409);
  expect(body.error?.message).toBe(
    "This role is played by an AI player. Switch it back to human first.",
  );
  expect(body.error?.code).toBe("ai_role");
});

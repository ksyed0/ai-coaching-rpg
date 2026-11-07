import { expect, test, type BrowserContext } from "@playwright/test";
import {
  createSession,
  expectAiSeatReady,
  expectSeatReady,
  facilitator,
  makeAiPlayer,
  ROLE_LABEL,
  startButton,
} from "./helpers/console";
import { seatLauncher, type Player } from "./helpers/players";
import { BOB, seedDraft } from "./helpers/reports";
import { startLauncherStack, type LauncherStack } from "./helpers/start-launcher-stack";

// US-0060 (AC-0322, TC-0149): an AI role never gets a report link, against the real control service and `next start` in launcher mode.
// Tech lead is made an AI player through the real lobby before Start, so the session log the guard reads records it. The review folder
// is seeded (`seedDraft`: alice released, bob a draft; the mock models cannot score the e2e session). The guard runs after the review
// check and before the "has a report" check, so without it the AI role would answer NO_REPORT, as the human role here does: the body
// sentence is what proves the guard. Every wait is on an effect; no fixed sleep.

const AI_LINK_REFUSED = "AI players do not get report links.";
const NO_REPORT = "There is no report to link for this role.";
const NAMES: Record<Player, string> = { delivery_lead: "Dana Lead", tech_lead: "Tomás Tech", account_manager: "Ama Accounts" };
const HUMANS = ["delivery_lead", "account_manager"] as const;

let stack: LauncherStack | null = null;
const opened: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of opened.splice(0)) await c.close().catch(() => undefined);
  await stack?.stop();
  stack = null;
});

type Answer = { success: boolean; data?: unknown; error: { code: string; message: string } | null };

test("an AI role is refused a report link (AI players do not get report links.) and the link list offers it no Issue link", async ({ browser }) => {
  test.setTimeout(300_000);
  stack = await startLauncherStack();
  const s = stack;
  const fac = await facilitator(browser, s.baseUrl, s.facilitatorSecret);
  opened.push(fac.context());

  // Lobby: Tech lead becomes an AI player, the two humans join and consent, Start, then End.
  const { sessionId, codes } = await createSession(fac, s.baseUrl);
  await makeAiPlayer(fac, "tech_lead");
  for (const role of HUMANS) opened.push((await seatLauncher(browser, s.baseUrl, sessionId, role, codes[role], NAMES[role])).context);
  await fac.goto(`${s.baseUrl}/console/${sessionId}`);
  for (const role of HUMANS) await expectSeatReady(fac, role);
  await expectAiSeatReady(fac, "tech_lead");
  await expect(startButton(fac)).toBeEnabled();
  await startButton(fac).click();
  await expect(fac.getByText("The session has started.", { exact: true })).toBeVisible();
  const controls = fac.getByRole("region", { name: "Facilitator controls" });
  await expect(controls.getByRole("button", { name: /^(Pause|Resume)$/ })).toBeEnabled();
  await controls.getByRole("button", { name: "End session", exact: true }).click();
  const dialog = fac.getByRole("dialog");
  await dialog.getByRole("button", { name: "End session", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(fac.getByText("The session has ended.", { exact: true })).toHaveCount(1);

  await seedDraft(s, sessionId);

  // The console's own issue route, as the panel posts it (same-origin, with the BFF's write header).
  const linksUrl = `${s.baseUrl}/api/v1/console/sessions/${encodeURIComponent(sessionId)}/report-links`;
  const headers = { Origin: s.baseUrl, "X-Requested-With": "scenecoach" };
  const issue = async (role: string) => {
    const r = await fac.context().request.post(linksUrl, { headers, data: { role } });
    return { status: r.status(), body: (await r.json()) as Answer };
  };

  const ai = await issue("tech_lead");
  expect(ai.status, JSON.stringify(ai.body)).toBe(409);
  expect(ai.body.success).toBe(false);
  expect(ai.body.error?.message).toBe(AI_LINK_REFUSED);
  // The contrast: a human role with no report in the review gets the ordinary refusal, which is what the AI role would get without the guard.
  const human = await issue("delivery_lead");
  expect(human.status, JSON.stringify(human.body)).toBe(409);
  expect(human.body.error?.message).toBe(NO_REPORT);

  // No credential was minted for the AI role: the link list does not name it.
  const list = await fac.context().request.get(linksUrl, { headers });
  expect(list.status()).toBe(200);
  const listed = JSON.stringify(await list.json());
  expect(listed).toContain('"bob"');
  expect(listed).not.toContain("tech_lead");

  // The console's link list: the reviewed players are offered links, the AI role is not.
  await fac.goto(`${s.baseUrl}/console/${sessionId}`);
  await expect(fac.getByRole("heading", { name: "Participant reports" })).toBeVisible();
  await expect(fac.getByRole("button", { name: `Issue link for ${BOB}` })).toBeVisible();
  await expect(fac.getByRole("button", { name: `Issue link for ${ROLE_LABEL.tech_lead}` })).toHaveCount(0);
  await expect(fac.getByRole("button", { name: `Reissue link for ${ROLE_LABEL.tech_lead}` })).toHaveCount(0);
});

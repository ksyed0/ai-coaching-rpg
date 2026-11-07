import { expect, test, type BrowserContext } from "@playwright/test";
import {
  createSession,
  expectAiSeatReady,
  expectSeatReady,
  facilitator,
  makeAiPlayer,
  startButton,
} from "./helpers/console";
import { seatLauncher, type Player } from "./helpers/players";
import { seedDraft } from "./helpers/reports";
import { startLauncherStack, type LauncherStack } from "./helpers/start-launcher-stack";

// US-0060 (AC-0322, TC-0149): an AI role never gets a report link, against the real control service and `next start` in launcher mode.
// What this proves: Tech lead is made an AI player through the real lobby before Start, so the session log the guard reads records it;
// with the review seeded (`seedDraft`: subjects alice, released, and bob, a draft; the mock models cannot score the e2e session), the
// console's issue route refuses the AI role with the exact guard sentence. The guard sits after the review check and before the
// has-a-report check: without it the AI role would get NO_REPORT (the mutation check in the task report shows exactly that). Bob's link
// is minted in the same session, so the refusal is AI-specific, not a broken review. What it does not prove: the "AI player" label on
// the link row. That row exists only for an AI role with a stale live credential, which cannot be produced end to end (the guard stops
// it); the Task 3 control tests and Task 4 component tests cover it. Every wait is on an effect; no fixed sleep.

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

test("an AI role is refused a report link (AI players do not get report links.) while a human role in the same review is issued one", async ({ browser }) => {
  test.setTimeout(300_000);
  stack = await startLauncherStack();
  const s = stack;
  const fac = await facilitator(browser, s.baseUrl, s.facilitatorSecret);
  opened.push(fac.context());

  // Lobby: Tech lead becomes an AI player, the two humans join and consent, Start, then End. Inlined: endedSession (helpers/reports.ts)
  // seats all three roles as humans, so it cannot leave Tech lead to an AI player.
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

  // The console's own issue route, as the panel posts it (same-origin, with the BFF's write header). No shared e2e helper exports these
  // headers (console-flow and ai-players keep their own local copies), so they are literals here too.
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
  // A human role with a report in the same review IS issued a link: the review and the route work, so the refusal above is AI-specific.
  const bob = await issue("bob");
  expect(bob.status, JSON.stringify(bob.body)).toBe(200);
  expect(bob.body.success).toBe(true);
  const token = (bob.body.data as { token?: unknown } | undefined)?.token;
  expect(typeof token === "string" && token.length > 0, JSON.stringify(bob.body)).toBe(true);
  // A human role with no report gets the ordinary refusal: the sentence the AI role would get without the guard.
  const human = await issue("delivery_lead");
  expect(human.status, JSON.stringify(human.body)).toBe(409);
  expect(human.body.error?.message).toBe(NO_REPORT);
});

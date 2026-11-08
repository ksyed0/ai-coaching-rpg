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
// with the review seeded for the two seated humans (`seedDraft` with roles: Delivery lead released, Account manager a draft; the mock
// models cannot score the e2e session, so the fixture's alice and bob are renamed to those seats, BUG-0028), the console's issue route
// refuses the AI role with the exact guard sentence. The guard sits after the review check and before the has-a-report check: without it
// the AI role would get NO_REPORT (commenting the guard out makes this spec fail on exactly that sentence). The seated Account manager's link is minted
// in the same session, so the refusal is AI-specific, not a broken review. No failure message prints a token (`shown` redacts it), so
// a regressed guard cannot leak a live link into the CI log. What it does not prove: the "AI player" label on
// the link row. That row exists only for an AI role with a stale live credential, which cannot be produced end to end (the guard stops
// it); the Task 3 control tests and Task 4 component tests cover it. Every wait is on an effect; no fixed sleep.

// No trace for this file: a regressed guard would issue a real token, and a retained trace (uploaded by CI on failure) records bodies.
test.use({ trace: "off" });

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

/** A failure message for an answer: its status and body with any issued token replaced (an issued link is a live credential). */
function shown(a: { status: number; body: Answer }): string {
  const data = a.body.data;
  const safe = data !== null && typeof data === "object" && "token" in data ? { ...a.body, data: { ...data, token: "[redacted]" } } : a.body;
  return JSON.stringify({ status: a.status, body: safe });
}

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

  await seedDraft(s, sessionId, { released: "delivery_lead", draft: "account_manager" });

  // The console's own issue route, as the panel posts it (same-origin, with the BFF's write header). No shared e2e helper exports these
  // headers (console-flow and ai-players keep their own local copies), so they are literals here too.
  const linksUrl = `${s.baseUrl}/api/v1/console/sessions/${encodeURIComponent(sessionId)}/report-links`;
  const headers = { Origin: s.baseUrl, "X-Requested-With": "scenecoach" };
  const issue = async (role: string) => {
    const r = await fac.context().request.post(linksUrl, { headers, data: { role } });
    return { status: r.status(), body: (await r.json()) as Answer };
  };

  // The seed's subjects are exactly the two seated humans. (This does not prove the AI seat cannot be a subject: control's list drops an
  // AI role without a live credential anyway.)
  const list = await fac.context().request.get(linksUrl, { headers });
  expect(list.status()).toBe(200);
  const listed = ((await list.json()) as { data: { roles: { role: string }[] } }).data.roles.map((r) => r.role);
  expect(listed).toEqual(["account_manager", "delivery_lead"]);

  const ai = await issue("tech_lead");
  expect(ai.status, shown(ai)).toBe(409);
  expect(ai.body.success, shown(ai)).toBe(false);
  expect(ai.body.error?.message, shown(ai)).toBe(AI_LINK_REFUSED);
  // A seated human with a report in the same review IS issued a link: the review and the route work, so the refusal above is AI-specific.
  const human = await issue("account_manager");
  expect(human.status, shown(human)).toBe(200);
  expect(human.body.success, shown(human)).toBe(true);
  const token = (human.body.data as { token?: unknown } | undefined)?.token;
  expect(typeof token === "string" && token.length > 0, shown(human)).toBe(true);
  // A role with no report gets the ordinary refusal: the sentence the AI role would get without the guard. `alice` is the fixture's
  // name, renamed away by the seed, so it is in no report (and its absence shows the rename took).
  const none = await issue("alice");
  expect(none.status, shown(none)).toBe(409);
  expect(none.body.error?.message, shown(none)).toBe(NO_REPORT);
});

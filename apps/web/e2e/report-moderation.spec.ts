import { readdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { BOB, endedSession, seedDraft } from "./helpers/reports";
import { startLauncherStack, type LauncherStack } from "./helpers/start-launcher-stack";

// US-0064 part A: the facilitator's Report panel against the real control service (mock models, temp data dir) and `next start` in
// launcher mode.
//
// The review test does NOT run evaluate. The e2e's ended session has players who never speak, so the real `evaluate` (scripted mock
// evaluator) scores nothing there (Task 1 finding, spec section 11): every role is `insufficient_evidence`. The draft is SEEDED with
// `seedDraft` instead (the runtime's own evaluate-and-moderate functions in a child process: one opened review, alice released, bob a
// draft); the evaluate job keeps its unit and service coverage (services/control report-job and moderation tests).
//
// The double-click test DOES run the real evaluate child (MODEL_PROVIDER=mock): it makes no model call on this log and exits quickly,
// which is all a one-job check needs. It proves the repeat guard end to end; it does not prove scoring.
//
// Every wait is on an effect; no fixed sleep and no assertion on elapsed time.

let stack: LauncherStack | null = null;
const opened: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of opened.splice(0)) await c.close().catch(() => undefined);
  await stack?.stop();
  stack = null;
});

const AUTHOR = "priya";
const STALE = "Someone changed this. Reload the level and try again.";

/** The console page of `sessionId` in a new tab of the facilitator's context, with the author name typed. */
async function consoleTab(fac: Page, sessionId: string): Promise<Page> {
  const page = await fac.context().newPage();
  await page.goto(`${stack!.baseUrl}/console/${sessionId}`);
  await typeName(page);
  return page;
}
async function typeName(page: Page): Promise<void> {
  await page.getByLabel("Your name for the review record").fill(AUTHOR);
}
const panel = (page: Page) => page.getByRole("region", { name: "Report", exact: true });
/** Opens bob's subject view from the subject list and waits for its criteria. */
async function reviewBob(page: Page): Promise<void> {
  await panel(page).getByRole("button", { name: `Review ${BOB}` }).click();
  await expect(page.locator(".report-subject").getByRole("heading", { name: BOB, level: 3 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit Discovery" })).toBeEnabled();
}
const discovery = (page: Page) => page.locator("li.report-criterion").filter({ has: page.getByRole("heading", { name: "Discovery", level: 4 }) });

test("review in the browser: the seeded draft opens with the run summary and subjects; edit, a stale second tab keeps its text, accept, comment", async ({ browser }) => {
  test.setTimeout(300_000);
  stack = await startLauncherStack();
  const { fac, sessionId } = await endedSession(browser, stack);
  opened.push(fac.context());

  // Before any draft: the panel offers Evaluate (the stage is not_evaluated).
  await typeName(fac);
  await expect(panel(fac).getByText("Evaluate this session to draft a report for each player and the group.")).toBeVisible();
  await expect(panel(fac).getByRole("button", { name: "Evaluate…" })).toBeEnabled();

  // The seed opens the review, so the real state is in_review (not ready_to_open).
  await seedDraft(stack, sessionId);
  const a = await consoleTab(fac, sessionId);
  await expect(panel(a).getByText("The reports are drafted and the review is open.")).toBeVisible();
  await expect(panel(a).getByRole("button", { name: "Evaluate…" })).toHaveCount(0);
  const summary = panel(a).getByRole("region", { name: "How the run went" });
  await expect(summary.getByText(/^Scenes ended by the Game Master: \d+$/)).toBeVisible();
  await expect(summary.getByText(/^Fallback replies: \d+ of \d+ character replies$/)).toBeVisible();
  for (const label of ["Alice", "Bob", "Group"]) await expect(panel(a).getByRole("button", { name: `Review ${label}` })).toBeVisible();
  const aliceRow = panel(a).locator(".code-row").filter({ hasText: "Alice" });
  await expect(aliceRow.getByText("Released", { exact: true })).toBeVisible();
  const bobRow = panel(a).locator(".code-row").filter({ hasText: "Bob" });
  await expect(bobRow.getByText("Draft", { exact: true })).toBeVisible();

  // Two tabs show bob's view; B opens its edit form (it expects level 2) and types, then A saves level 3 first.
  const b = await consoleTab(fac, sessionId);
  await reviewBob(a);
  await reviewBob(b);
  await expect(discovery(a).getByText("Level 2", { exact: true })).toBeVisible();
  await discovery(b).getByRole("button", { name: "Edit Discovery" }).click();
  await discovery(b).getByLabel("New level").selectOption("4");
  await discovery(b).getByLabel("Reason (required; shown to the participant)").fill("Tab B reason: heard it in both scenes.");
  await discovery(b).getByLabel("Rationale (optional)").fill("Tab B rationale.");
  await b.getByLabel("Comment").fill("Tab B comment that must survive.");

  await discovery(a).getByRole("button", { name: "Edit Discovery" }).click();
  await discovery(a).getByLabel("New level").selectOption("3");
  await discovery(a).getByLabel("Reason (required; shown to the participant)").fill("Asked two open questions about the need.");
  await discovery(a).getByRole("button", { name: "Save" }).click();
  await expect(a.locator(".report-subject").getByText("Saved.", { exact: true })).toBeVisible();
  await expect(discovery(a).getByText("Level 3", { exact: true })).toBeVisible();
  await expect(discovery(a).getByText("Edited", { exact: true })).toBeVisible();

  // B's save names level 2, which is no longer shown: refused as stale, and nothing B typed is lost.
  await discovery(b).getByRole("button", { name: "Save" }).click();
  await expect(discovery(b).getByText(STALE, { exact: true })).toBeVisible();
  await expect(discovery(b).getByLabel("Reason (required; shown to the participant)")).toHaveValue("Tab B reason: heard it in both scenes.");
  await expect(discovery(b).getByLabel("Rationale (optional)")).toHaveValue("Tab B rationale.");
  await expect(discovery(b).getByLabel("New level")).toHaveValue("4");
  await expect(b.getByLabel("Comment")).toHaveValue("Tab B comment that must survive.");
  // Reloading the levels shows A's level and keeps the open form, which now replaces level 3.
  await b.getByRole("button", { name: "Reload the levels" }).click();
  await expect(discovery(b).getByText("Now level 3: your save replaces it.")).toBeVisible();
  await expect(discovery(b).getByLabel("Reason (required; shown to the participant)")).toHaveValue("Tab B reason: heard it in both scenes.");

  // Accept: the edit made bob's summary stale (one open item); A accepts it and the item closes.
  await expect(bobRow.getByText("1 open item", { exact: true })).toBeVisible();
  await a.getByRole("button", { name: "Accept the summary" }).click();
  await expect(bobRow.getByText("No open items", { exact: true })).toBeVisible();

  // Comment: shown as text in bob's view.
  await a.getByLabel("Comment").fill("Good discovery; <b>keep</b> it up.");
  await a.getByRole("button", { name: "Add comment" }).click();
  const comments = a.locator(".report-subject").getByRole("heading", { name: "Comments", level: 4 }).locator("..");
  await expect(comments.getByText("Good discovery; <b>keep</b> it up.", { exact: true })).toBeVisible();
  await expect(comments.getByText(/^Internal: $/)).toBeVisible();
  await expect(a.getByLabel("Comment")).toHaveValue("");
});

test("two tabs click Evaluate at once: one job runs, the other is refused, and a later evaluate is already_evaluated", async ({ browser }) => {
  test.setTimeout(300_000);
  stack = await startLauncherStack();
  const { fac, sessionId } = await endedSession(browser, stack);
  opened.push(fac.context());
  const a = await consoleTab(fac, sessionId);
  const b = await consoleTab(fac, sessionId);

  // Both tabs open the confirmation (3 human players + the group rubric: up to 8 calls), then both confirm together.
  for (const p of [a, b]) {
    await panel(p).getByRole("button", { name: "Evaluate…" }).click();
    await expect(p.getByRole("dialog")).toContainText("makes up to 8 model calls");
  }
  await Promise.all([a, b].map((p) => p.getByRole("dialog").getByRole("button", { name: "Evaluate", exact: true }).click()));
  const said = await Promise.all(
    [a, b].map(async (p) => {
      const status = panel(p).getByRole("status");
      await expect(status).toHaveText(/./);
      return (await status.textContent())?.trim() ?? "";
    }),
  );
  expect(said.filter((t) => t === "The evaluation has started.")).toHaveLength(1);
  const refusal = said.find((t) => t !== "The evaluation has started.");
  expect(["An evaluation is already running for this session.", "This session already has a report draft."]).toContain(refusal);

  // The one run finishes and control opens the review with the typed name (the panel polls while evaluating).
  await expect(panel(a).getByText(/^The reports are drafted and the review is open\./)).toBeVisible({ timeout: 120_000 });
  const folders = (await readdir(path.join(stack.dataDir, "reports"), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  expect(folders).toEqual([sessionId]);

  // Another evaluate now (the browser's own same-origin request, as the panel would send it) is refused: already_evaluated.
  const again = await a.evaluate(async (id) => {
    const r = await fetch(`/api/v1/console/sessions/${encodeURIComponent(id)}/report/evaluate`, {
      method: "POST",
      // The panel's own headers (lib/api.ts postJson): the BFF refuses a write without X-Requested-With.
      headers: { "Content-Type": "application/json", "X-Requested-With": "scenecoach" },
      body: JSON.stringify({ confirmedCalls: 8, by: "priya" }),
    });
    const body = (await r.json()) as { error?: { code?: string } | null };
    return { status: r.status, code: body.error?.code ?? null };
  }, sessionId);
  expect(again).toEqual({ status: 409, code: "already_evaluated" });
  expect((await readdir(path.join(stack.dataDir, "reports"), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)).toEqual([sessionId]);
});

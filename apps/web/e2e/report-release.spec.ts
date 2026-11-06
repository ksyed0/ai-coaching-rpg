import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { BOB, dismiss, endedSession, exportWithTerminal, issueLink, seedDraft } from "./helpers/reports";
import { startLauncherStack, type LauncherStack } from "./helpers/start-launcher-stack";

// US-0064 part B: release, the participant's read with the runtime gone, a dispute resolved in the console, amend and re-release,
// withdraw, and export, against the real control service (mock models, temp data dir) and `next start` in launcher mode.
//
// The draft is SEEDED with `seedDraft`, as in report-moderation.spec.ts: the e2e's players never speak, so the real `evaluate` scores
// nothing on this log (Task 1 finding, spec section 11). The seed is the runtime's own evaluate-and-moderate functions run in a child
// process (one opened review, every item accepted, alice released, bob and the group drafts). So this test does not prove scoring; the
// evaluate job keeps its unit and service coverage.
//
// Every wait is on an effect; no fixed sleep and no assertion on elapsed time.

let stack: LauncherStack | null = null;
const opened: BrowserContext[] = [];
const temps: string[] = [];
test.afterEach(async () => {
  for (const c of opened.splice(0)) await c.close().catch(() => undefined);
  for (const t of temps.splice(0)) await rm(t, { recursive: true, force: true }).catch(() => undefined);
  await stack?.stop();
  stack = null;
});

const AUTHOR = "priya";
const BLOCKED = "Some reports still have open items. Resolve them, then try again.";
const DISPUTE = "I asked three open questions, so I disagree with this level.";
const RESOLVE = "Reason-Console-Heron: the evidence supports the level.";
/** Alice's column of the group report's coverage table: her individual results, which only the facilitator sees. */
const ALICE_COLUMN = "| `alice` |";

const panel = (page: Page) => page.getByRole("region", { name: "Report", exact: true });
const row = (page: Page, label: string) => panel(page).locator(".code-row").filter({ has: page.locator(".code-role", { hasText: new RegExp(`^${label}$`) }) });
const criterion = (page: Page, name: string) =>
  page.locator(".report-subject li.report-criterion").filter({ has: page.getByRole("heading", { name, level: 4 }) });

/** The console page of `sessionId` in a new tab of the facilitator's context, with the author name typed. */
async function consoleTab(fac: Page, sessionId: string): Promise<Page> {
  const page = await fac.context().newPage();
  await page.goto(`${stack!.baseUrl}/console/${sessionId}`);
  await page.getByLabel("Your name for the review record").fill(AUTHOR);
  await expect(panel(page).getByText("The reports are drafted and the review is open.")).toBeVisible();
  return page;
}
async function review(page: Page, label: string, firstCriterion: string): Promise<void> {
  await panel(page).getByRole("button", { name: `Review ${label}` }).click();
  await expect(page.locator(".report-subject").getByRole("heading", { name: label, level: 3 })).toBeVisible();
  await expect(criterion(page, firstCriterion)).toBeVisible();
}
async function editLevel(page: Page, name: string, level: string, reason: string): Promise<void> {
  const c = criterion(page, name);
  await c.getByRole("button", { name: `Edit ${name}` }).click();
  await c.getByLabel("New level").selectOption(level);
  await c.getByLabel("Reason (required)").fill(reason);
  await c.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".report-subject").getByText("Saved.", { exact: true })).toBeVisible();
  await expect(c.getByText(`Level ${level}`, { exact: true })).toBeVisible();
}

type Line = { type: string; subject?: string; destination?: string };
async function reviewLines(dataDir: string, sessionId: string): Promise<Line[]> {
  const text = await readFile(path.join(dataDir, "reports", sessionId, "review.jsonl"), "utf8");
  return text.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Line);
}
const ofType = (lines: Line[], type: string) => lines.filter((l) => l.type === type);
/** Every file under the reports folder, relative, sorted. */
async function reportFiles(dataDir: string): Promise<string[]> {
  const root = path.join(dataDir, "reports");
  const out: string[] = [];
  for (const e of await readdir(root, { recursive: true, withFileTypes: true })) if (e.isFile()) out.push(path.relative(root, path.join(e.parentPath, e.name)));
  return out.sort();
}
/** A same-origin POST from the page, with the panel's own headers (the BFF refuses a write without X-Requested-With). */
function post(page: Page, url: string, body: unknown): Promise<{ status: number; code: string | null }> {
  return page.evaluate(async ([u, b]) => {
    const r = await fetch(u as string, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "scenecoach" }, body: JSON.stringify(b) });
    const j = (await r.json().catch(() => null)) as { error?: { code?: string } | null } | null;
    return { status: r.status, code: j?.error?.code ?? null };
  }, [url, body] as const);
}
/** Clicks Download in the export menu and returns the saved file's name and text. */
async function download(page: Page): Promise<{ name: string; text: string }> {
  const waiting = page.waitForEvent("download");
  await panel(page).getByRole("region", { name: "Export" }).getByRole("button", { name: "Download" }).click();
  const d = await waiting;
  return { name: d.suggestedFilename(), text: await readFile((await d.path())!, "utf8") };
}
async function participantPage(browser: Browser, link: string): Promise<Page> {
  const c = await browser.newContext({ extraHTTPHeaders: { "X-Forwarded-For": "127.0.0.1" }, viewport: { width: 1200, height: 860 } });
  opened.push(c);
  const page = await c.newPage();
  await page.goto(link);
  await page.waitForURL("**/report");
  await expect(page.getByRole("heading", { name: "Your report" })).toBeVisible();
  return page;
}

test("release in the browser, the participant reads it with the runtime gone, a dispute is resolved, amend and re-release, withdraw, export", async ({ browser }) => {
  test.setTimeout(420_000);
  stack = await startLauncherStack();
  let runningBefore = 0;
  const { fac, sessionId } = await endedSession(browser, stack, 1280, async () => {
    runningBefore = await stack!.runtimeCount();
  });
  opened.push(fac.context());
  // A positive control for the "runtime has exited" check below: the count finds the live runtime while the session runs.
  expect(runningBefore).toBe(1);
  await seedDraft(stack, sessionId);
  const a = await consoleTab(fac, sessionId);
  const b = await consoleTab(fac, sessionId);

  // The release bar: alice is released already (her row has Amend, Withdraw and Export); bob and the group can be ticked.
  await expect(row(a, "Alice").getByText("Released", { exact: true })).toBeVisible();
  for (const name of ["Amend Alice", "Withdraw Alice", "Export Alice"]) await expect(panel(a).getByRole("button", { name })).toBeEnabled();
  const bar = panel(a).getByRole("region", { name: "Release" });
  await expect(bar.getByRole("checkbox", { name: "Bob" })).toBeEnabled();
  await expect(bar.getByRole("checkbox", { name: "Group" })).toBeEnabled();
  await expect(bar.getByRole("checkbox", { name: "Alice" })).toHaveCount(0);

  // A blocked release: A opens the dialog for bob while nothing blocks; B's edit then makes bob's summary stale; A's confirm is refused
  // with the fixed sentence and the subject the server named, and nothing is released.
  await bar.getByRole("checkbox", { name: "Bob" }).check();
  await bar.getByRole("button", { name: "Release selected…" }).click();
  const dialog = a.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Release these reports?" })).toBeVisible();
  await expect(dialog.getByText("Bob", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Bob (the participant this report is about)", { exact: true })).toBeVisible();
  await expect(dialog.getByText("The facilitator", { exact: true })).toBeVisible();
  await expect(dialog.getByText(`Recorded as: ${AUTHOR}`)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Release", exact: true })).toBeEnabled();

  await review(b, BOB, "Discovery");
  await editLevel(b, "Discovery", "3", "Asked two open questions about the need.");
  const releasedBefore = ofType(await reviewLines(stack.dataDir, sessionId), "report.released").length;
  await dialog.getByRole("button", { name: "Release", exact: true }).click();
  await expect(dialog.getByText(BLOCKED, { exact: true })).toBeVisible();
  await expect(dialog.getByText("Blocked: Bob", { exact: true })).toBeVisible();
  // the dialog reloads what blocks it, and its confirm is now disabled
  await expect(dialog.getByText("Accept or edit the summary", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Release", exact: true })).toBeDisabled();
  expect(ofType(await reviewLines(stack.dataDir, sessionId), "report.released")).toHaveLength(releasedBefore);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(a, "Bob").getByText("Draft", { exact: true })).toBeVisible();
  await expect(bar.getByText("Not ready: Accept or edit the summary")).toBeVisible();

  // The server refuses an `all` flag and an empty list (AC-0375): 400, nothing released.
  const releaseUrl = `/api/v1/console/sessions/${encodeURIComponent(sessionId)}/report/release`;
  expect((await post(a, releaseUrl, { all: true, by: AUTHOR })).status).toBe(400);
  expect((await post(a, releaseUrl, { subjects: [], by: AUTHOR })).status).toBe(400);
  expect(ofType(await reviewLines(stack.dataDir, sessionId), "report.released")).toHaveLength(releasedBefore);

  // Resolve every open item for bob and the group: accept bob's stale summary. The group's draft has no summary lines to go stale and
  // the seed accepted its criterion, so its edit leaves it with no open item: it is releasable as it stands.
  await review(a, BOB, "Discovery");
  await a.getByRole("button", { name: "Accept the summary" }).click();
  await expect(row(a, "Bob").getByText("No open items", { exact: true })).toBeVisible();
  await review(a, "Group", "Shared understanding");
  await editLevel(a, "Shared understanding", "4", "They agreed the plan together.");
  await expect(row(a, "Group").getByText("No open items", { exact: true })).toBeVisible();

  // Release everything: the dialog names each subject with its audience from the policy; then both are released.
  await bar.getByRole("button", { name: "Release everything…" }).click();
  await expect(dialog.getByText("Bob", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Group", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Bob (the participant this report is about)", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Every participant, with the other participants' individual results removed", { exact: true })).toBeVisible();
  await expect(dialog.getByText("The facilitator", { exact: true })).toHaveCount(2);
  await dialog.getByRole("button", { name: "Release", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel(a).getByRole("status")).toHaveText("Released: Bob, Group.");
  await expect(row(a, "Bob").getByText("Released", { exact: true })).toBeVisible();
  await expect(row(a, "Group").getByText("Released", { exact: true })).toBeVisible();
  await expect(panel(a).getByRole("region", { name: "Release" })).toHaveCount(0); // nothing left to release

  // The runtime has exited (control stops it after the end grace): only then is the participant's link issued and read (AC-0340).
  await expect.poll(() => stack!.runtimeCount(), { timeout: 60_000 }).toBe(0);
  await fac.reload();
  await expect(fac.getByRole("heading", { name: "Participant reports" })).toBeVisible();
  const link = await issueLink(fac, BOB);
  await dismiss(fac);
  const participant = await participantPage(browser, link);
  await expect(participant.locator("pre.report-text").first()).not.toBeEmpty();
  const groupSection = participant.getByRole("region", { name: "Group report" });
  await expect(groupSection).toBeVisible();
  // The group report as bob holds no peer's individual results; the facilitator's export of the same group does (the positive control).
  expect(await groupSection.locator("pre.report-text").innerText()).not.toContain(ALICE_COLUMN);
  const menu = panel(a).getByRole("region", { name: "Export" });
  await menu.getByLabel("Report to export").selectOption({ label: "Group" });
  const facGroup = await download(a);
  expect(facGroup.name).toBe("report-group.md");
  expect(facGroup.text).toContain(ALICE_COLUMN);
  const discoveryBefore = await participant.getByRole("table").getByRole("row", { name: /Discovery/ }).getByRole("cell").first().innerText();

  // The participant disputes a criterion on their page (2c-2); the facilitator resolves it in the console; the reason reaches them.
  const respond = participant.getByRole("form", { name: "Send a response" });
  await respond.getByLabel("About").selectOption({ label: "Listening" });
  await respond.getByLabel("Your response").fill(DISPUTE);
  await respond.getByRole("checkbox", { name: "I disagree with this" }).check();
  await respond.getByRole("button", { name: "Send", exact: true }).click();
  await expect(participant.getByText("1 of 50 used")).toBeVisible();

  await review(a, BOB, "Discovery");
  await a.locator(".report-subject").getByRole("button", { name: "Reload the levels" }).click();
  const disputes = a.locator(".report-disputes");
  await expect(disputes.getByText(DISPUTE, { exact: true })).toBeVisible();
  await expect(disputes.getByText("About Listening")).toBeVisible();
  // not amended since the dispute: Amended is not offered
  await expect(disputes.getByLabel("Outcome").locator("option")).toHaveText(["Choose an outcome", "Upheld", "Declined"]);
  await disputes.getByLabel("Outcome").selectOption("upheld");
  await disputes.getByLabel("Reason shown to the participant (required)").fill(RESOLVE);
  await disputes.getByRole("button", { name: "Resolve" }).click();
  await expect(a.locator(".report-disputes")).toHaveCount(0);
  await participant.reload();
  const answers = participant.getByRole("region", { name: "Your responses" });
  await expect(answers.getByText("Outcome: upheld")).toBeVisible();
  await expect(answers.getByText(`Facilitator's reason: ${RESOLVE}`)).toBeVisible();

  // Amend bob: the dialog names the subject and its audience and needs a reason; the participant keeps the released version meanwhile.
  await panel(a).getByRole("button", { name: "Amend Bob" }).click();
  await expect(dialog.getByRole("heading", { name: "Amend the Bob report?" })).toBeVisible();
  await expect(dialog.getByText("Bob (the participant this report is about)", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Amend", exact: true })).toBeDisabled();
  await dialog.getByLabel("Reason for the amendment (required)").fill("The dispute showed the discovery level was low.");
  await dialog.getByRole("button", { name: "Amend", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel(a).getByRole("status")).toHaveText("The report is open for amendment. Change it, then release it again.");
  await expect(row(a, "Bob").getByText("Amending", { exact: true })).toBeVisible();
  await participant.reload();
  await expect(participant.getByRole("heading", { name: "Your report" })).toBeVisible();

  // Change the level, accept the summary, release again from the row.
  await a.locator(".report-subject").getByRole("button", { name: "Reload the levels" }).click();
  await editLevel(a, "Discovery", "4", "Amended after the dispute.");
  await a.getByRole("button", { name: "Accept the summary" }).click();
  await expect(row(a, "Bob").getByText("No open items", { exact: true })).toBeVisible();
  await panel(a).getByRole("button", { name: "Release Bob" }).click();
  await expect(dialog.getByText("Bob (the participant this report is about)", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Release", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel(a).getByRole("status")).toHaveText("Released: Bob.");
  await expect(row(a, "Bob").getByText("Released", { exact: true })).toBeVisible();
  await participant.reload();
  await expect(participant.getByRole("heading", { name: "Your report" })).toBeVisible();
  await expect(participant.getByRole("table").getByRole("row", { name: /Discovery/ }).getByRole("cell").first()).not.toHaveText(discoveryBefore);

  // Withdraw the group: the dialog says it cannot be undone, names the subject and who loses it, and needs a reason.
  await panel(a).getByRole("button", { name: "Withdraw Group" }).click();
  await expect(dialog.getByRole("heading", { name: "Withdraw the Group report?" })).toBeVisible();
  await expect(dialog.getByText("Withdrawing cannot be undone.")).toBeVisible();
  await expect(dialog.getByText("It is no longer shown to:")).toBeVisible();
  await expect(dialog.getByText("Every participant, with the other participants' individual results removed", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Withdraw", exact: true })).toBeDisabled();
  await dialog.getByLabel("Reason for withdrawing (required)").fill("The group report named the wrong scenario.");
  await dialog.getByRole("button", { name: "Withdraw", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel(a).getByRole("status")).toHaveText("The report was withdrawn.");
  await expect(row(a, "Group").getByText("Withdrawn", { exact: true })).toBeVisible();
  await participant.reload();
  await expect(participant.getByRole("heading", { name: "Your report" })).toBeVisible();
  await expect(participant.getByRole("region", { name: "Group report" })).toHaveCount(0);

  // Export bob twice from the row's Export: each download is the terminal's facilitator Markdown of bob, each records one
  // `console-download` event, and nothing is written under the reports folder.
  const consoleExports = async () =>
    ofType(await reviewLines(stack!.dataDir, sessionId), "report.exported").filter((l) => l.destination === "console-download" && l.subject === "bob").length;
  const filesBefore = await reportFiles(stack.dataDir);
  await panel(a).getByRole("button", { name: "Export Bob" }).click();
  await expect(menu.getByLabel("Report to export")).toHaveValue("bob");
  await expect(menu.getByLabel("View")).toHaveValue("facilitator");
  const first = await download(a);
  expect(first.name).toBe("report-bob.md");
  await expect(menu.getByText("Downloaded report-bob.md.")).toBeVisible();
  expect(await consoleExports()).toBe(1);
  const second = await download(a);
  expect(await consoleExports()).toBe(2);
  expect(await reportFiles(stack.dataDir)).toEqual(filesBefore);
  const dest = path.join(await mkdtemp(path.join(os.tmpdir(), "acr-export-oracle-")), "out");
  temps.push(path.dirname(dest));
  await exportWithTerminal(stack, sessionId, BOB.toLowerCase(), dest);
  const oracle = await readFile(path.join(dest, "bob.md"), "utf8");
  expect(first.text).toBe(oracle);
  expect(second.text).toBe(oracle);
});

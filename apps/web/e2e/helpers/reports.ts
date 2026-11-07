import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { expect, type Browser, type Page } from "@playwright/test";
import { createSession, facilitator } from "./console";
import { PLAYERS, seatLauncher, type Player } from "./players";
import { REPO_ROOT } from "./start-stack";
import type { LauncherStack } from "./start-launcher-stack";

// Shared steps of the report-access specs: an ended session, a released review (and a re-run) on disk, and the console panel's controls.

const NAMES: Record<Player, string> = { delivery_lead: "Dana Lead", tech_lead: "Tomás Tech", account_manager: "Ama Accounts" };
const TSX = path.join(REPO_ROOT, "services", "runtime", "node_modules", ".bin", "tsx");
const SEED = path.join(REPO_ROOT, "services", "runtime", "src", "__tests__", "seed-report-folders.ts");

/** The text only the live re-run (`<id>-2`) of bob's report holds; the superseded first run says "Clear on effort." instead. */
export const RERUN_TEXT = "Clear on effort and on the re-run.";
export const OLD_RUN_TEXT = "Clear on effort.";
/** The panel and the pages name roles by their id as words (alice, bob are the evaluator fixture's players). */
export const BOB = "Bob";
export const REFUSED = "This link no longer works. Ask your facilitator for a new one.";

/**
 * Writes a superseded first run and a live, released re-run for `sessionId` under the stack's reports folder, with the runtime's own
 * moderate functions (a child process: the web app and its specs never import the runtime). Not a real evaluate of the e2e session,
 * which the mock models cannot score; the review folders are the same shape an operator's `evaluate` + `moderate` leave.
 */
export function seedReports(stack: LauncherStack, sessionId: string): Promise<void> {
  return runSeeder(stack, sessionId, []);
}

/** What the draft seed puts in bob's evaluator draft (same strings as seed-report-folders.ts): they must never reach a draft player's page. */
export const CANARY_LEVEL = "Canary-Level-Zebra";
export const CANARY_RATIONALE = "Canary-Rationale-Quokka";
/** The facilitator's reason the e2e gives the `resolve` step (it is shown to the participant). */
export const RESOLVE_REASON = "Reason-Canary-Walrus: the evidence supports the original level.";

/**
 * One live review: alice released, bob still a draft, with recognisable evaluator strings in bob's draft. With `roles` (BUG-0028) the
 * fixture's alice and bob are renamed to the session's real seated humans `roles.released` and `roles.draft`, so a link can be issued
 * to a seat; a role named in neither (an AI seat) is not a subject of the seed.
 */
export function seedDraft(stack: LauncherStack, sessionId: string, roles?: { released: Player; draft: Player }): Promise<void> {
  return runSeeder(stack, sessionId, roles === undefined ? ["draft"] : ["draft", roles.released, roles.draft]);
}
/** The facilitator releases one player's report (the runtime's own moderate function, run in a child process). */
export function releaseRole(stack: LauncherStack, sessionId: string, role = "bob"): Promise<void> {
  return runSeeder(stack, sessionId, ["release", role]);
}
/** The facilitator resolves the player's open dispute as `outcome`, with `reason` shown to the participant. */
export function resolveDispute(stack: LauncherStack, sessionId: string, outcome: "upheld" | "declined", reason: string, role = "bob"): Promise<void> {
  return runSeeder(stack, sessionId, ["resolve", role, outcome, reason]);
}

/**
 * The terminal's own facilitator export of `subject` (`pnpm moderate export <dir> <subject> --for facilitator --to <dest>`, in a child
 * process): the oracle the console's download is compared with. It records its own `report.exported` event (destination `dest`'s name).
 */
export function exportWithTerminal(stack: LauncherStack, sessionId: string, subject: string, dest: string): Promise<void> {
  return runSeeder(stack, sessionId, ["export", subject, dest]);
}

function runSeeder(stack: LauncherStack, sessionId: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(TSX, [SEED, path.join(stack.dataDir, "reports"), sessionId, ...args], {
      cwd: path.join(REPO_ROOT, "services", "runtime"),
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NO_COLOR: "1" } as unknown as NodeJS.ProcessEnv,
    });
    let out = "";
    child.stdout!.on("data", (d) => (out += String(d)));
    child.stderr!.on("data", (d) => (out += String(d)));
    child.once("error", reject);
    child.once("exit", (code) => ((code as number | null) === 0 ? resolve() : reject(new Error(`seeding the reports failed (${code}): ${out.slice(-600)}`))));
  });
}

/** A session that has been started by three joined players and ended by the facilitator (the console page is open on it). */
export async function endedSession(
  browser: Browser, stack: LauncherStack, width = 1280, whileRunning?: () => Promise<void>,
): Promise<{ fac: Page; sessionId: string }> {
  const fac = await facilitator(browser, stack.baseUrl, stack.facilitatorSecret, width);
  const { sessionId, codes } = await createSession(fac, stack.baseUrl);
  const seated = [];
  for (const role of PLAYERS) seated.push(await seatLauncher(browser, stack.baseUrl, sessionId, role, codes[role], NAMES[role]));
  await fac.goto(`${stack.baseUrl}/console/${sessionId}`);
  await expect(fac.getByRole("button", { name: "Start", exact: true })).toBeEnabled({ timeout: 60_000 });
  await fac.getByRole("button", { name: "Start", exact: true }).click();
  const controls = fac.getByRole("region", { name: "Facilitator controls" });
  await expect(controls.getByRole("button", { name: /^(Pause|Resume)$/ })).toBeEnabled();
  await whileRunning?.();
  await controls.getByRole("button", { name: "End session", exact: true }).click();
  const dialog = fac.getByRole("dialog");
  await dialog.getByRole("button", { name: "End session", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(fac.getByText("The session has ended.", { exact: true })).toHaveCount(1);
  for (const s of seated) await s.context.close();
  return { fac, sessionId };
}

/** The panel after the session has ended and the reports are on disk: reloads the console page so the panel reads them. */
export async function openPanel(fac: Page, stack: LauncherStack, sessionId: string): Promise<void> {
  await fac.goto(`${stack.baseUrl}/console/${sessionId}`);
  await expect(fac.getByRole("heading", { name: "Participant reports" })).toBeVisible();
  await expect(fac.getByRole("heading", { name: BOB, level: 3 })).toBeVisible();
}

/** Presses `Issue link for <label>` and returns the link shown once (then leaves it shown; use `dismiss` to continue). */
export async function issueLink(fac: Page, label = BOB): Promise<string> {
  await fac.getByRole("button", { name: `Issue link for ${label}` }).click();
  return shownLink(fac, label);
}

async function shownLink(fac: Page, label: string): Promise<string> {
  const input = fac.getByLabel(`Report link for ${label}`);
  await expect(input).toBeVisible();
  const link = await input.inputValue();
  expect(link).toMatch(/\/report\/enter#[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  return link;
}

export async function dismiss(fac: Page): Promise<void> {
  await fac.getByRole("button", { name: "I have copied the link" }).click();
  await expect(fac.getByRole("button", { name: "I have copied the link" })).toHaveCount(0);
}

export async function revoke(fac: Page, label = BOB): Promise<void> {
  await fac.getByRole("button", { name: `Revoke link for ${label}` }).click();
  const dialog = fac.getByRole("dialog");
  await dialog.getByRole("button", { name: "Revoke link", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(fac.getByText(`The link for ${label} was revoked.`)).toBeVisible();
}

export async function reissue(fac: Page, label = BOB): Promise<string> {
  await fac.getByRole("button", { name: `Reissue link for ${label}` }).click();
  const dialog = fac.getByRole("dialog");
  await dialog.getByRole("button", { name: "Reissue link", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  return shownLink(fac, label);
}

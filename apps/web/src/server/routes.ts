import { loadConfig, missingConsoleVars } from "./config";
import { handleConsoleLogin, handleConsoleLogout, handleConsolePassword, resolveConsoleCaller } from "./console-handlers";
import {
  handleConsoleReadiness, handleConsoleReissue, handleConsoleReissueAll, handleConsoleRemove, handleConsoleRestart, handleConsoleScenarios,
  handleConsoleSessionGet, handleConsoleSessionsCreate, handleConsoleSessionsList, handleConsoleStart,
} from "./console-sessions";
import { handleConsoleAiIntents, handleConsoleAiPrompt, handleConsoleAiRoles } from "./console-ai";
import { handleAdminAccountAction, handleAdminAccountCreate, handleAdminAccountsList, handleConsoleSetOwner } from "./console-accounts";
import {
  handleConsoleReportAccept, handleConsoleReportCancel, handleConsoleReportComment, handleConsoleReportEdit, handleConsoleReportEditSummary,
  handleConsoleReportEvaluate, handleConsoleReportOpen, handleConsoleReportOverview, handleConsoleReportSubject,
  handleConsoleReportAmend, handleConsoleReportExport, handleConsoleReportRelease, handleConsoleReportResolve, handleConsoleReportWithdraw,
} from "./console-report-handlers";
import { handleConsoleCommand, handleConsoleFacts } from "./console-command";
import { handleConsoleStream } from "./console-stream";
import {
  handleConsoleReportLinkAction, handleConsoleReportLinks, handleConsoleReportLinksIssue, handleReportEnter, handleReportGet, handleReportRate, handleReportRespond,
} from "./report-handlers";
import { openConsoleCookie } from "./console-session";
import { fail } from "./envelope";
import { FacilitatorBudget } from "./facilitator-budget";
import { handleConsent, handleJoin, handleLeave, handleSay, handleStream, handleVoice, handleVoiceToken, seatedIn, VOICE_TOKEN_THROTTLE, type Deps } from "./handlers";
import { LauncherClient } from "./launcher-client";
import { RuntimeConnection, realTimer } from "./runtime-connection";
import { consoleRecheck, FacilitatorHub } from "./facilitator-hub";
import { StreamHub } from "./stream-hub";
import { JoinThrottle } from "./throttle";

// Wires the handlers to one shared set of dependencies for the Next route files. The stream route and the say route must see the SAME
// hub (say goes over the stream's connection), so the set lives on globalThis: route bundles and dev reloads can load this module twice.

/** The failed-join throttle, matching the runtime's: more than 5 failures in 60 s block that (address, role) for 60 s. */
const JOIN_THROTTLE = { max: 5, windowMs: 60_000, blockMs: 60_000 };

/** Console login failures from ALL addresses together: more than 20 in 10 minutes block every login for 5 minutes. */
const CONSOLE_GLOBAL_THROTTLE = { max: 20, windowMs: 600_000, blockMs: 300_000 };

/** Report reads per address: a rate limit, generous for a person reloading a page (more than 60 in 60 s block that address for 60 s). */
const REPORT_READ_THROTTLE = { max: 60, windowMs: 60_000, blockMs: 60_000 };

/** Participant writes per credential: more than 30 in 60 s block that credential's writes for 60 s. */
const REPORT_WRITE_THROTTLE = { max: 30, windowMs: 60_000, blockMs: 60_000 };

/** The facilitator's evaluate and review writes per console cookie: more than 60 in 60 s block that cookie's writes for 60 s. */
const CONSOLE_REPORT_THROTTLE = { max: 60, windowMs: 60_000, blockMs: 60_000 };

export function createDeps(env: Record<string, string | undefined>): Deps {
  const config = loadConfig(env);
  const now = () => Date.now();
  const missing = missingConsoleVars(config);
  // loadConfig guarantees the token whenever the URL is set.
  const launcher = config.launcherUrl !== undefined && config.launcherToken !== undefined
    ? new LauncherClient({ baseUrl: config.launcherUrl, token: config.launcherToken }) : undefined;
  // Names only, never values. A player-only deployment sets none of them, which is fine, but it is said once, loudly.
  if (missing.length > 0) console.warn(`web: the facilitator console is DISABLED; unset: ${missing.join(", ")}`);
  // US-0083: accounts are the sign-in; the shared secret only serves the legacy sign-in until control closes its latch.
  else if (config.facilitatorSecret === undefined) console.warn("web: FACILITATOR_SECRET is unset: the legacy shared-secret sign-in is off (account sign-in only)");
  return {
    config, now, connect: RuntimeConnection.connect,
    joinThrottle: new JoinThrottle({ ...JOIN_THROTTLE, now }),
    // The console login throttle: the same 5 failures per 60 s and 60 s block, keyed by address.
    consoleThrottle: new JoinThrottle({ ...JOIN_THROTTLE, now }),
    // Without a proxy a client chooses its own X-Forwarded-For, so the per-address bucket above can be dodged by rotating it. This one
    // ignores the address: a wrong secret anywhere is charged here too. The price is that an attacker can lock the facilitator out
    // of LOGIN (never out of a signed-in console) for CONSOLE_GLOBAL_THROTTLE.blockMs at a time.
    consoleGlobalThrottle: new JoinThrottle({ ...CONSOLE_GLOBAL_THROTTLE, now }),
    // US-0083: wrong account passwords per lower-cased login, so rotating addresses cannot dodge it (the join's limits, a table of its own).
    consoleLoginThrottle: new JoinThrottle({ ...JOIN_THROTTLE, now }),
    reportThrottle: new JoinThrottle({ ...REPORT_READ_THROTTLE, now }),
    reportWriteThrottle: new JoinThrottle({ ...REPORT_WRITE_THROTTLE, now }),
    consoleReportThrottle: new JoinThrottle({ ...CONSOLE_REPORT_THROTTLE, now }),
    // Failed report-link tokens: the join's limits, in a table of their own.
    reportEnterThrottle: new JoinThrottle({ ...JOIN_THROTTLE, now }),
    // Report cookies that do not unseal (BUG-0025): the join's limits, in a table of their own, so a flood of forged cookies cannot
    // saturate the enter table, and a valid cookie never consults it.
    reportReadFailThrottle: new JoinThrottle({ ...JOIN_THROTTLE, now }),
    // US-0071: voice token requests per participant (a digest of the cookie's seat), in a table of their own.
    voiceTokenThrottle: new JoinThrottle({ ...VOICE_TOKEN_THROTTLE, now }),
    facilitatorBudget: new FacilitatorBudget(),
    facilitatorHub: new FacilitatorHub({ setTimer: realTimer, now, ...(launcher && { recheck: consoleRecheck(launcher) }) }),
    hub: new StreamHub({ maxStreams: config.maxStreams, maxStreamsPerSession: config.maxStreamsPerSession, maxStreamsPerAddress: config.maxStreamsPerAddress, setTimer: realTimer, now }),
    ...(launcher && { launcher }),
  };
}

const SHARED = Symbol.for("scenecoach.web.deps");
function sharedDeps(): Deps {
  const g = globalThis as { [SHARED]?: Deps };
  // A configuration error throws every time (nothing cached), so fixing the environment and restarting is enough.
  return (g[SHARED] ??= createDeps(process.env));
}

/** For the /join page (server side only): whether this cookie value holds a seat in `sessionId`. False on a configuration error. */
export function hasSeat(token: string | undefined, sessionId: string, getDeps: () => Deps = sharedDeps): boolean {
  try {
    const d = getDeps();
    return seatedIn(token, sessionId, d.config.cookieKeys, d.now());
  } catch {
    return false;
  }
}

/**
 * US-0071 (A1b Task 14): for the /session page (server side only): whether this web server has LiveKit (`config.livekitUrl`, validated).
 * The page gets this boolean and nothing else of the config. False on a configuration error.
 */
export function voiceTransport(getDeps: () => Deps = sharedDeps): boolean {
  try { return getDeps().config.livekitUrl !== undefined; }
  catch { return false; }
}

/**
 * For the sign-in form (server side only): whether the shared-secret sign-in is still offered. Control's latch, read fresh; false when
 * the latch cannot be read or the console is not configured (the disclosure is simply hidden, and the login route still decides).
 */
export async function consoleLegacyAllowed(getDeps: () => Deps = sharedDeps): Promise<boolean> {
  try {
    const d = getDeps();
    if (missingConsoleVars(d.config).length > 0 || !d.launcher) return false;
    return await d.launcher.legacyAllowed();
  } catch {
    return false;
  }
}

/** Where a signed-in account that must change its password is sent (`app/console/password/page.tsx`). */
export const CONSOLE_PASSWORD_PATH = "/console/password";

/**
 * For the /console pages (server side only): the console's state for this cookie value, re-checked against the control service on
 * every render (US-0083: a revoked, reset or password-changed account's cookie is signed out at once). A configuration error reads as
 * disabled; control unreachable is `unavailable` (a page cannot clear a cookie, and the cookie is kept). Never a value from the config.
 */
export type ConsoleView =
  | { kind: "disabled" }
  | { kind: "signed_out" }
  | { kind: "unavailable" }
  | { kind: "signed_in"; name: string; role: "admin" | "facilitator"; mustChange: boolean };
export async function consoleView(token: string | undefined, getDeps: () => Deps = sharedDeps): Promise<ConsoleView> {
  let d: Deps;
  try {
    d = getDeps();
    if (missingConsoleVars(d.config).length > 0) return { kind: "disabled" };
  } catch {
    return { kind: "disabled" };
  }
  const cookie = openConsoleCookie(token, d.config, d.now());
  if (cookie === null) return { kind: "signed_out" };
  const who = await resolveConsoleCaller(cookie, d);
  if (who === "refused") return { kind: "signed_out" };
  if (who === "unavailable") return { kind: "unavailable" };
  return { kind: "signed_in", name: who.name, role: who.role, mustChange: who.mustChange };
}

/** Where a console page must send this view instead of rendering, or null: an account that must change its password goes there first. */
export function consolePageRedirect(view: ConsoleView): string | null {
  return view.kind === "signed_in" && view.mustChange ? CONSOLE_PASSWORD_PATH : null;
}

type Handler = (req: Request, deps: Deps) => Promise<Response>;

/** A route function: a configuration error or an unexpected throw becomes a 500 envelope; only the error's rule or name is logged. */
export function route(handler: Handler, getDeps: () => Deps = sharedDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    let deps: Deps;
    try { deps = getDeps(); }
    catch (err) {
      // loadConfig's message names variables and rules, never a value.
      console.error(`web: ${err instanceof Error ? err.message : "configuration error"}`);
      return fail(500, "internal", "The server is not configured correctly.");
    }
    try { return await handler(req, deps); }
    catch (err) {
      console.error(`web: request failed: ${err instanceof Error ? err.name : "error"}`);
      return fail(500, "internal", "Something went wrong. Try again.");
    }
  };
}

export const joinPOST = route(handleJoin);
export const streamGET = route(handleStream);
export const sayPOST = route(handleSay);
export const consentPOST = route(handleConsent);
export const leavePOST = route(handleLeave);
export const voicePOST = route(handleVoice);
export const voiceTokenPOST = route(handleVoiceToken);
export const consoleLoginPOST = route(handleConsoleLogin);
export const consoleLogoutPOST = route(handleConsoleLogout);
export const consolePasswordPOST = route(handleConsolePassword);
export const consoleScenariosGET = route(handleConsoleScenarios);
export const consoleSessionsGET = route(handleConsoleSessionsList);
export const consoleSessionsPOST = route(handleConsoleSessionsCreate);
export const consoleSessionGET = route(handleConsoleSessionGet);
export const consoleReadinessGET = route(handleConsoleReadiness);
export const consoleStartPOST = route(handleConsoleStart);
export const consoleReissuePOST = route(handleConsoleReissue);
export const consoleReissueAllPOST = route(handleConsoleReissueAll);
export const consoleRemovePOST = route(handleConsoleRemove);
export const consoleRestartPOST = route(handleConsoleRestart);
export const consoleStreamGET = route(handleConsoleStream);
export const consoleSessionOwnerPOST = route(handleConsoleSetOwner);
export const adminAccountsGET = route(handleAdminAccountsList);
export const adminAccountsPOST = route(handleAdminAccountCreate);
export const adminAccountResendPOST = route(handleAdminAccountAction("resend"));
export const adminAccountResetPOST = route(handleAdminAccountAction("reset"));
export const adminAccountRevokePOST = route(handleAdminAccountAction("revoke"));
export const adminAccountReinstatePOST = route(handleAdminAccountAction("reinstate"));
export const consoleCommandPOST = route(handleConsoleCommand);
export const consoleFactsPOST = route(handleConsoleFacts);
export const consoleAiRolesPOST = route(handleConsoleAiRoles);
export const consoleAiIntentsPOST = route(handleConsoleAiIntents);
export const consoleAiPromptPOST = route(handleConsoleAiPrompt);
export const reportEnterPOST = route(handleReportEnter);
export const reportGET = route(handleReportGet);
export const reportRatePUT = route(handleReportRate);
export const reportRespondPOST = route(handleReportRespond);
export const consoleReportLinksGET = route(handleConsoleReportLinks);
export const consoleReportLinksPOST = route(handleConsoleReportLinksIssue);
export const consoleReportLinkActionPOST = route(handleConsoleReportLinkAction);
export const consoleReportGET = route(handleConsoleReportOverview);
export const consoleReportEvaluatePOST = route(handleConsoleReportEvaluate);
export const consoleReportCancelPOST = route(handleConsoleReportCancel);
export const consoleReportOpenPOST = route(handleConsoleReportOpen);
export const consoleReportSubjectGET = route(handleConsoleReportSubject);
export const consoleReportEditPOST = route(handleConsoleReportEdit);
export const consoleReportAcceptPOST = route(handleConsoleReportAccept);
export const consoleReportCommentPOST = route(handleConsoleReportComment);
export const consoleReportEditSummaryPOST = route(handleConsoleReportEditSummary);
export const consoleReportReleasePOST = route(handleConsoleReportRelease);
export const consoleReportResolvePOST = route(handleConsoleReportResolve);
export const consoleReportExportPOST = route(handleConsoleReportExport);
export const consoleReportAmendPOST = route(handleConsoleReportAmend);
export const consoleReportWithdrawPOST = route(handleConsoleReportWithdraw);

import { requireConsole } from "./console-handlers";
import { sessionIdOf } from "./console-sessions";
import { fail } from "./envelope";
import { FacilitatorSocketError, openFacilitatorSocket } from "./facilitator-socket";
import { checkFetchSite } from "./guards";
import type { Deps } from "./handlers";
import { LauncherError } from "./launcher-client";
import { lastSeqOf, sseBody, sseFinal, sseHeaders, type SseOut } from "./sse";

// GET /api/v1/console/sessions/:id/stream: the facilitator's live view of one session as server-sent events. Plain Request -> Response.
// The console cookie is checked on EVERY connect (an EventSource reconnect is a new request), and re-checked with the control service at
// every heartbeat while the stream is open (US-0083, facilitator-hub.ts). The request's X-Forwarded-For is never
// read: the runtime socket carries the reserved console key (facilitator-socket.ts). `event` names written here are constants only.

// The wording is fixed by the plan. It is also what a tab sees when the hub's global cap (MAX_FACILITATOR_STREAMS) is the cause, not only the per-session tab slots.
const BUSY_MESSAGE = "This session is open in too many console tabs. Close one, then reload this page.";

const forbidden = () => fail(403, "forbidden", "This request was refused.");
const notAcceptable = () => fail(406, "not_acceptable", "This address is for the console's live updates.");
const notFound = () => fail(404, "not_found", "That session was not found.");
const unreachable = () => fail(502, "launcher_unavailable", "The session service is not reachable. Try again.");

export async function handleConsoleStream(req: Request, deps: Deps): Promise<Response> {
  if (!checkFetchSite(req)) return forbidden();
  const origin = req.headers.get("Origin");
  if (origin !== null && origin !== deps.config.publicOrigin) return forbidden();
  if (!(req.headers.get("Accept") ?? "").toLowerCase().includes("text/event-stream")) return notAcceptable();
  const who = await requireConsole(req, deps);
  if (who instanceof Response) return who;
  const id = sessionIdOf(req);
  if (id === null) return notFound();
  if (!deps.launcher) return unreachable();

  try {
    const info = await deps.launcher.session(id);
    if (info.status === "ended") return sseFinal("ended");
    if (info.status === "stopped") return sseFinal("stopped");
  } catch (err) {
    if (err instanceof LauncherError && err.reason === "not_found") return notFound();
    return sseFinal("reconnecting");
  }

  // Nobody is listening: take no slot and contact no runtime.
  if (req.signal.aborted) return sseFinal("reconnecting");
  let opened: Awaited<ReturnType<typeof openFacilitatorSocket>>;
  try {
    opened = await openFacilitatorSocket(deps, id, { kind: "live", lastSeq: lastSeqOf(req.headers.get("Last-Event-ID")) });
  } catch (err) {
    if (err instanceof FacilitatorSocketError && err.reason === "busy") return sseFinal("busy", { message: BUSY_MESSAGE });
    return sseFinal("reconnecting");
  }
  const { conn, joined } = opened;
  // Nobody is listening any more.
  if (req.signal.aborted) { conn.close(); return sseFinal("reconnecting"); }
  // The cookie may have expired while the socket was joining (the hub checks again only at its heartbeat).
  if (who.expiresAt <= deps.now()) { conn.close(); return sseFinal("expired"); }

  // From here the connection is ours until the hub takes it: any throw closes it.
  try {
    const body = sseBody();
    let handle: { close(): void } | null = null;
    const stop = () => handle?.close();
    const out: SseOut = {
      write: (chunk) => body.out.write(chunk),
      end: () => { req.signal.removeEventListener("abort", stop); body.out.end(); },
    };
    const hubOpened = deps.facilitatorHub.open({ sessionId: id, expiresAt: who.expiresAt, accountId: who.accountId, epoch: who.epoch, conn, joined, out });
    if (hubOpened === "capacity") return sseFinal("busy", { message: BUSY_MESSAGE }); // the hub closed the connection
    handle = hubOpened;
    body.onCancel(stop);
    req.signal.addEventListener("abort", stop, { once: true });
    return new Response(body.stream, { status: 200, headers: sseHeaders() });
  } catch {
    conn.close();
    return sseFinal("reconnecting");
  }
}

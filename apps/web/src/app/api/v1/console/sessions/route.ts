// Only re-exports: the logic is a plain Request -> Response handler in src/server (console-sessions.ts, wired in routes.ts).
export { consoleSessionsGET as GET } from "../../../../../server/routes";
export { consoleSessionsPOST as POST } from "../../../../../server/routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Only re-exports: the logic is a plain Request -> Response handler in src/server (console-report-handlers.ts, wired in routes.ts).
export { consoleReportHidePOST as POST } from "../../../../../../../../server/routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

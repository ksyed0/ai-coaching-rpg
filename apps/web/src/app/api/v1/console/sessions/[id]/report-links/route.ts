// Only re-exports: the logic is a plain Request -> Response handler in src/server (report-handlers.ts, wired in routes.ts).
export { consoleReportLinksGET as GET, consoleReportLinksPOST as POST } from "../../../../../../../server/routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

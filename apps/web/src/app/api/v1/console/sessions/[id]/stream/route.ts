// Only re-exports: the logic is a plain Request -> Response handler in src/server (console-stream.ts, wired in routes.ts).
export { consoleStreamGET as GET } from "../../../../../../../server/routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

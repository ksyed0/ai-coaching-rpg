// Only re-exports: the logic is a plain Request -> Response handler in src/server (console-ai.ts, wired in routes.ts).
export { consoleAiIntentsPOST as POST } from "../../../../../../../../../server/routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

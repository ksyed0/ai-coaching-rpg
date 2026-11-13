// Only re-exports: the logic is plain Request -> Response handlers in src/server (console-accounts.ts, wired in routes.ts).
export { adminAccountsGET as GET, adminAccountsPOST as POST } from "../../../../../../server/routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

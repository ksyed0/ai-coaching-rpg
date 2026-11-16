import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppHeader } from "../../components/AppHeader";
import { ConsoleDisabled, ConsoleUnavailable } from "../../components/console/ConsoleDisabled";
import { ConsoleLogin } from "../../components/console/ConsoleLogin";
import { ConsoleShell } from "../../components/console/ConsoleShell";
import { TitleBlock } from "../../components/TitleBlock";
import { CONSOLE_COOKIE } from "../../server/console-session";
import { consoleLegacyAllowed, consolePageRedirect, consoleView } from "../../server/routes";

// /console: the facilitator's page. Who is signed in comes only from the HttpOnly cookie, opened here on the server.

export const metadata: Metadata = {
  title: "Facilitator console · SceneCoach.ai",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function ConsolePage() {
  const view = await consoleView((await cookies()).get(CONSOLE_COOKIE)?.value);
  const to = consolePageRedirect(view);
  if (to !== null) redirect(to);
  const legacyAllowed = view.kind === "signed_out" && (await consoleLegacyAllowed());
  return (
    <>
      <AppHeader />
      <main className="page">
        {view.kind === "signed_in" ? (
          <>
            <TitleBlock title="Facilitator console" lede="Your sessions." />
            <div className="body">
              <ConsoleShell name={view.name} role={view.role} legacy={view.legacy} />
            </div>
          </>
        ) : (
          <>
            <TitleBlock
              title="Facilitator console"
              lede={
                view.kind === "disabled" || view.kind === "unavailable"
                  ? "The console is not available."
                  : "Sign in with your login and password."
              }
            />
            <div className="body narrow">
              {view.kind === "disabled" ? (
                <ConsoleDisabled />
              ) : view.kind === "unavailable" ? (
                <ConsoleUnavailable />
              ) : (
                <ConsoleLogin legacyAllowed={legacyAllowed} />
              )}
            </div>
          </>
        )}
      </main>
    </>
  );
}

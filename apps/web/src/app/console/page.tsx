import type { Metadata } from "next";
import { cookies } from "next/headers";
import { AppHeader } from "../../components/AppHeader";
import { ConsoleDisabled } from "../../components/console/ConsoleDisabled";
import { ConsoleLogin } from "../../components/console/ConsoleLogin";
import { ConsoleShell } from "../../components/console/ConsoleShell";
import { TitleBlock } from "../../components/TitleBlock";
import { CONSOLE_COOKIE } from "../../server/console-session";
import { consoleView } from "../../server/routes";

// /console: the facilitator's page. Who is signed in comes only from the HttpOnly cookie, opened here on the server.

export const metadata: Metadata = {
  title: "Facilitator console · SceneCoach.ai",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function ConsolePage() {
  const view = consoleView((await cookies()).get(CONSOLE_COOKIE)?.value);
  return (
    <>
      <AppHeader />
      <main className="page">
        {view.kind === "signed_in" ? (
          <>
            <TitleBlock title="Facilitator console" lede="Your sessions." />
            <div className="body">
              <ConsoleShell name={view.name} />
            </div>
          </>
        ) : (
          <>
            <TitleBlock
              title="Facilitator console"
              lede={
                view.kind === "disabled"
                  ? "The console is not available."
                  : "Sign in with the facilitator secret and your name."
              }
            />
            <div className="body narrow">
              {view.kind === "disabled" ? (
                <ConsoleDisabled />
              ) : (
                <ConsoleLogin />
              )}
            </div>
          </>
        )}
      </main>
    </>
  );
}

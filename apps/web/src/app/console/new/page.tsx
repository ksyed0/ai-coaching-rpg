import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppHeader } from "../../../components/AppHeader";
import { ConsoleDisabled, ConsoleUnavailable } from "../../../components/console/ConsoleDisabled";
import { ConsoleLogin } from "../../../components/console/ConsoleLogin";
import { NewSessionForm } from "../../../components/console/NewSessionForm";
import { TitleBlock } from "../../../components/TitleBlock";
import { CONSOLE_COOKIE } from "../../../server/console-session";
import { consolePageRedirect, consoleView } from "../../../server/routes";

// /console/new: create a session. Who is signed in comes only from the HttpOnly cookie, opened here on the server.

export const metadata: Metadata = {
  title: "New session · SceneCoach.ai",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function NewSessionPage() {
  const view = await consoleView((await cookies()).get(CONSOLE_COOKIE)?.value);
  const to = consolePageRedirect(view);
  if (to !== null) redirect(to);
  return (
    <>
      <AppHeader />
      <main className="page">
        <TitleBlock
          title="New session"
          lede={
            view.kind === "signed_in"
              ? "Pick a scenario. The join codes are shown once, right after it is created."
              : view.kind === "disabled" || view.kind === "unavailable"
                ? "The console is not available."
                : "Sign in with the facilitator secret and your name."
          }
        />
        <div className="body narrow">
          {view.kind === "signed_in" ? (
            <NewSessionForm />
          ) : view.kind === "disabled" ? (
            <ConsoleDisabled />
          ) : view.kind === "unavailable" ? (
            <ConsoleUnavailable />
          ) : (
            <ConsoleLogin />
          )}
        </div>
      </main>
    </>
  );
}

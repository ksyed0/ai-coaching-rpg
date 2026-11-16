import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppHeader } from "../../../components/AppHeader";
import { ChangePasswordForm } from "../../../components/console/ChangePasswordForm";
import { ConsoleDisabled, ConsoleUnavailable } from "../../../components/console/ConsoleDisabled";
import { TitleBlock } from "../../../components/TitleBlock";
import { CONSOLE_COOKIE } from "../../../server/console-session";
import { consoleView } from "../../../server/routes";

// /console/password: the forced change after a temporary password (every other console page sends a mustChange account here), and a
// voluntary change for anyone else who is signed in. Who is signed in comes only from the HttpOnly cookie, opened here on the server.

export const metadata: Metadata = {
  title: "Change password · SceneCoach.ai",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function ConsolePasswordPage() {
  const view = await consoleView((await cookies()).get(CONSOLE_COOKIE)?.value);
  if (view.kind === "signed_out") redirect("/console");
  return (
    <>
      <AppHeader />
      <main className="page">
        <TitleBlock
          title="Change password"
          lede={
            view.kind === "signed_in"
              ? view.mustChange
                ? "Choose a new password before you continue."
                : "Choose a new password for your account."
              : "The console is not available."
          }
        />
        <div className="body narrow">
          {view.kind === "signed_in" ? (
            <ChangePasswordForm />
          ) : view.kind === "disabled" ? (
            <ConsoleDisabled />
          ) : (
            <ConsoleUnavailable />
          )}
        </div>
      </main>
    </>
  );
}

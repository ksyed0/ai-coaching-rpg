import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppHeader } from "../../../components/AppHeader";
import { FacilitatorsPanel } from "../../../components/console/admin/FacilitatorsPanel";
import { ConsoleDisabled, ConsoleUnavailable } from "../../../components/console/ConsoleDisabled";
import { TitleBlock } from "../../../components/TitleBlock";
import { CONSOLE_COOKIE } from "../../../server/console-session";
import { adminPageRedirect, consoleView } from "../../../server/routes";

// /console/admin: the admin's list of facilitator accounts. Who is signed in comes only from the HttpOnly cookie, opened here on the
// server: signed out goes to the sign-in, an account that must change its password goes there first, and anyone who is not an admin
// account (a facilitator, or a legacy shared-secret sign-in) goes back to /console. The BFF refuses them as well.

export const metadata: Metadata = {
  title: "Facilitator accounts · SceneCoach.ai",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function ConsoleAdminPage() {
  const view = await consoleView((await cookies()).get(CONSOLE_COOKIE)?.value);
  const to = adminPageRedirect(view);
  if (to !== null) redirect(to);
  return (
    <>
      <AppHeader />
      <main className="page">
        <TitleBlock
          title="Facilitator accounts"
          lede={view.kind === "signed_in" ? "Add people, reset their passwords and end their access." : "The console is not available."}
        />
        <div className="body">
          {view.kind === "signed_in" ? (
            <div className="stack">
              <p>
                <a href="/console">Back to your sessions</a>
              </p>
              <FacilitatorsPanel />
            </div>
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

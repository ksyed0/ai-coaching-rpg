import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { isValidSessionId } from "@acr/events";
import { AppHeader } from "../../../components/AppHeader";
import { ConsoleDisabled } from "../../../components/console/ConsoleDisabled";
import { ConsoleLogin } from "../../../components/console/ConsoleLogin";
import { Readiness } from "../../../components/console/Readiness";
import { TitleBlock } from "../../../components/TitleBlock";
import { CONSOLE_COOKIE } from "../../../server/console-session";
import { consoleView } from "../../../server/routes";

// /console/<id>: one session's readiness and Start. The id is checked here; the BFF checks it again on every call.

export const metadata: Metadata = {
  title: "Session · SceneCoach.ai",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function ConsoleSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isValidSessionId(id)) notFound();
  const view = consoleView((await cookies()).get(CONSOLE_COOKIE)?.value);
  return (
    <>
      <AppHeader />
      <main className="page">
        <TitleBlock
          title="Session readiness"
          lede={
            view.kind === "signed_in"
              ? "See who has joined and consented, then start the session."
              : view.kind === "disabled"
                ? "The console is not available."
                : "Sign in with the facilitator secret and your name."
          }
        />
        <div className={view.kind === "signed_in" ? "body" : "body narrow"}>
          {view.kind === "signed_in" ? (
            <Readiness sessionId={id} />
          ) : view.kind === "disabled" ? (
            <ConsoleDisabled />
          ) : (
            <ConsoleLogin />
          )}
        </div>
      </main>
    </>
  );
}

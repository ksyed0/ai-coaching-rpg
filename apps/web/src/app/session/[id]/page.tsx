import type { Metadata } from "next";
import { isValidSessionId } from "@acr/events";
import { AppHeader } from "../../../components/AppHeader";
import { SessionScreen } from "../../../components/SessionScreen";
import { TitleBlock } from "../../../components/TitleBlock";
import { MESSAGES } from "../../../lib/messages";

// /session/<id>: the participant's live page. Who they are comes only from the HttpOnly cookie the join set (the BFF checks the id).

export const metadata: Metadata = { title: "Your session · SceneCoach.ai", robots: { index: false, follow: false } };

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidSessionId(id)) {
    return (
      <>
        <AppHeader />
        <main className="page">
          <TitleBlock title="Your session" lede="This link does not lead to a session." />
          <div className="body"><p className="banner warn" role="status">{MESSAGES.badLink}</p></div>
        </main>
      </>
    );
  }
  return <SessionScreen sessionId={id} />;
}

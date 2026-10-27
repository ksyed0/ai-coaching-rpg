import type { Metadata } from "next";
import { SessionScreen } from "../../../components/SessionScreen";

// /session/<id>: the participant's live page. Who they are comes only from the HttpOnly cookie the join set (the BFF checks the id).

export const metadata: Metadata = { title: "Your session · SceneCoach.ai", robots: { index: false, follow: false } };

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SessionScreen sessionId={id} />;
}

import type { Metadata } from "next";
import { AppHeader } from "../../components/AppHeader";
import { ReportView } from "../../components/ReportView";

// /report: the participant's released report. Who they are comes only from the sealed cookie, read by the BFF.

export const metadata: Metadata = { title: "Your report · SceneCoach.ai", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default function ReportPage() {
  return (
    <>
      <AppHeader />
      <main className="page">
        <ReportView />
      </main>
    </>
  );
}

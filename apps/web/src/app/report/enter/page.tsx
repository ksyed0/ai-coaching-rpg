import type { Metadata } from "next";
import { AppHeader } from "../../../components/AppHeader";
import { ReportEnter } from "../../../components/ReportEnter";

// /report/enter#<token>: the link the facilitator shares. The token is in the fragment, so no server ever sees it; the page trades it
// for a sign-in cookie and moves on to /report.

export const metadata: Metadata = { title: "Open your report · SceneCoach.ai", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default function ReportEnterPage() {
  return (
    <>
      <AppHeader />
      <main className="page">
        <ReportEnter />
      </main>
    </>
  );
}

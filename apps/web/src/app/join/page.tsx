import type { Metadata } from "next";
import { AppHeader } from "../../components/AppHeader";
import { JoinForm } from "../../components/JoinForm";
import { TitleBlock } from "../../components/TitleBlock";
import { MESSAGES } from "../../lib/messages";

// /join?session=<id>&role=<role>: the link the facilitator shares. The link carries no personal data; the code and the name are typed.

export const metadata: Metadata = { title: "Join a session · SceneCoach.ai", robots: { index: false, follow: false } };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" && v.length > 0 && v.length <= 128 ? v : null);

export default async function JoinPage({ searchParams }: { searchParams: Promise<Search> }) {
  const q = await searchParams;
  const sessionId = one(q.session);
  const roleId = one(q.role);
  return (
    <>
      <AppHeader status="lobby" roleId={roleId ?? undefined} />
      <main className="page">
        <TitleBlock title="Join your session" lede="Enter your name and the code your facilitator gave you. You give consent on the next screen." />
        <div className="body narrow">
          {sessionId && roleId ? <JoinForm sessionId={sessionId} roleId={roleId} /> : <p className="banner warn" role="status">{MESSAGES.badLink}</p>}
        </div>
      </main>
    </>
  );
}

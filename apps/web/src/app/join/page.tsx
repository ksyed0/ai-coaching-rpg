import type { Metadata } from "next";
import { CLIENT_ID_MAX_CHARS, isScenarioId, isValidSessionId } from "@acr/events";
import { AppHeader } from "../../components/AppHeader";
import { JoinForm } from "../../components/JoinForm";
import { TitleBlock } from "../../components/TitleBlock";
import { MESSAGES } from "../../lib/messages";

// /join?session=<id>&role=<role>: the link the facilitator shares. The link carries no personal data; the code and the name are typed.

export const metadata: Metadata = { title: "Join a session · SceneCoach.ai", robots: { index: false, follow: false } };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : null);
/** The same shapes the BFF accepts (handlers.ts): a link that cannot work is caught here, before anyone types a code. */
const isRoleParam = (v: string) => v.length <= CLIENT_ID_MAX_CHARS && isScenarioId(v);

export default async function JoinPage({ searchParams }: { searchParams: Promise<Search> }) {
  const q = await searchParams;
  const s = one(q.session);
  const r = one(q.role);
  const sessionId = s !== null && isValidSessionId(s) ? s : null;
  const roleId = r !== null && isRoleParam(r) ? r : null;
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

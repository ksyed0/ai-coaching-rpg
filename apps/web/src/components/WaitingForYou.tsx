"use client";

// US-0082: "Waiting for you" on the page of the player an AI line was addressed to, until that player speaks or the scene ends. A polite
// live region that is always mounted; the text is not a colour alone (the pill reads "Waiting for you"). The name is untrusted text.

export function WaitingForYou({ by }: { /** Who is waiting (named by the transcript's rule), or null when nobody is. */ by: string | null }) {
  return (
    <div className="waiting" role="status" aria-live="polite">
      {by !== null ? (
        <p className="banner waiting-you">
          <span className="pill">Waiting for you</span>{" "}
          <bdi>{by}</bdi> addressed you. Reply when you are ready.
        </p>
      ) : null}
    </div>
  );
}

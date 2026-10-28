// Every sentence the participant pages show of their own. Runtime text (lines, names, brief, facts, the notice) is shown as text
// elsewhere; the server's error text is shown only for the action answers, which the BFF writes itself (handlers.ts).

export const MESSAGES = {
  connecting: "Connecting to your session…",
  reconnecting: "Reconnecting… The page catches up on what you missed by itself.",
  superseded: "This session is open in another tab. Use that tab, or reload this page to continue here.",
  // The second half is SIGNED_OUT_MESSAGE in src/server/handlers.ts (a test keeps them together).
  signedOut: "You are signed out of this session: ask your facilitator for a new code.",
  expired: "Your sign-in for this session has expired: ask your facilitator for a new code.",
  sessionEnded: "The session has ended. Thank you for taking part.",
  left: "You have left the session and your seat is free. To come back, open your join link again or ask your facilitator.",
  unavailable: "The session cannot be reached right now. Try again in a moment.",
  serverError: "The server reported a problem. If your last line does not appear, send it again.",
  waiting: "Waiting for the facilitator to start. This page updates by itself; you can close the tab and come back with the same link.",
  paused: "The facilitator has paused the scene. You can speak again when it resumes.",
  sayOffline: "You can speak again once the connection is back.",
  notStarted: "You can speak once the scene starts.",
  joinRefused: "That did not work. Check the link and the code, or ask your facilitator for a new code.",
  badName: "Enter a name of 1 to 60 characters on one line.",
  generic: "Something went wrong. Try again.",
  badLink: "This join link is incomplete. Open the link your facilitator gave you.",
} as const;

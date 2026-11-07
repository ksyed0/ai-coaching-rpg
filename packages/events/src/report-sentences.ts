// The fixed sentences that the control service answers with and that the web server and console show or recognise. Defined once here so
// a rewording cannot reach one side only (BUG-0027). No path, id or role is ever part of them.
export const REPORT_SENTENCES = {
  /** Nothing is released or drafted for the session yet. */
  notReady: "No reports are ready for this session yet. Evaluate it from the Report panel of its console.",
  /** The role has no report to link. */
  noReport: "There is no report to link for this role.",
  /** US-0060: an AI player gets no report link. */
  aiLinkRefused: "AI players do not get report links.",
  /** The role already has a live link. */
  linkAlreadyActive: "A link is already active for this role.",
  /** Control cannot read the session's reports (503). */
  reportsUnreadable: "The reports for this session cannot be read. Check them with moderate status.",
  /** The report store or reader failed on a participant or facilitator call (503). */
  reportUnavailable: "The report is unavailable. Try again.",
} as const;

/**
 * How a hidden-fact release is shown in the demo's narration, transcript and report: by role and fact number only, never with the fact text.
 * The text is facilitator-only (it travels in the facilitator-only `npc.updated`), and a demo transcript is a file people share.
 */
export const releaseNote = (roleId: string, fact: number): string => `facilitator released hidden fact number ${fact} of ${roleId}`;

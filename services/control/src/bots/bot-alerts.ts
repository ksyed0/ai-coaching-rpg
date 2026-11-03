/** US-0060: the texts of the alerts a live AI player sends the facilitator (the runtime prefixes "AI player for <roleId>: "). */
export const BOT_ALERTS = {
  skippedModel: "skipped a turn: the model did not answer",
  skippedTimeout: "skipped a turn: the model took too long",
  skippedUnusable: "skipped a turn: the reply was empty or unusable",
  budget: "AI players are now silent: this session's model budget is used up",
  rejoinFailed: "could not rejoin the session; switch the role to human and back",
} as const;
export type BotAlert = keyof typeof BOT_ALERTS;

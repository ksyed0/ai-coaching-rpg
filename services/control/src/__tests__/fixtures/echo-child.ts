// Spike fixture: answers one ping with a pong and exits when the parent disconnects.
process.on("message", (msg: unknown) => {
  if ((msg as { type?: string } | null)?.type === "ping") process.send?.({ type: "pong" });
});
process.on("disconnect", () => process.exit(0));

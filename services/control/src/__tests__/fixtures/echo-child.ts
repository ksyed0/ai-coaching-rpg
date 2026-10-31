// Spike fixture: answers one ping with a pong and exits when the parent disconnects.
// The interval keeps the event loop open independently of the IPC channel (as the real
// runtime's HTTP server and timers do), so ONLY the disconnect handler can make this exit.
setInterval(() => {}, 2 ** 30);
process.on("message", (msg: unknown) => {
  if ((msg as { type?: string } | null)?.type === "ping") process.send?.({ type: "pong" });
});
process.on("disconnect", () => process.exit(0));

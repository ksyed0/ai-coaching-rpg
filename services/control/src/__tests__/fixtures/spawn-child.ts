// forkSpawn fixture: prints a line to stdout (the log file), answers `env` with the environment it received, `ping` with `pong`, and
// exits when the parent disconnects. With IGNORE_TERM=1 it ignores SIGTERM (only SIGKILL stops it). The interval keeps the loop open.
setInterval(() => {}, 2 ** 30);
console.log("child-log-line");
if (process.env.IGNORE_TERM === "1") process.on("SIGTERM", () => {});
process.on("message", (msg: unknown) => {
  const type = (msg as { type?: string } | null)?.type;
  if (type === "ping") process.send?.({ type: "pong" });
  if (type === "env") process.send?.({ type: "env", env: process.env });
});
process.on("disconnect", () => process.exit(0));
process.send?.({ type: "up" });

import readline from "node:readline";
import WebSocket from "ws";
import { parseArgs, parseInput, parseServerMessage, isFatalError, joinMessage } from "./commands.js";
import { renderEvent, renderJoined, renderError, sanitizeText } from "./render.js";

const CONNECT_TIMEOUT_MS = 10_000;
const EOF_GRACE_MS = 1_500; // piped stdin: let in-flight replies print before closing

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.ok) { console.error(parsed.error); process.exit(2); }
const opts = parsed.opts;
const me = opts.facilitator ? "facilitator" : opts.role!;

const tty = process.stdout.isTTY === true;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: tty ? `${sanitizeText(me)}> ` : "" });
const ws = new WebSocket(opts.url);
let joined = false;
let closing = false;

/** Every printed line is already sanitized by render.ts; this only handles prompt redraw. */
function print(line: string): void {
  if (tty) { readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0); }
  console.log(line);
  if (joined && !closing) rl.prompt(true);
}
function finish(code: number, message?: string): never {
  closing = true;
  if (message) console.error(message);
  try { ws.terminate(); } catch { /* already closed */ }
  rl.close();
  process.exit(code);
}

const connectTimer = setTimeout(() => finish(1, `could not connect to ${sanitizeText(opts.url)}: timed out`), CONNECT_TIMEOUT_MS);
ws.on("open", () => ws.send(JSON.stringify(joinMessage(opts))));
ws.on("error", (err) => finish(1, `connection failed: ${sanitizeText((err as NodeJS.ErrnoException).message || (err as NodeJS.ErrnoException).code || "unknown error")} (${sanitizeText(opts.url)})`));
ws.on("message", (raw) => {
  const m = parseServerMessage(raw.toString());
  if (!m) return;
  if (m.type === "joined") {
    clearTimeout(connectTimer);
    joined = true;
    for (const l of renderJoined(m)) console.log(l);
    rl.prompt();
  } else if (m.type === "event") {
    const line = renderEvent(m.event, me);
    if (line) print(line);
  } else if (m.type === "error") {
    if (isFatalError(m.code, joined)) finish(1, renderError(m.code, m.message));
    print(renderError(m.code, m.message));
  }
});
ws.on("close", () => {
  if (closing) return;
  finish(1, "disconnected from server");
});

rl.on("line", (line) => {
  const input = parseInput(line, opts.facilitator);
  switch (input.kind) {
    case "none": break;
    case "quit": closing = true; ws.close(); setTimeout(() => process.exit(0), 500).unref(); return;
    case "help": console.log(input.message); break;
    case "send": if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(input.message)); else console.log("not connected"); break;
  }
  rl.prompt();
});
rl.on("close", () => { if (!closing) setTimeout(() => { closing = true; ws.close(); setTimeout(() => process.exit(0), 300).unref(); }, EOF_GRACE_MS); });
process.on("SIGINT", () => { closing = true; try { ws.close(); } catch { /* ignore */ } setTimeout(() => process.exit(0), 200).unref(); });


import readline from "node:readline";
import WebSocket from "ws";
import { parseArgs } from "./commands.js";
import { createClient, DEFAULT_IDLE_MS } from "./client.js";
import { sanitizeText } from "./render.js";

const CONNECT_TIMEOUT_MS = 10_000;

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.ok) { console.error(`${parsed.error}\n${parsed.usage}`); process.exit(2); }
const opts = parsed.opts;
const me = opts.facilitator ? "facilitator" : opts.role!;
const tty = process.stdout.isTTY === true;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: tty ? `${sanitizeText(me)}> ` : "" });
const ws = new WebSocket(opts.url);

let connectTimer: NodeJS.Timeout | null = setTimeout(() => client.onError(new Error("timed out")), CONNECT_TIMEOUT_MS);
const client = createClient({
  opts,
  sock: { send: (d) => ws.send(d), close: () => ws.close(), terminate: () => ws.terminate() },
  idleMs: DEFAULT_IDLE_MS,
  io: {
    print: (line) => {
      if (tty) { readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0); }
      console.log(line);
      rl.prompt(true);
    },
    err: (line) => console.error(line),
    closeInput: () => rl.close(),
    exit: (code) => { if (connectTimer) clearTimeout(connectTimer); setTimeout(() => process.exit(code), 100).unref(); process.exitCode = code; },
  },
});

ws.on("open", () => client.onOpen());
ws.on("error", (err) => client.onError(err as Error));
ws.on("message", (raw) => { if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; } client.onMessage(raw.toString()); }); // timer covers connect + join
ws.on("close", () => client.onClose());
rl.on("line", (l) => client.onLine(l));
rl.on("close", () => client.onEof());
rl.on("SIGINT", () => client.onSigint()); // raw-mode TTY swallows Ctrl-C, so process.on("SIGINT") alone never fires
process.on("SIGINT", () => client.onSigint());

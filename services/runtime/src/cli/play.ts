import { statSync } from "node:fs";
import readline from "node:readline";
import WebSocket from "ws";
import { parseArgs } from "./commands.js";
import { plainTokenWarning, readTokenFile, resolveFacilitatorToken } from "./token.js";
import { readCodeFile, resolveJoinCode } from "./join-code.js";
import { createClient, DEFAULT_IDLE_MS } from "./client.js";
import { sanitizeText } from "./render.js";

const CONNECT_TIMEOUT_MS = 10_000;

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.ok) { console.error(`${parsed.error}\n${parsed.usage}`); process.exit(2); }
const opts = parsed.opts;

/** Reads one line from the terminal without echoing it (raw mode). Ctrl-C quits. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") { stdin.off("data", onData); stdin.setRawMode?.(false); stdin.pause(); process.stderr.write("\n"); return resolve(buf); }
        if (ch === "\u0003") { stdin.setRawMode?.(false); process.stderr.write("\n"); process.exit(130); }
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " ") buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

if (opts.facilitator) {
  const t = await resolveFacilitatorToken({
    env: process.env, tokenFile: opts.tokenFile,
    readFile: readTokenFile, fileMode: (f) => { try { return statSync(f).mode & 0o777; } catch { return undefined; } },
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true, promptHidden,
  });
  if (!t.ok) { console.error(t.error); process.exit(2); }
  for (const w of t.warnings) console.error(w);
  if (t.token !== undefined) opts.token = t.token;
  const plain = plainTokenWarning(opts.url, t.token !== undefined);
  if (plain) console.error(plain);
} else {
  // US-0033: the role's join code, from JOIN_CODE, --code-file or a hidden prompt (never argv). Never printed.
  const c = await resolveJoinCode({
    env: process.env, codeFile: opts.codeFile, role: opts.role!,
    readFile: readCodeFile, fileMode: (f) => { try { return statSync(f).mode & 0o777; } catch { return undefined; } },
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true, promptHidden,
  });
  if (!c.ok) { console.error(c.error); process.exit(2); }
  for (const w of c.warnings) console.error(w);
  if (c.code !== undefined) opts.joinCode = c.code;
}
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

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// One runtime process for the e2e stack and `pnpm demo --web` (run with tsx by start-stack.ts). It calls the runtime's own bootstrap,
// so this is the real server, and reports its port and any newly issued join codes on ONE stdout line for the parent (the codes go to
// the parent only, never to a log). It exits when the parent closes its stdin, so it never outlives the test or the demo.
//
// argv[2]: JSON { env, root, logDir }. Only that env reaches bootstrap (never this process's own environment), and root is a private
// temp dir, so no .env from the repo and no FACILITATOR_TOKEN or SESSION_START from the caller's shell can leak in.

// start-stack.ts waits for this prefix (kept in step there; importing this file would run it).
const READY_PREFIX = "ACR_RUNTIME_READY ";

type Host = { idle(): Promise<void> };
type Bootstrap = (o: { env: Record<string, string>; root: string; logDir: string; log: (m: string) => void; warn: (m: string) => void; showJoinCodes: (c: { roleId: string; code: string }[]) => void }) =>
  Promise<{ ok: true; runtime: { port: number; host: Host; stop(): Promise<void> } } | { ok: false; errors: string[] }>;

const MAIN = fileURLToPath(new URL("../../../../services/runtime/src/main.ts", import.meta.url));

async function main(): Promise<void> {
  if (!existsSync(MAIN)) throw new Error("the runtime's entry point moved: update MAIN in e2e/helpers/runtime-child.ts");
  const args = JSON.parse(process.argv[2] ?? "{}") as { env: Record<string, string>; root: string; logDir: string };
  const { bootstrap } = (await import(pathToFileURL(MAIN).href)) as { bootstrap: Bootstrap };
  const codes: Record<string, string> = {};
  // The runtime's log lines carry no codes, names or credentials; stderr keeps them out of the ready line's channel.
  const r = await bootstrap({
    env: args.env, root: args.root, logDir: args.logDir,
    log: (m) => process.stderr.write(`runtime: ${m}\n`), warn: (m) => process.stderr.write(`runtime: ${m}\n`),
    showJoinCodes: (c) => { for (const x of c) codes[x.roleId] = x.code; },
  });
  if (!r.ok) { process.stderr.write(`runtime: cannot start: ${r.errors.join("; ")}\n`); process.exit(1); }
  const runtime = r.runtime;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void runtime.stop().finally(() => process.exit(0));
  };
  process.stdin.on("end", stop);
  process.stdin.on("close", stop);
  process.stdin.resume();
  process.on("SIGTERM", stop);
  process.stdout.write(`${READY_PREFIX}${JSON.stringify({ port: runtime.port, codes })}\n`);
}

main().catch((err: unknown) => { process.stderr.write(`runtime: ${err instanceof Error ? err.message : "failed"}\n`); process.exit(1); });

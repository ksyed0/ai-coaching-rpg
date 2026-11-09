#!/usr/bin/env node
// US-0072 (EPIC-0003 voice A1c, Task 7): a stand-in for the `docker` CLI, for the real-process tests only. The tests copy it into a
// private directory as `docker` (first line rewritten to this Node's absolute path, chmod 755) beside a `stub-config.json` (voice-ops
// gives docker an environment of PATH, HOME, DOCKER_* and the compose interpolation values only, so the config cannot come from the
// environment). It never starts a container.
//
// It appends one JSON line per call (its argv and the NAMES of its environment) to `docker-record.jsonl` beside itself, then:
// `compose version --short` prints 2.24.0; `context inspect ...` prints a unix:// endpoint; `version ...` prints 29.8.2;
// `compose ... up`: with `holdUp` it records `up-holding` and waits (SIGINT ends it with 130, as a real Ctrl-C would); otherwise it
// starts a detached `node:http` server on 127.0.0.1:<livekitPort> standing in for LiveKit (its pid in `livekit-standin.pid`), waits
// until it listens, and exits 0; `compose ... down` stops that server and exits 0.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setInterval, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(here, "stub-config.json"), "utf8"));
const args = process.argv.slice(2);
const record = (entry) =>
  appendFileSync(
    path.join(here, "docker-record.jsonl"),
    JSON.stringify(entry) + "\n",
  );
record({ argv: args, envNames: Object.keys(process.env).sort() });
const pidFile = path.join(here, "livekit-standin.pid");
const port = config.livekitPort ?? 7880;

if (args[0] === "compose" && args[1] === "version") {
  process.stdout.write("2.24.0\n");
} else if (args[0] === "context") {
  process.stdout.write("unix:///var/run/docker.sock\n");
} else if (args[0] === "version") {
  process.stdout.write("29.8.2\n");
} else if (args[0] === "compose" && args.includes("up")) {
  if (config.holdUp) {
    record({ event: "up-holding" });
    process.on("SIGINT", () => process.exit(130));
    process.on("SIGTERM", () => process.exit(143));
    setInterval(() => {}, 1000);
  } else {
    const code = `const s=require("node:http").createServer((q,r)=>{r.writeHead(200);r.end("OK")});s.listen(${port},"127.0.0.1",()=>require("node:fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid)));process.on("SIGTERM",()=>process.exit(0));`;
    const child = spawn(process.execPath, ["-e", code], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const started = Date.now();
    const poll = () => {
      if (existsSync(pidFile)) process.exit(0);
      if (Date.now() - started > 20_000) process.exit(1);
      setTimeout(poll, 50);
    };
    poll();
  }
} else if (args[0] === "compose" && args.includes("down")) {
  if (existsSync(pidFile)) {
    try {
      process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM");
    } catch {
      // already gone
    }
    rmSync(pidFile, { force: true });
  }
}

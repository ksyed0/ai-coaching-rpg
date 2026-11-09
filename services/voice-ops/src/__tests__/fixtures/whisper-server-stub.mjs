#!/usr/bin/env node
// US-0072 (EPIC-0003 voice A1c, Task 4): a stand-in for whisper.cpp's `whisper-server`, for tests only. The tests copy it into a private
// directory as `whisper-server` (first line rewritten to this Node's absolute path, chmod 755) beside a `stub-config.json`; it never
// reads environment variables, because voice-ops gives whisper-server an environment of exactly PATH and HOME.
//
// It records its argv, its working directory and the NAMES of its environment into `stub-record.json` beside itself, then listens on
// `--host`/`--port`. Under `--request-path` (if any) it answers `/health` with 503 {"status":"loading model"} for the first
// `loadingPolls` requests and then 200 {"status":"ok"}, and `/inference` (POST) with a minimal verbose_json; everything else is 404
// (this models the unverified rule that the request path prefixes /health too). Per inference it prints a marker line to STDOUT (the
// real server is expected to print segment text there, plan K16) and a plain line to stderr.
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
  readFileSync(path.join(here, "stub-config.json"), "utf8"),
);
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
writeFileSync(
  path.join(here, "stub-record.json"),
  JSON.stringify({
    argv: args,
    cwd: process.cwd(),
    envNames: Object.keys(process.env).sort(),
    pid: process.pid,
  }),
);

const host = arg("--host") ?? "127.0.0.1";
const port = Number(arg("--port") ?? "8080");
const prefix = arg("--request-path") ?? "";
let polls = 0;

const server = http.createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === `${prefix}/health`) {
    polls += 1;
    if (polls <= (config.loadingPolls ?? 0))
      send(503, { status: "loading model" });
    else send(200, { status: "ok" });
    return;
  }
  if (req.method === "POST" && req.url === `${prefix}/inference`) {
    req.resume();
    req.on("end", () => {
      process.stdout.write(
        `${config.stdoutMarker ?? "STUB-STDOUT-MARKER"} [00:00:00.000 --> 00:00:01.000]\n`,
      );
      process.stderr.write("stub: inference answered\n");
      send(200, {
        task: "transcribe",
        language: "en",
        duration: 1,
        text: "",
        segments: [],
      });
    });
    return;
  }
  req.resume();
  send(404, { error: "not found" });
});
server.listen(port, host, () => {
  process.stderr.write(`whisper server listening at http://${host}:${port}\n`);
});
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

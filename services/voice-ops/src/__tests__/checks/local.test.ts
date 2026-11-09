import { mkdtempSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backupCheck } from "../../checks/backup.js";
import { diskCheck } from "../../checks/disk.js";
import { portsCheck } from "../../checks/ports.js";
import { imageTag, versionsCheck, whisperVersionOf } from "../../checks/versions.js";
import { lanAddressesOf, webCheck } from "../../checks/web.js";
import type { Run } from "../../run.js";
import { privateTmp } from "../helpers/ops-harness.js";

// US-0072 (EPIC-0003 voice A1c, Task 8): the checks that look at this machine (disk, ports, backup exclusion, versions, the web bind),
// every seam faked.

let tmp: ReturnType<typeof privateTmp>;
beforeAll(() => { tmp = privateTmp("acr-voice-ops-checks-"); });
afterAll(() => tmp.restore());

describe("diskCheck", () => {
  it("fails below AUDIO_MIN_FREE_MB on the nearest existing parent", () => {
    const dir = mkdtempSync(path.join(tmp.root, "d-"));
    const asked: string[] = [];
    const statfs = (p: string) => { asked.push(p); return { bavail: 1000, bsize: 1024 * 1024 }; };
    const ok = diskCheck({ dirs: [path.join(dir, "audio", "not", "yet")], minFreeMb: 512, statfs });
    expect(asked).toEqual([dir]);
    expect(ok).toEqual({ name: "disk", level: "ok", line: "disk: 1000 MB free (AUDIO_MIN_FREE_MB 512)" });
    expect(diskCheck({ dirs: [dir], minFreeMb: 2048, statfs })).toEqual({ name: "disk", level: "fail", line: "disk: 1000 MB free, below AUDIO_MIN_FREE_MB 2048: free some space" });
    expect(diskCheck({ dirs: [dir], minFreeMb: 2048, statfs: () => { throw new Error("EIO"); } }).level).toBe("fail");
  });
});

describe("portsCheck", () => {
  const wanted = [{ host: "127.0.0.1", port: 7880, proto: "tcp" as const, label: "LiveKit API" }];
  it.each([
    [false, "free", "ok"], [false, "taken", "warn"], [false, "denied", "skip"],
    [true, "free", "fail"], [true, "taken", "ok"], [true, "denied", "skip"],
  ] as const)("running=%s, port %s: %s", async (running, probe, level) => {
    const r = await portsCheck({ running, wanted, portFree: async () => probe });
    expect(r).toHaveLength(1);
    expect(r[0]!.level).toBe(level);
    expect(r[0]!.line).toContain("7880 (LiveKit API)");
  });
});

describe("backupCheck", () => {
  const dirs = [{ label: "the audio folder (AUDIO_DIR)", dir: "/x/audio" }, { label: "the state folder (VOICE_STATE_DIR)", dir: "/x/state" }];
  const fake = (excluded: Set<string>): { run: Run; calls: string[][] } => {
    const calls: string[][] = [];
    return { calls, run: async (cmd, args, o) => { calls.push([cmd, ...args, String(o?.env?.PATH)]); return { code: 0, stdout: `${excluded.has(args[1]!) ? "[Excluded]" : "[Included]"}    ${args[1]}\n`, stderr: "" }; } };
  };
  it("excluded is ok, not excluded warns, and the state directory is checked too", async () => {
    const f = fake(new Set(["/x/audio"]));
    const r = await backupCheck({ platform: "darwin", dirs, run: f.run, exists: () => true });
    expect(f.calls).toEqual([["tmutil", "isexcluded", "/x/audio", "/usr/bin:/bin"], ["tmutil", "isexcluded", "/x/state", "/usr/bin:/bin"]]);
    expect(r.map((x) => x.level)).toEqual(["ok", "warn"]);
    expect(r[1]!.line).toBe("the state folder (VOICE_STATE_DIR) is not excluded from Time Machine backups: see docs/VOICE_RUNBOOK.md (tmutil addexclusion)");
    for (const x of r) expect(x.line).not.toContain("/x/");
  });
  it("a missing folder skips; tmutil failing warns; non-macOS skips", async () => {
    const r = await backupCheck({ platform: "darwin", dirs: dirs.slice(0, 1), run: async () => { throw new Error("could not run tmutil (ENOENT)"); }, exists: () => true });
    expect(r[0]!.level).toBe("warn");
    expect((await backupCheck({ platform: "darwin", dirs: dirs.slice(0, 1), run: fake(new Set()).run, exists: () => false }))[0]!.level).toBe("skip");
    expect(await backupCheck({ platform: "linux", dirs, run: fake(new Set()).run })).toEqual([{ name: "backup", level: "skip", line: "backup exclusion: checked on macOS only" }]);
  });
});

describe("versionsCheck", () => {
  it("parses the Cellar path, unknown otherwise", () => {
    expect(whisperVersionOf("/opt/homebrew/Cellar/whisper-cpp/1.9.5/bin/whisper-server")).toBe("1.9.5");
    expect(whisperVersionOf("/usr/local/bin/whisper-server")).toBe("unknown");
    expect(whisperVersionOf(null)).toBe("unknown");
  });
  it("reads the image tags from voice.yml and asks docker only when Docker passed its check", async () => {
    const yml = "services:\n  livekit:\n    image: livekit/livekit-server:v1.13.11@sha256:abc\n  caddy:\n    image: caddy:2.11.9@sha256:def\n";
    expect(imageTag(yml, "livekit/livekit-server")).toBe("v1.13.11");
    expect(imageTag(yml, "caddy")).toBe("2.11.9");
    const calls: string[][] = [];
    const run: Run = async (_c, args) => { calls.push([...args]); return { code: 0, stdout: args[0] === "version" ? "29.8.2\n" : "2.24.0\n", stderr: "" }; };
    const r = await versionsCheck({ run, env: { PATH: "/usr/bin", LIVEKIT_API_SECRET: "x" }, docker: true, modelLabel: "small.en", whisperPath: "/opt/homebrew/Cellar/whisper-cpp/1.9.5/bin/whisper-server", composeText: yml, node: "v22.23.1" });
    expect(r).toEqual({ name: "versions", level: "ok", line: "versions: whisper-server 1.9.5, model small.en, Docker 29.8.2, Compose 2.24.0, LiveKit v1.13.11, Caddy 2.11.9, Node v22.23.1" });
    expect(calls).toEqual([["version", "--format", "{{.Server.Version}}"], ["compose", "version", "--short"]]);
    calls.length = 0;
    const off = await versionsCheck({ run, env: {}, docker: false, modelLabel: "small.en", whisperPath: null, composeText: null, node: "v22.23.1" });
    expect(calls).toEqual([]);
    expect(off.line).toBe("versions: whisper-server unknown, model small.en, Docker unknown, Compose unknown, LiveKit unknown, Caddy unknown, Node v22.23.1");
  });
});

describe("webCheck", () => {
  const ifaces = { lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }], en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }, { address: "fe80::1", family: "IPv6", internal: false }], utun: [{ address: "10.8.0.2", family: "IPv4", internal: false }] } as unknown as Parameters<typeof lanAddressesOf>[0];
  it("lanAddressesOf takes every non-internal IPv4 address of the interfaces", () => {
    expect(lanAddressesOf(ifaces)).toEqual(["192.168.1.20", "10.8.0.2"]);
  });
  it("fails when the web app answers on a LAN address", async () => {
    const r = await webCheck({ webPort: 3000, lanAddresses: ["192.168.1.20"], connect: async () => "open" });
    expect(r.map((x) => x.level)).toEqual(["ok", "fail"]);
    expect(r[1]!.line).toBe("the web app listens on the LAN (192.168.1.20:3000): start it with pnpm --filter @acr/web start");
  });
  it("local mode with the web app on loopback only is ok (it never asks the node address 127.0.0.1 as a LAN address)", async () => {
    const asked: string[] = [];
    const r = await webCheck({ webPort: 3000, lanAddresses: ["192.168.1.20", "10.8.0.2"], connect: async (h, p) => { asked.push(`${h}:${p}`); return h === "127.0.0.1" ? "open" : "refused"; } });
    expect(asked).toEqual(["127.0.0.1:3000", "192.168.1.20:3000", "10.8.0.2:3000"]);
    expect(r).toEqual([
      { name: "web", level: "ok", line: "the web app answers on 127.0.0.1:3000" },
      { name: "web-lan", level: "ok", line: "the web app does not listen on this machine's LAN addresses" },
    ]);
  });
  it("no LAN address skips; a web app that is not running warns; the proxy route is reported", async () => {
    const r = await webCheck({ webPort: 3000, lanAddresses: [], connect: async () => "refused", viaProxy: async () => 200 });
    expect(r).toEqual([
      { name: "web", level: "warn", line: "the web app is not running on 127.0.0.1:3000: start it with pnpm --filter @acr/web start" },
      { name: "web-lan", level: "skip", line: "no LAN address on this machine" },
      { name: "web-proxy", level: "ok", line: "the web app answers through the proxy" },
    ]);
    const p = await webCheck({ webPort: 3000, lanAddresses: [], connect: async () => "open", viaProxy: async () => null });
    expect(p[2]).toEqual({ name: "web-proxy", level: "fail", line: "the web app does not answer through the proxy with a trusted certificate" });
  });
});

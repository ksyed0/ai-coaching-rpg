import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { voiceCheck, type CheckDeps } from "../check.js";
import { voiceUp } from "../up.js";
import { makeWorld, privateTmp, type World } from "./helpers/ops-harness.js";

// US-0072 (EPIC-0003 voice A1c, Task 9): the `voice:check` report with every seam faked (ops-harness.ts plus the resolvers, statfs and
// the TCP probe), and a real loopback stand-in for LiveKit's RoomService where the key check is exercised.

let tmp: ReturnType<typeof privateTmp>;
beforeAll(() => { tmp = privateTmp("acr-voice-ops-check-"); });
afterAll(() => tmp.restore());
const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null))))); });

/** A stand-in for LiveKit's HTTP port: `status` for ListRooms, 200 for anything else. */
async function livekitStandIn(status: number): Promise<number> {
  const s = http.createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(req.url?.startsWith("/twirp/") ? status : 200); res.end('{"rooms":[{"name":"seat-room-marker"}]}'); }); });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return (s.address() as AddressInfo).port;
}

const MARKERS = {
  key: "APImarkerkey000000000000001",
  secret: "marker-secret-0123456789abcdef0123456789abcdef",
  sttPath: "/markerpath0123456789abcdef01234",
  dns: "marker-dns-token-0123456789",
  launcher: "placeholder-launcher-token-0123456789abcdef",
};

function checkDeps(w: World, o: { web?: "loopback" | "lan" | "none" } = {}): CheckDeps {
  return {
    ...w.deps(),
    resolve4: async () => ["192.168.1.20"], resolve6: async () => [], lookup: async () => [{ address: "192.168.1.20", family: 4 }],
    statfs: () => ({ bavail: 10_000, bsize: 1024 * 1024 }),
    tcpConnect: async (host) => ((o.web ?? "loopback") === "none" ? "refused" : host === "127.0.0.1" || o.web === "lan" ? "open" : "refused"),
    platform: "linux", whisperPath: () => null, corsOrigin: async () => null,
  };
}

async function running(o: Parameters<typeof makeWorld>[1] = {}): Promise<World> {
  const w = makeWorld(tmp.root, o);
  expect(await voiceUp(w.deps())).toBe(0);
  w.out.length = 0;
  return w;
}

describe("voiceCheck", () => {
  it("local mode with everything up: exit 0 and the reminder", async () => {
    const w = await running();
    w.ports.set("127.0.0.1:7880/tcp", "taken").set("127.0.0.1:7881/tcp", "taken").set("127.0.0.1:7882/udp", "taken").set("127.0.0.1:23456/tcp", "taken");
    w.ifaces = { en0: [{ address: "192.168.1.20", family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: "192.168.1.20/24" }] };
    const port = await livekitStandIn(200); // never the machine's own 7880
    const d = checkDeps(w);
    expect(await voiceCheck({ ...d, env: { ...w.realEnv, LIVEKIT_HOST: `http://127.0.0.1:${port}` }, answers: async () => true })).toBe(0);
    const out = w.out.join("\n");
    expect(out).toContain("OK   whisper-server is healthy on 127.0.0.1");
    expect(out).toContain(`OK   LiveKit answers on 127.0.0.1:${port}`);
    expect(out).toContain("OK   LiveKit accepts control's keys");
    expect(out).toContain("OK   the web app does not listen on this machine's LAN addresses");
    expect(out).toContain("voice:check: only this machine's browser can use the microphone: http://localhost:3000");
    expect(w.out.at(-1)).toMatch(/^voice:check: \d+ ok, \d+ warn, 0 fail, \d+ skip$/);
    expect(out).not.toContain("FAIL");
  });

  it("one failing check gives exit 1 and every other check still runs", async () => {
    const w = await running();
    const d = checkDeps(w, { web: "lan" });
    w.ifaces = { en0: [{ address: "192.168.1.20", family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: "192.168.1.20/24" }] };
    expect(await voiceCheck({ ...d, answers: async () => true })).toBe(1);
    const out = w.out.join("\n");
    expect(out).toContain("FAIL the web app listens on the LAN (192.168.1.20:3000)");
    for (const name of ["whisper-server is healthy", "LiveKit answers", "disk:", "versions:"]) expect(out).toContain(name);
  });

  it("bad settings give exit 2 and name the variable", async () => {
    const w = makeWorld(tmp.root, { envLines: ["AUDIO_MIN_FREE_MB=12"] });
    expect(await voiceCheck(checkDeps(w))).toBe(2);
    expect(w.out).toEqual(["voice:check: AUDIO_MIN_FREE_MB must be a whole number from 512 to 1000000"]);
  });

  it("voice:check prints no secret, writes nothing and creates no state folder", async () => {
    const w = makeWorld(tmp.root, {
      lan: true,
      envLines: [`LIVEKIT_API_KEY=${MARKERS.key}`, `LIVEKIT_API_SECRET=${MARKERS.secret}`, `STT_URL=http://127.0.0.1:23999${MARKERS.sttPath}`, `VOICE_DNS_API_TOKEN=${MARKERS.dns}`],
    });
    w.realEnv.OTHER_TOKEN = "marker-real-environment-value-0001";
    const before = readFileSync(w.envFile);
    const port = await livekitStandIn(200);
    const d = checkDeps(w);
    const code = await voiceCheck({ ...d, health: async () => "ok", corsOrigin: async () => "*", answers: async () => true, env: { ...w.realEnv, LIVEKIT_HOST: `http://127.0.0.1:${port}` } });
    expect(code).toBe(1); // nothing is running in lan mode: the TLS route etc. fail
    const report = w.out.join("\n");
    for (const v of [...Object.values(MARKERS), MARKERS.sttPath.slice(1), "marker-real-environment-value-0001", "seat-room-marker"]) expect(report).not.toContain(v);
    expect(report).toContain("OK   LiveKit accepts control's keys");
    expect(readFileSync(w.envFile).equals(before)).toBe(true);
    expect(existsSync(w.stateDir)).toBe(false);
    expect(w.calls.filter((c) => c.cmd === "git")).toEqual([]);
  });

  it("lan mode runs the certificate, DNS and TLS route checks", async () => {
    const w = await running({ lan: true });
    const d = checkDeps(w);
    await voiceCheck({ ...d, answers: async () => true });
    const out = w.out.join("\n");
    expect(out).toContain("FAIL VOICE_TLS_CERT_FILE is not a PEM certificate"); // the harness's placeholder file
    expect(out).toContain("OK   DNS: voice.pilot.example points to this machine (192.168.1.20)");
    expect(out).toContain("OK   the TLS route https://voice.pilot.example:7443/rtc answers with a trusted certificate");
    expect(out).toContain("OK   the web app answers through the proxy");
    expect(out).toContain("voice:check: participants open https://voice.pilot.example; a plain http:// LAN address cannot use the microphone");
    expect(w.tlsAsked.map((t) => `${t.host}:${t.port}`)).toContain("voice.pilot.example:443");
  });

  it("a node address that changed since voice:up fails", async () => {
    const w = await running({ lan: true });
    w.ifaces = { en0: [{ address: "192.168.1.77", family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: "192.168.1.77/24" }] };
    expect(await voiceCheck({ ...checkDeps(w), answers: async () => true })).toBe(1);
    expect(w.out[0]).toBe("FAIL the node address changed since voice:up: run pnpm voice:down and pnpm voice:up");
  });

  it("keys LiveKit refuses fail", async () => {
    const w = await running();
    const port = await livekitStandIn(401);
    const d = checkDeps(w);
    expect(await voiceCheck({ ...d, env: { ...w.realEnv, LIVEKIT_HOST: `http://127.0.0.1:${port}` }, answers: async () => true })).toBe(1);
    expect(w.out.join("\n")).toContain("FAIL LiveKit does not accept control's keys: run pnpm voice:down and pnpm voice:up");
  });

  it("a Docker problem is a failure and docker is not asked for versions", async () => {
    const w = await running();
    w.calls.length = 0;
    w.realEnv.DOCKER_HOST = "tcp://10.0.0.5:2376";
    expect(await voiceCheck({ ...checkDeps(w), answers: async () => true })).toBe(1);
    expect(w.out.join("\n")).toContain("FAIL voice:up runs only against a Docker engine on this machine: DOCKER_HOST must be unset");
    expect(w.calls.filter((c) => c.cmd === "docker")).toEqual([]);
  });

  it("on macOS the backup check asks tmutil about the state folder", async () => {
    const w = await running();
    await voiceCheck({ ...checkDeps(w), platform: "darwin", answers: async () => true });
    expect(w.calls.filter((c) => c.cmd === "tmutil").map((c) => c.args)).toEqual([["isexcluded", w.stateDir]]);
    expect(w.out.join("\n")).toContain("OK   the state folder (VOICE_STATE_DIR) is excluded from Time Machine backups");
  });
});

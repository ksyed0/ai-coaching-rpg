import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// US-0072 (EPIC-0003 voice A1c, Task 5): the committed compose file, LiveKit configuration and Caddyfile, checked line by line (our own
// files; no YAML parser, no new dependency). Comments are stripped before each rule, so a comment that explains a forbidden directive
// does not count as one. Nothing here runs Docker.

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const read = (f: string): string => readFileSync(path.join(REPO, "deploy", "compose", f), "utf8");
/** The lines without comments (YAML and Caddyfile both use `#`; none of our values contains one) and without blank lines. */
const code = (text: string): string[] => text.split("\n").map((l) => { const i = l.indexOf("#"); return (i >= 0 ? l.slice(0, i) : l).trimEnd(); }).filter((l) => l.trim() !== "");
/** The lines of one top-level service (two-space indent under `services:`), comments stripped. */
function service(text: string, name: string): string[] {
  const lines = code(text);
  const start = lines.indexOf(`  ${name}:`);
  expect(start, `service ${name}`).toBeGreaterThanOrEqual(0);
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) { const l = lines[i]!; if (!l.startsWith("   ")) break; out.push(l.trim()); }
  return out;
}

const voice = read("voice.yml");
const livekitYaml = read("livekit.yaml");
const caddyfile = read("Caddyfile");
const LIVEKIT_IMAGE = "livekit/livekit-server:v1.13.11@sha256:25cd902de7cacbd5f1f779f6a6ac1eae20ba8f56b0935934ce6b0ab80d1e3d20";
const CADDY_IMAGE = "caddy:2.11.9@sha256:0c2243efcf437ab7f7a978f1027fcf0d4f9be8a75df27b1b3fbc5dbe0ffa8cf0";

describe("deploy/compose/voice.yml (US-0072, A1c Task 5)", () => {
  it("has the fixed project name and exactly the two services", () => {
    expect(code(voice)).toContain("name: scenecoach-voice");
    const services = code(voice).filter((l) => /^ {2}[a-z]/.test(l)).map((l) => l.trim());
    expect(services).toEqual(["livekit:", "caddy:"]);
  });

  it("pins every image by digest, with the findings.md digests", () => {
    const images = code(voice).filter((l) => l.trim().startsWith("image:")).map((l) => l.trim().slice("image:".length).trim());
    expect(images).toEqual([LIVEKIT_IMAGE, CADDY_IMAGE]);
    for (const img of images) {
      const at = img.indexOf("@sha256:");
      expect(at, img).toBeGreaterThan(0);
      const hex = img.slice(at + "@sha256:".length);
      expect(hex).toHaveLength(64);
      expect([...hex].every((c) => "0123456789abcdef".includes(c))).toBe(true);
    }
    expect(code(voice).some((l) => l.includes("build:"))).toBe(false);
  });

  it("LiveKit gets only its own env file, never the root .env", () => {
    const lk = service(voice, "livekit");
    expect(lk.filter((l) => l.startsWith("env_file"))).toEqual(["env_file:"]);
    const i = lk.indexOf("env_file:");
    expect(lk.slice(i + 1, i + 3)).toEqual(["- path: ${VOICE_STATE_DIR:?}/livekit.env", "required: false"]);
    expect(lk[i + 3]?.startsWith("- ")).not.toBe(true); // one entry only
    for (const l of code(voice)) {
      expect(l, l).not.toContain("../../.env");
      if (l.includes(".env")) expect(l).toContain("/livekit.env");
    }
    expect(service(voice, "caddy").some((l) => l.startsWith("env_file"))).toBe(false);
    expect(lk.some((l) => l.startsWith("environment"))).toBe(false);
  });

  it("never --dev anywhere", () => {
    for (const text of [voice, livekitYaml, caddyfile]) expect(code(text).join("\n")).not.toContain("--dev");
    expect(code(livekitYaml).join("\n")).not.toMatch(/development/);
  });

  it("LiveKit's command: its config, bind inside the container, the node address", () => {
    const lk = service(voice, "livekit");
    const i = lk.indexOf("command:");
    expect(lk.slice(i + 1, i + 8)).toEqual(["- --config", "- /etc/livekit.yaml", "- --bind", "- 0.0.0.0", "- --node-ip", "- ${VOICE_NODE_IP:?}", "env_file:"]);
    expect(service(voice, "livekit")).toContain("- ./livekit.yaml:/etc/livekit.yaml:ro");
  });

  // Batch 2 review B F8: no process in either container may gain privileges through setuid or file capabilities. Caddy runs as root
  // in its image and keeps root's capabilities, and Docker 20.10 or newer lets a container bind low ports, so its 443 is expected to
  // survive (UNVERIFIED until Task 15's owner run).
  it("both services run with no-new-privileges", () => {
    expect(service(voice, "livekit")).toContain('security_opt: ["no-new-privileges:true"]');
    expect(service(voice, "caddy")).toContain('security_opt: ["no-new-privileges:true"]');
    expect(code(voice).filter((l) => l.trim().startsWith("security_opt:"))).toHaveLength(2);
  });

  it("both services restart on-failure:5", () => {
    expect(service(voice, "livekit")).toContain("restart: on-failure:5");
    expect(service(voice, "caddy")).toContain("restart: on-failure:5");
    expect(code(voice).filter((l) => l.trim().startsWith("restart:"))).toHaveLength(2);
  });

  it("the LiveKit API is published on 127.0.0.1 only; media ports use VOICE_MEDIA_BIND, TCP 7881 and UDP 7882", () => {
    const lk = service(voice, "livekit");
    const i = lk.indexOf("ports:");
    const ports = lk.slice(i + 1).filter((l) => l.startsWith("- \"")).map((l) => l.slice(3, -1));
    expect(ports).toEqual(["127.0.0.1:7880:7880", "${VOICE_MEDIA_BIND:?}:7881:7881/tcp", "${VOICE_MEDIA_BIND:?}:7882:7882/udp"]);
    // every published port of the file names its host address: none is published on every interface
    const allPorts = code(voice).map((l) => l.trim()).filter((l) => l.startsWith("- \"") && l.split(":").length >= 3);
    for (const p of allPorts) expect(p.startsWith("- \"127.0.0.1:") || p.startsWith("- \"${VOICE_MEDIA_BIND:?}:"), p).toBe(true);
  });

  it("caddy is only in the lan profile, with its files read-only and no secret", () => {
    const c = service(voice, "caddy");
    expect(c).toContain('profiles: ["lan"]');
    expect(code(voice).filter((l) => l.trim().startsWith("profiles:"))).toHaveLength(1);
    expect(c).toContain("- ./Caddyfile:/etc/caddy/Caddyfile:ro");
    expect(c).toContain("- ${VOICE_TLS_CERT_FILE:?}:/certs/cert.pem:ro");
    expect(c).toContain("- ${VOICE_TLS_KEY_FILE:?}:/certs/key.pem:ro");
    expect(c).toContain("- ${VOICE_STATE_DIR:?}/caddy-data:/data");
    // Batch 2 review B F9: the image declares /config a volume; a bind mount in the state directory means `down --remove-orphans`
    // leaves no anonymous volume behind (Task 7 creates caddy-config/ and caddy-data/ 0700 with the other folders).
    expect(c).toContain("- ${VOICE_STATE_DIR:?}/caddy-config:/config");
    const mounts = c.filter((l) => l.startsWith("- ") && l.includes(":/") && !l.startsWith('- "'));
    expect(mounts.map((l) => l.slice(l.lastIndexOf(":/") + 1).split(":")[0])).toEqual(["/etc/caddy/Caddyfile", "/certs/cert.pem", "/certs/key.pem", "/data", "/config"]);
    expect(c).toContain('- "${VOICE_MEDIA_BIND:?}:${VOICE_HTTPS_PORT:?}:${VOICE_HTTPS_PORT:?}"');
    expect(c).toContain('- "${VOICE_MEDIA_BIND:?}:${VOICE_LIVEKIT_TLS_PORT:?}:${VOICE_LIVEKIT_TLS_PORT:?}"');
    expect(c).toContain('extra_hosts: ["host.docker.internal:host-gateway"]');
    expect(c).toContain("depends_on: [livekit]");
    const env = c.slice(c.indexOf("environment:") + 1).filter((l) => /^VOICE_[A-Z_]+: /.test(l)).map((l) => l.split(":")[0]);
    expect(env).toEqual(["VOICE_HOSTNAME", "VOICE_HTTPS_PORT", "VOICE_LIVEKIT_TLS_PORT", "VOICE_WEB_UPSTREAM"]);
    for (const l of code(voice)) expect(l, l).not.toMatch(/LIVEKIT_API|SECRET|TOKEN|STT_URL/);
  });
});

describe("deploy/compose/livekit.yaml (US-0072, A1c Task 5)", () => {
  // Batch 2 review B F1: LiveKit's warn lines very probably carry room and participant identity as context fields (not verified), so
  // it logs at error (a level LiveKit's sample configuration lists: debug, info, warn, error); error lines may still name them (residual).
  it("logs at error, has no keys and no development flag, and the fixed ports", () => {
    const lines = code(livekitYaml).map((l) => l.trimEnd());
    expect(lines).toEqual([
      "port: 7880", "rtc:", "  tcp_port: 7881", "  udp_port: 7882", "  use_external_ip: false", "logging:", "  level: error",
    ]);
    for (const banned of ["keys", "key_file", "development", "turn", "redis", "webhook"]) expect(lines.join("\n"), banned).not.toContain(banned);
  });
});

describe("deploy/compose/Caddyfile (US-0072, A1c Task 5)", () => {
  const lines = code(caddyfile).map((l) => l.trim());
  /** The global options block: from the first line "{" to its closing "}" (the first line that is "}" at column 0). */
  const rawCode = code(caddyfile);
  const globalEnd = rawCode.indexOf("}");
  const globalBlock = rawCode.slice(0, globalEnd + 1).map((l) => l.trim());
  const sites = rawCode.slice(globalEnd + 1).map((l) => l.trim());

  it("caddyfile serves h1 and h2 only, with admin off and no redirect server", () => {
    expect(globalBlock.slice(0, 6)).toEqual(["{", "admin off", "auto_https disable_redirects", "servers {", "protocols h1 h2", "}"]);
    expect(lines.filter((l) => l.startsWith("protocols"))).toEqual(["protocols h1 h2"]);
  });

  // Batch 2 review B F1: Caddy's DEFAULT logger (stderr, INFO) writes every handler error to http.log.error with a `request` object
  // whose `uri` carries the query string; during a LiveKit outage each reconnect to /rtc?access_token=<JWT> is a 502 and would write
  // the token into the container log. The default logger deletes the token-bearing parameters livekit-client 2.23.0 sends
  // (`access_token`, and `join_request` / `sid`, which carry the participant's join data) from every logged request URI, and logs at
  // ERROR only. The filter is UNVERIFIED until Task 15's owner run (Caddy is never run here).
  it("caddyfile's default logger deletes the LiveKit token from every logged URI and logs errors only", () => {
    expect(globalBlock.slice(6)).toEqual([
      "log default {",
      "output stderr",
      "format filter {", "wrap json", "fields {",
      "request>uri query {", "delete access_token", "delete join_request", "delete sid", "}",
      "}", "}",
      "level ERROR",
      "}",
      "}",
    ]);
  });

  it("caddyfile has no access log or other log directive in a site (LiveKit tokens travel in the query)", () => {
    for (const l of sites) expect(l.split(" ")[0], l).not.toMatch(/^(log|access_log|skip_log|log_skip|log_append|log_name|debug)$/);
    expect(lines.filter((l) => l.split(" ")[0] === "log")).toEqual(["log default {"]);
    expect(lines.join("\n")).not.toContain("log_credentials");
  });

  it("caddyfile pins the X-Forwarded-For rules: no trusted_proxies, no X-Forwarded-* header directive", () => {
    const all = lines.join("\n").toLowerCase();
    expect(all).not.toContain("trusted_proxies");
    expect(all).not.toContain("x-forwarded");
    expect(all).not.toContain("client_ip_headers");
    expect(lines.filter((l) => l.startsWith("header_up"))).toEqual(["header_up -Cookie"]);
  });

  it("the web site forwards to the web upstream under the owner's certificate", () => {
    const i = lines.indexOf("{$VOICE_HOSTNAME}:{$VOICE_HTTPS_PORT} {");
    expect(i).toBeGreaterThan(0);
    expect(lines.slice(i + 1, i + 4)).toEqual(["tls /certs/cert.pem /certs/key.pem", "reverse_proxy {$VOICE_WEB_UPSTREAM}", "}"]);
  });

  it("the LiveKit site forwards /rtc* only, strips Cookie, and answers 404 otherwise", () => {
    const i = lines.indexOf("{$VOICE_HOSTNAME}:{$VOICE_LIVEKIT_TLS_PORT} {");
    expect(i).toBeGreaterThan(0);
    expect(lines.slice(i + 1)).toEqual([
      "tls /certs/cert.pem /certs/key.pem",
      "handle /rtc* {", "reverse_proxy livekit:7880 {", "header_up -Cookie", "}", "}",
      "handle {", "respond 404", "}",
      "}",
    ]);
    expect(lines.filter((l) => l.startsWith("reverse_proxy"))).toEqual(["reverse_proxy {$VOICE_WEB_UPSTREAM}", "reverse_proxy livekit:7880 {"]);
    expect(lines.filter((l) => l.startsWith("tls "))).toHaveLength(2);
  });
});

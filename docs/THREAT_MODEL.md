# Threat model (US-0017)

This is the threat model of the runtime server (`services/runtime`) for the text-based proof of concept. It says what the facilitator token and the connection limits protect, and, as exactly, what they do **not**. Read it before running the server on any network you do not fully trust.

## What is being protected

| Asset | Where it lives | Who may see it |
| --- | --- | --- |
| Role briefs and private facts | player `joined` message | that role only |
| Hidden facts, NPC goals and knowledge, Game Master reasoning, alerts | facilitator event stream | facilitators only |
| Whispers | facilitator and target role | those two |
| Participant names | server memory, session log | facilitators (log) |
| Session logs (`data/sessions/*.jsonl`) | disk | whoever can read the server's disk |
| Model API keys | `.env`, environment | the operator |

## Who might attack, and how

| Actor | Capability | Typical attempt |
| --- | --- | --- |
| LAN peer | can open a TCP connection to the port | join as facilitator, claim a player role, flood the server |
| A web page in a participant's browser | can open a WebSocket to `ws://<lan-ip>:8080` from the browser (cross-site WebSocket hijacking) | drive the server as the participant |
| A participant | already a legitimate player | escalate to facilitator to read other roles' secrets, hidden facts and GM reasoning |
| A network observer | can read traffic on the path | read the token and all session text |

## What the facilitator token does

Set `FACILITATOR_TOKEN` (16 to 256 printable ASCII characters, no spaces) and the server requires it in `join_facilitator`:

- **Refused, not served.** A missing, empty, wrong or truncated token gets the same generic `unauthorized` error and the connection is closed (WebSocket code 1008) after the first failed attempt: frames that were already queued or keep arriving on that connection are discarded (none is processed), the socket is terminated shortly after, and every such frame still counts against the address's failure budget. The reply does not say whether the token or the session id was wrong. A token longer than 256 characters is refused as a malformed message; a frame over 16 KiB closes the connection (1009).
- **Constant time.** Both values are hashed with SHA-256 and the digests are compared with `timingSafeEqual`, so neither the content nor the length of the real token leaks through timing.
- **Never logged or echoed.** The token is not in any log line, error, alert, event or message to any client. Startup errors about it name the variable and never show the value. The demo's checks (`F-28`, and `F-31` with `pnpm demo --security`) search logs, inboxes and narration for it.
- **Guessing is throttled.** More than 5 failed facilitator joins from one address within a minute block that address's new connections for a minute (HTTP 429). Behind a proxy this needs `TRUST_PROXY=1`, otherwise every client looks like the proxy.
- **Several facilitators.** Each facilitator connection needs the token (a co-facilitator is allowed).
- **It protects the facilitator stream and controls:** the full event view (whispers, NPC goals, hidden facts, GM reasoning, alerts) and the rights to start the session and send commands.

With `FACILITATOR_TOKEN` **unset the server stays open**: anyone who can reach the port can join as facilitator. The server prints one warning line at startup (it contains no secret) and tells each facilitator once, in the `joined` message (never to players). An EMPTY `FACILITATOR_TOKEN` in the real environment counts as unset, so it cannot switch off a token that `.env` holds; the real environment wins only when it has a value. The role id `facilitator` is reserved: a player cannot join as it and a scenario cannot define it. `./run.sh` generates a random token into a **new** `.env` only and never touches an existing `.env`. Refusing to start without a token on a non-loopback address is planned for a later release.

## Limits that apply to every client (token or not)

| Limit | Default | Setting |
| --- | --- | --- |
| Concurrent connections, all clients | 32 | `WS_MAX_CONNECTIONS` (1 to 10000) |
| Concurrent connections per address | 8 | `WS_MAX_CONNECTIONS_PER_IP` (1 to 10000) |
| Messages per second per connection | 5 | `WS_MSG_RATE` (1 to 1000) |
| Burst per connection | 20 | `WS_MSG_BURST` (1 to 10000) |
| Time to join after connecting | 10 s | `WS_JOIN_TIMEOUT_MS` (500 to 600000) |
| Messages waiting for the handler, per connection | 64 | fixed |
| Frame size | 16 KiB | fixed |
| Browser origins | none | `ALLOWED_ORIGINS` |

- Connection caps and the Origin check are applied at the HTTP upgrade, before a WebSocket exists: a refused client costs one small HTTP response (503 over a cap, 403 for an Origin that is not allowed, 429 for a blocked address).
- **Origin.** A handshake that carries an `Origin` header (a browser always does) is refused unless it is listed. The terminal client and the demo bots send none and are unaffected. This stops a web page in a participant's browser from driving the LAN server.
- **Rate limit.** Each connection has its own token bucket. Over the limit a message is dropped with `rate_limited`; three drops within 10 seconds, or more than 64 messages waiting for the handler, close that connection (1008). One client's flood does not use another's budget.
- **Join timeout.** A connection that does not join in time is closed, which also bounds idle and slow-drip ("slowloris") sockets. Raw TCP sockets are bounded too: at most twice `WS_MAX_CONNECTIONS_PER_IP` open sockets (idle or half-open included) per address (not applied behind `TRUST_PROXY=1`, where every client shares the proxy's address), an overall socket limit, and a 10 s header and request timeout (checked every second). One address that hogs its own sockets is refused or dropped; other addresses are unaffected. Per-address state is keyed by IPv4 address or IPv6 /64, and the failed-login table is bounded (10,000 addresses, oldest evicted), including under forged `X-Forwarded-For` values.
- The per-address caps are weak where many people share one address (Docker Desktop, NAT, a proxy): raise them, or use `TRUST_PROXY=1` behind a proxy you control.
- **`TRUST_PROXY=1` is only safe when clients cannot reach the server directly**: otherwise anyone can forge `X-Forwarded-For` and dodge the per-address limits. The server warns at startup if `TRUST_PROXY=1` is combined with a non-loopback `RUNTIME_HOST`. Behind a proxy on the same machine bind `RUNTIME_HOST=127.0.0.1` (plain start) or, with Docker Compose, publish on loopback only (`ports: ["127.0.0.1:${HOST_PORT:-8080}:8080"]`; the container itself keeps `RUNTIME_HOST=0.0.0.0`, which the compose file pins).

## What the token does NOT protect

1. **No TLS.** The server speaks plain `ws://`. The token, every message and all session text travel in clear text, so anyone who can observe the network path can read the token and replay it. For anything beyond a trusted switch, put a TLS reverse proxy (for example Caddy or nginx) in front, serve `wss://`, bind the runtime to loopback with `RUNTIME_HOST=127.0.0.1` and set `TRUST_PROXY=1`. Do not put the token in a URL query: proxies log URLs. The client sends it in the first message.
2. **Unclaimed player roles.** The token does not protect player roles. Anyone who can reach the port can claim an unclaimed player role and read its brief and private facts. A role held by a live connection can only be taken over with its reconnect token, but **a role is freed when its connection closes** (including a crash or server restart), after which anyone can claim it. Per-role join codes are a separate planned story (US-0033).
3. **Logs at rest.** Session logs under `data/sessions/` hold everything the facilitator sees, including whispers, NPC internals and hidden facts if released, in clear text. The token does not protect them; protect the disk and the folder (and keep `.env` private: `run.sh` creates it with mode 600).
4. **The model provider.** Scenario text, prompts and dialogue are sent to whichever provider you configure. The token says nothing about that.
5. **Denial of service beyond the caps.** The limits bound what one address or connection can cost. A large botnet, a saturated network link or a host-level flood is out of scope.
6. **A participant who already holds the token**, or a facilitator machine that is compromised.
7. **Token theft from the environment.** `FACILITATOR_TOKEN` is readable by the user running the server, in the process environment and in `.env`. The terminal client takes it from the same variable, from `--token-file <path>` (read with a 1 KiB cap; a warning is printed if the file is readable by group or others) or from a hidden prompt, and never from the command line, because command lines show up in `ps` and shell history. The client warns once when it is about to send a token over plain `ws://` to a non-loopback host.

## Operating guidance

- Always set a token off a trusted network; use a TLS reverse proxy when the path is not trusted.
- Rotate the token by changing `.env` and restarting; sessions in progress end with the restart.
- Keep `ALLOWED_ORIGINS` empty unless you serve a browser client.
- Treat session logs and `.env` as confidential.

## Review

Re-read this document when a web client, voice, persistent accounts, session resume (US-0018) or per-role join codes (US-0033) are added: each changes what can be claimed and by whom.

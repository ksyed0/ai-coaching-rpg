# AI Coaching RPG

Script-driven, multiplayer role-play training with AI counterparts.

A small team plays a scripted workplace scenario in real time. Some roles are played by people, the rest by AI characters (NPCs). A **Game Master** model watches the conversation, fires timed events and moves the scene forward. Everything that happens is recorded as an append-only event log, so a session can be replayed and, in a later release, scored against a rubric.

> **Status: proof of concept (Slice 1).** Three people on one local network play the *Friday Escalation* scenario in text from a terminal. There is no voice, no web or Teams client and no scoring. Facilitator access can be protected with a token, but there is no TLS and player roles are not protected: see [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) and [Known limitations](#known-limitations).

## How it works

| Piece | What it does |
| --- | --- |
| **Scenario** | A folder of YAML (`scenarios/<name>/`): metadata, roles (player or NPC), and a script of scenes with time boxes, injects and exit conditions. Validated on load. |
| **Runtime** | Hosts one session. Owns the event log and the scene state machine. |
| **NPC agents** | One per AI-played role. They answer on the fast path, seeing only what their role is allowed to see. A model call that stalls falls back to the character's scripted line. |
| **Game Master** | Runs beside the conversation: fires timed injects, judges scene exit conditions with the model, and advances the scene. |
| **Terminal client** | `pnpm play`: players speak by typing; the facilitator controls the session with slash commands. |
| **Model adapters** | All model access goes through one `ModelProvider` interface with a scripted mock (used by every test and the default) and an Anthropic implementation. Nothing outside `packages/adapters` imports a provider SDK (enforced by `pnpm lint:sdk`). |

Design details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements

- **Node.js 22 or newer** (`.nvmrc` pins 22)
- **pnpm 9** (`npm install -g pnpm@9`)
- **Docker** (optional, only for the one-command Docker start)
- A model (optional; without one the NPCs use a scripted mock): an **Anthropic API key**, an **OpenRouter API key**, or a **local OpenAI-compatible server** such as Ollama or LM Studio

## Install

```bash
git clone https://github.com/ksyed0/ai-coaching-rpg.git
cd ai-coaching-rpg
pnpm install
cp .env.example .env        # defaults to MODEL_PROVIDER=mock, no key needed
```

To use a real model for the NPCs and Game Master, edit `.env` and pick one of four providers with `MODEL_PROVIDER`:

```bash
# Anthropic (optionally behind your own endpoint/proxy: ANTHROPIC_BASE_URL=https://proxy.example.com/anthropic)
MODEL_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...

# OpenRouter
MODEL_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...

# A local OpenAI-compatible server (see "Local models" below); the models are required
MODEL_PROVIDER=local
LOCAL_BASE_URL=http://localhost:11434/v1
NPC_MODEL=llama3.1
GM_MODEL=llama3.1
```

`mock` (the default) needs nothing. `.env` is git-ignored. Never commit it. API keys are never logged; the startup log shows only the provider and whether a custom endpoint is configured.

**Privacy:** prompts (scenario text, role briefs and player lines) are sent to whatever endpoint you configure, so a remote provider such as Anthropic or OpenRouter sees them. Use `local` to keep them on your own machines.

### Local models

Any server that speaks the OpenAI chat-completions API with streaming works (Ollama, LM Studio, vLLM, the llama.cpp server). Set `LOCAL_BASE_URL` to its `/v1` URL and name the model in `NPC_MODEL` and `GM_MODEL` (there is no default, because model ids are server-specific). `LOCAL_API_KEY` is optional; set it only if your server wants a token (it is sent as `Authorization: Bearer ...`).

```bash
# Ollama (ollama pull llama3.1)
MODEL_PROVIDER=local
LOCAL_BASE_URL=http://localhost:11434/v1
NPC_MODEL=llama3.1
GM_MODEL=llama3.1

# LM Studio (start its local server; use the model id it shows)
MODEL_PROVIDER=local
LOCAL_BASE_URL=http://localhost:1234/v1
NPC_MODEL=<model id from LM Studio>
GM_MODEL=<model id from LM Studio>
```

Tip: pick a model that follows instructions well and streams; the Game Master must answer in a strict format, and small models often do not. A server that ignores streaming and returns one JSON object also works.

**Docker:** inside the container `localhost` is the container itself, not your machine, so use `LOCAL_BASE_URL=http://host.docker.internal:11434/v1`. Only `LOCAL_BASE_URL` accepts that URL: `ANTHROPIC_BASE_URL` and `OPENROUTER_BASE_URL` are rejected by design when they point at `http://host.docker.internal...` (plain http is only allowed for localhost, 127.0.0.1 and [::1]; remote providers must use https). The compose file maps `host.docker.internal` to the host gateway (`extra_hosts`). What that reaches depends on your setup (general guidance):

- **Docker Desktop and OrbStack:** `host.docker.internal` reaches services bound to the host's loopback, so Ollama's default `127.0.0.1` bind works with no `OLLAMA_HOST` change.
- **Plain Docker Engine on Linux:** `host-gateway` resolves to the docker0 bridge address (usually `172.17.0.1`), so a loopback-only server is unreachable. Bind it to the bridge address (for Ollama, `OLLAMA_HOST=172.17.0.1:11434`). If you must bind `0.0.0.0`, remember that this exposes an unauthenticated model API to your whole network; firewall port 11434 to the Docker subnet. Host firewalls (ufw, firewalld) may also drop container-to-host traffic.
- **LM Studio** in that Linux case needs "serve on local network", with the same exposure caveat.

## Run

### 1. Start the server (one laptop)

```bash
./run.sh --dev      # runs the server directly with tsx (no Docker), restarts on change
./run.sh            # or run it in Docker on port 8080
./run.sh --help     # usage
```

`./run.sh` creates `.env` from `.env.example` if it is missing (mock model, no key needed) and writes a random `FACILITATOR_TOKEN` into that **new** file (it never changes an existing `.env`, and never prints the token: read it from `.env`). `--dev` uses `tsx watch`, so it restarts (and rotates the live session log, see [Known limitations](#known-limitations)) on every source change. It needs Node 22+ and pnpm and prints an error if either is missing; the Docker start needs Docker with the `docker compose` plugin. The Docker start rebuilds the image on each start (Docker caches unchanged layers), so there is no separate build step.

The server listens on `0.0.0.0:8080` (set `RUNTIME_PORT` to change it with `--dev`) and loads the *Friday Escalation* scenario. **It listens on all network interfaces on purpose, so teammates on your LAN can join** (`RUNTIME_HOST=127.0.0.1` binds loopback only). **With `FACILITATOR_TOKEN` unset the server is OPEN: anyone who can reach the port can join as facilitator, and it prints a warning at startup.** Set a token for anything but a trusted desk (a `.env` made by `./run.sh` already has one). The token travels in clear text (no TLS: use a TLS reverse proxy off a trusted network) and does not protect player roles. Read [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for exactly what it does and does not cover.

Docker notes:

- `.env` is passed to the container at run time and is never baked into the image. In Docker the server always listens on 8080 inside the container; to publish a different host port run `HOST_PORT=9000 ./run.sh`.
- Session logs are written to `./data/sessions/` on the host (bind mount). The container runs as the non-root user that invoked `./run.sh` (`HOST_UID`/`HOST_GID`), so the logs are owned by you. If you start it with plain `docker compose` on Linux instead, set `HOST_UID`/`HOST_GID` yourself (default 1000:1000) or the container may not be able to write to `./data`.
- Docker Compose reads `.env` with its own rules (quotes, `$` interpolation, inline `#`), which differ slightly from the app's own parser used by `./run.sh --dev`. Keep API keys free of `$`, `#` and quotes, or quote them per Compose rules.
- If `./run.sh` is run as root it starts the container as 1000:1000 instead (unless `HOST_UID`/`HOST_GID` are set), so `./data` must be writable by that user.
- The `scenarios/` folder is mounted read-only into the container, so you can edit a scenario and just restart.

### 2. Connect the participants

In separate terminals, on the same machine or any machine on the same network (use the host's IP in `--url`):

```bash
pnpm play --facilitator     # with a token-protected server: see below
pnpm play --role delivery_lead   --name Kamal --url ws://<host-ip>:8080
pnpm play --role tech_lead       --name Alex  --url ws://<host-ip>:8080
pnpm play --role account_manager --name Sam   --url ws://<host-ip>:8080
```

The client sponsor (`client_sponsor`) is played by an AI.

**Facilitator token.** If the server has a `FACILITATOR_TOKEN`, the facilitator client needs it, taken from (in this order) the `FACILITATOR_TOKEN` environment variable, `pnpm play --facilitator --token-file <path>` (read with a 1 KiB cap; a warning is printed if the file is readable by group or others, `chmod 600` it), or a hidden prompt when you are on a terminal (press Enter if the server has none). The client warns when the token would go over plain `ws://` to another machine. There is deliberately no `--token <value>` option: command lines are visible in `ps` and kept in shell history. A wrong or missing token gets `unauthorized` and the connection is closed. Players need no token. The server drops messages from a client that sends more than `WS_MSG_RATE` per second (burst `WS_MSG_BURST`), so do not paste hundreds of lines at once.

### 3. Play

Players just type to speak. Lines starting with `/` are never spoken in character (a mistyped command is not sent as speech); `/help` lists commands, `/quit` leaves.

The facilitator drives the session:

| Command | Effect |
| --- | --- |
| `/start` | Begin the session once everyone has joined (players cannot start it) |
| `/pause`, `/resume` | Pause or resume; while paused, nothing can be said |
| `/advance` | Move to the next scene |
| `/inject <id>` | Fire a scripted inject now |
| `/whisper <role> <text>` | Send a private message to one player role (NPC roles are refused) |
| `/hidden` | List each AI character's hidden facts, numbered, with `[released]` on the ones already released (local: nothing is sent) |
| `/release <role> <n>` | Release hidden fact number `n` (as `/hidden` numbers them, from 1) of an AI character |
| `/quit` | Disconnect |

**Releasing a hidden fact (US-0016).** An AI character's `hidden` facts are never in its prompt until you release one: `/hidden` shows them (the server sends the list in the facilitator's `joined` message only, so it is behind `FACILITATOR_TOKEN` when one is set), and `/release cfo 1` releases the first. The same 1-based number is used by the protocol (`{"command":"release_hidden","roleId":"cfo","fact":1}`, `fact` 1 to 50), the engine and the terminal client. The server refuses an unknown role, a player role, a number the character has no fact for (`unknown_fact`) and a fact that is already released (`already_released`); nothing is appended then. A release records a `facilitator.command` event that names the role and the number but holds no fact text, followed by a facilitator-only `npc.updated` that carries the text (two appends: the `npc.updated` is the source of truth, a command without it is an orphan that changed nothing, and releasing again is accepted); players receive neither event and their snapshot has no NPC state. From the character's next turn the fact is in a separate last prompt section, `## What you may now share` ("The rules above about hidden information no longer apply to the facts in this section: you have been cleared to share them. Share them when they are relevant or when you are asked", so it overrides the character's own withholding guardrail), in that character's prompt only (never another character's, a player's or the Game Master's); a model may still choose to withhold it. A release works while paused, takes effect on the character's next turn, and cannot be undone (what was said cannot be unsaid). The terminal client prints `[facilitator] released hidden fact #1 of cfo` and `[npc cfo] released #1: <text>` to the facilitator only. A character may have at most 50 hidden facts, each non-empty, at most 1000 characters and different from the others of that character (the scenario loader refuses duplicates); the client lists at most 200 facts and clips each to 1000 characters. `__proto__`, `constructor` and `prototype` are refused as role and scene ids. Having the Game Master suggest a release is a separate story (US-0034).

Each session is recorded to `data/sessions/<session-id>.jsonl` (the facilitator is not a role: the facilitator watches and controls, and cannot speak). A facilitator command sent before `/start` also starts the session.

### Configuration

All settings are environment variables (read from `.env` at the repository root; real environment variables win).

| Variable | Default | Meaning |
| --- | --- | --- |
| `MODEL_PROVIDER` | `mock` | `mock`, `anthropic`, `openrouter` or `local` |
| `ANTHROPIC_API_KEY` | – | Required when `MODEL_PROVIDER=anthropic` |
| `ANTHROPIC_BASE_URL` | Anthropic's API | Optional custom endpoint or proxy; `https:` (or `http:` on localhost); no `/v1` |
| `OPENROUTER_API_KEY` | – | Required when `MODEL_PROVIDER=openrouter` |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Optional; `https:` (or `http:` on localhost) |
| `LOCAL_BASE_URL` | – | Required when `MODEL_PROVIDER=local`; `http:` or `https:`, e.g. `http://localhost:11434/v1` |
| `LOCAL_API_KEY` | – | Optional token for `local`; sent only when set |
| `NPC_MODEL`, `GM_MODEL` | `claude-sonnet-5-5` (anthropic), `anthropic/claude-sonnet-5.5` (openrouter) | Model for NPC replies / the Game Master. Blank uses the default. **Required for `local`** (no default) |
| `RUNTIME_PORT` | `8080` | Port the server listens on |
| `RUNTIME_HOST` | `0.0.0.0` | Interface to bind: an IP address or host name. Use `127.0.0.1` behind a reverse proxy on the same machine |
| `FACILITATOR_TOKEN` | – (server open, with a startup warning and a note to each facilitator) | Token `join_facilitator` must present: 16 to 256 printable ASCII characters, no spaces. An invalid value stops startup with an error that names the variable and never shows the value; an empty value in the real environment counts as unset, so `.env` still applies. `./run.sh` writes a random one into a new `.env` |
| `WS_MAX_CONNECTIONS` | `32` | Concurrent connections, all clients. Whole number, `1` to `10000`. Over it a handshake gets HTTP 503 |
| `WS_MAX_CONNECTIONS_PER_IP` | `8` | Concurrent connections per client address. `1` to `10000`. Behind Docker Desktop, NAT or a proxy many people share one address: raise it |
| `WS_MSG_RATE` | `5` | Messages per second per connection. `1` to `1000`. Over the limit messages are dropped (`rate_limited`); a client that keeps going is closed |
| `WS_MSG_BURST` | `20` | Messages one connection may send at once. `1` to `10000` |
| `WS_JOIN_TIMEOUT_MS` | `10000` | A connection that has not joined in this time is closed. `500` to `600000` |
| `ALLOWED_ORIGINS` | none | Comma separated browser origins (`https://play.example.com`) allowed to connect. A handshake with any other `Origin` header gets HTTP 403; the terminal client and the demo bots send none |
| `TRUST_PROXY` | `0` | `1` reads the client address for the per-address limits from the last `X-Forwarded-For` entry. Only safe when clients cannot reach the server directly (bind `RUNTIME_HOST=127.0.0.1`, or publish the Docker port on loopback: `ports: ["127.0.0.1:${HOST_PORT:-8080}:8080"]`); the server warns if the host is not loopback |
| `NPC_FIRST_TOKEN_TIMEOUT_MS` | `10000` | Milliseconds an NPC waits for the model's first token before speaking its scripted fallback line and alerting the facilitator. Whole number, `500` to `600000` |
| `NPC_REPLY_TIMEOUT_MS` | `20000` | Milliseconds allowed for a whole NPC reply (stalls after the first token included). Whole number, `500` to `600000`, and **must be at least `NPC_FIRST_TOKEN_TIMEOUT_MS`** |
| `NPC_MAX_TOKENS` | `600` | Token budget (`max_tokens`) for one AI character reply. Reasoning models spend part of it thinking before they answer. Whole number, `50` to `4000` |
| `GM_MAX_TOKENS` | `400` | Token budget for one Game Master verdict. Whole number, `50` to `4000` |
| `GM_TIMEOUT_MS` | `max(NPC_REPLY_TIMEOUT_MS, 60000)` | Deadline of one Game Master evaluation: the model call with its transient-error retries **and** the one re-ask. Whole number of milliseconds, `500` to `600000` |
| `GM_REASK` | `1` | `1` asks the model once more when its reply holds no usable verdict (the bad reply is echoed back with "reply with only the JSON object"); `0` turns the re-ask off |
| `GM_EVERY_N_UTTERANCES` | `3` | The Game Master judges each `gm_detects` condition after this many new utterances in a scene. Whole number, `1` to `20` |
| `GM_TRACE_FILE` | off | A file (relative paths are under `data/sessions/`) that records every raw Game Master reply and how it was read, one JSON line each, created with mode `0600`. It holds model replies about the whole conversation: facilitator-grade data, never in the session log. Replay it with `pnpm gm-eval --trace <file>` |
| `NPC_TEMPERATURE` | `0.8` | Sampling temperature for AI character replies (sent as `temperature` to Anthropic and OpenAI-compatible providers). A decimal, `0` to `2`; a little randomness keeps characters from repeating themselves |
| `PLAYER_TEMPERATURE` | `0.9` | Sampling temperature for the demo's generated player bots (`--players generated`). A decimal, `0` to `2` |
| `GM_TEMPERATURE` | `0.2` | Sampling temperature for Game Master verdicts (low, for steadier JSON). A decimal, `0` to `2` |
| `EVAL_MODEL` | the NPC model | Model for the post-session evaluator (`pnpm evaluate`, `--evaluate`). See [docs/EVALUATOR.md](docs/EVALUATOR.md) |
| `EVAL_MAX_TOKENS`, `EVAL_TEMPERATURE` | `3000`, `0.2` | Token budget (`200` to `8000`) and temperature (`0` to `2`) per evaluator call |
| `EVAL_TIMEOUT_MS` | `180000` | Deadline per evaluator call, `500` to `600000`; the effective value is `max(EVAL_TIMEOUT_MS, NPC_REPLY_TIMEOUT_MS)` (no other floor) |
| `EVAL_TRANSCRIPT_CHARS` | `60000` | Hard cap on the transcript (characters) sent in one evaluator call; a longer one is trimmed and the report says so |
| `MODEL_MAX_RETRIES` | `2` | How many times a transient model error is retried (so up to 3 attempts) before the NPC speaks its fallback line. Whole number, `0` to `5`; `0` turns retrying off |
| `MODEL_RETRY_BASE_MS` | `500` | First retry delay in milliseconds; it doubles per retry (capped at 4 s) with +/-25% jitter. Whole number, `100` to `10000` |
| `SCENARIO_DIR` | `scenarios/friday-escalation` | Scenario folder (relative paths resolve from the repository root) |
| `SESSION_ID` | `local` | Session id clients join (`--session`) |
| `DEPLOYMENT_STAGE` | `local` | Present in `.env.example` but not read by the code yet |
| `RUN_LIVE_MODEL_TESTS` | unset | Set to `1` (with a key) to run the live-API contract tests. Costs money; off by default |

**When to raise the NPC timeouts.** The defaults suit fast chat models. Raise `NPC_FIRST_TOKEN_TIMEOUT_MS` (and `NPC_REPLY_TIMEOUT_MS` with it, since the reply deadline must be at least as long) for reasoning models that think before the first token, free-tier OpenRouter models that queue requests, and slow local models (for example a large model on CPU with Ollama). If NPCs keep answering with their canned fallback line and the facilitator sees "no first token" alerts, the timeout is too short for your model. Values must be plain whole numbers of milliseconds (`15000`, not `15s` or `1.5e4`); an invalid value stops startup with an error naming the variable.

**Reasoning models and empty replies.** A reasoning model (for example Qwen3 on a local server) writes its thinking first and only then the answer. The thinking is never shown to players and is never streamed to the runtime as dialogue, so the whole thinking phase has to finish inside `NPC_FIRST_TOKEN_TIMEOUT_MS`, and the whole reply inside `NPC_REPLY_TIMEOUT_MS`. Two things can go wrong. If `NPC_MAX_TOKENS` / `GM_MAX_TOKENS` is too small the model runs out of tokens while still thinking and returns no answer; the runtime recognises this (the server sends the thinking as `reasoning_content` or `reasoning`, or ends an empty reply with `finish_reason: length`), retries it like a transient error, and if it still fails the facilitator sees "empty reply: reasoning budget exhausted". But a bigger budget alone does not fix things: it lengthens the thinking phase, so raise the timeouts with it. As a rule of thumb the first-token timeout must cover about `NPC_MAX_TOKENS` divided by the model's tokens per second (600 tokens at 20 tokens per second is 30 s, so `NPC_FIRST_TOKEN_TIMEOUT_MS=40000` and `NPC_REPLY_TIMEOUT_MS=60000`). If the server stops normally after only thinking, the facilitator sees "the model returned only reasoning and no answer" and a budget change will not help (check the server's reasoning-parser settings). A reply that starts with an inline `<think>...</think>` block (a server without a reasoning parser) has that block removed.

### Retries

A brief capacity blip should not turn into a canned line, so live model calls (the AI characters and the Game Master) are retried when the failure is **transient** and **nothing has been said yet**:

- **Retried:** HTTP 429 (rate limit; a `Retry-After` header is honored, up to 10 s per retry), 500, 502, 503, 504, 529 and 408, an in-band error that says overloaded, rate limit, capacity, "try again" or unavailable (some providers send these inside a 200 response or, for Anthropic, as an `overloaded_error` stream event), and a connection failure such as a reset, refusal or timeout.
- **Not retried:** 401 and 403 (bad key), 404 (unknown model), 400 and 422 (bad request), a 429 that says the quota, credit or billing limit is used up, any other error, an error after the first piece of text has arrived (a partial reply is never repeated or spliced), and a stop caused by a deadline or by shutting down.
- **Settings:** `MODEL_MAX_RETRIES` (default 2, so at most 3 attempts) and `MODEL_RETRY_BASE_MS` (default 500). The wait before retry *n* is the base times 2 to the power *n*-1, with +/-25% jitter, capped at 4 s (or at the base itself when you set a base above 4 s); with the defaults that is about 0.5 s, then 1 s. A longer `Retry-After` (up to 10 s) wins. Set `MODEL_MAX_RETRIES=0` to disable retrying. Invalid values stop startup with an error naming the variable.
- **Deadlines still rule.** The retries happen inside the deadlines: an NPC reply stops at `NPC_FIRST_TOKEN_TIMEOUT_MS` / `NPC_REPLY_TIMEOUT_MS`, and the Game Master's model call has its own deadline (`GM_TIMEOUT_MS`, default `max(NPC_REPLY_TIMEOUT_MS, 60 s)`; the one re-ask runs inside it). When a deadline fires during a backoff wait the retrying stops at once (the character speaks its fallback line, or the Game Master records no verdict) and the alert says how many attempts were made and the last error. So retries never make a reply later than the deadline you configured; the worst case without a deadline would be the number of attempts times a 10 s `Retry-After`, and the deadline cuts it. If you shorten the timeouts, fewer retries fit.
- **What you see:** a successful retry looks like a normal reply (the host's log has one line such as `NPC model call: overloaded (HTTP 503), retrying in 480 ms`, with no message text, URL or key). When the attempts run out, the facilitator alert says how many were made and why the last failed, for example `NPC cfo: model error after 3 attempts (overloaded): ...; used fallback line`, and for the Game Master `GM: model error after 3 attempts (overloaded) for "<condition>": ...`.
- **A model server that is simply off:** a refused connection counts as transient, so the character waits up to `MODEL_MAX_RETRIES` backoffs (about 1.5 s with the defaults) before speaking its fallback line.
- **Anthropic:** the Anthropic SDK retries 429 and 5xx on its own (twice, waiting up to 60 s, and not abortable). When the runtime wraps the provider (always, except for the scripted mock) the SDK's own retries are switched off with a per-request `maxRetries: 0`, so only one layer retries and a call makes at most `1 + MODEL_MAX_RETRIES` requests. The scripted mock provider used by the offline demo and the tests is never retried.

## Demo and test runner

`pnpm demo` plays the whole *Friday Escalation* by itself and checks the system's features while it does. A facilitator bot and three player bots (`delivery_lead`, `tech_lead`, `account_manager`) connect over real WebSockets to a server the runner starts in-process; the AI character is `client_sponsor`. It prints a narrated transcript in acts and ends with a pass/fail checklist. Nobody has to touch the keyboard.

```bash
pnpm demo                      # watchable: about 30 seconds of paced narration, mock models, offline, free
pnpm demo --fast               # the same run without pacing delays (about a second)
pnpm demo --speed 2            # pacing 2x faster (0.1 to 20); --fast and --speed cannot be combined
pnpm -s demo --fast --json -   # JSON report on stdout, narration on stderr (-s keeps pnpm's own banner out of stdout)
pnpm demo --fast --json out.json   # JSON report to a file (a relative path is relative to where you ran pnpm)
pnpm demo --live               # use the real configured model provider (see the warning below)
pnpm demo --url ws://localhost:8080 --fast   # smoke-test a server that is already running
pnpm demo --showcase --fast    # the longer scenario: AI characters and the Game Master do substantial work (see Showcase below)
pnpm demo --fast --transcript demo.md   # also write a Markdown transcript (every mode; see Markdown transcript below)
pnpm demo --help
```

Other flags: `--session <id>` (default `demo`, or `local` with `--url`), `--watchdog <minutes>` (real-time limit, 1 to 180; the default run keeps 2 minutes in mock mode and 10 with `--live`) and `--no-color`. Colour is used only on a terminal, with `NO_COLOR` unset and no `--no-color`. Everything a server, participant or model wrote goes through the same sanitiser as the terminal client, so hostile text cannot put control characters on your screen.

**Exit codes.** `0` when every check that ran passed (checks skipped because of the mode, `--live` or `--url`, do not count against it); `1` when a check failed, the run hit an unexpected error or the real-time watchdog fired (2 minutes in mock mode, 10 minutes with `--live`); `2` for a usage error; `130` / `143` when interrupted with Ctrl-C (SIGINT) / SIGTERM (the run aborts, closes its servers and sockets and removes its temp directory first). In every mode a check that did not run, other than the intended mode skips (`--live`, `--url`), counts as a failure, never as a quiet skip. Against a server that floods the client (more than 5,000 frames) or sends a frame above 1 MiB, the run fails cleanly instead of consuming memory.

### What each mode verifies

- **Default (mock).** Scripted models and a fake clock make the run deterministic, so all 29 checks run: the lobby rules (taken, NPC and unknown roles, who may start), scene flow and the timed inject at exactly minute 7, the AI character answering once per line and staying silent where it is absent, the Game Master exiting a scene, re-asking a malformed reply once and then recording it as `gm.no_verdict` (never a decision), and refusing stale verdicts, pause/resume, advance, whispers, per-player isolation (every player's whole inbox is audited against strings taken from the scenario files, and every model prompt is audited for the rubric, other roles' secrets, hidden facts and names), hostile and oversized frames, terminal safety, reconnecting with the token, a client that stops answering pings, log rotation on restart, and the on-disk event log. A short side room (a second in-process server) covers the failure paths a main run cannot wait for: a stalled model, an empty reply and the dead client.
- **`--live`.** Uses the provider you configured (`MODEL_PROVIDER`, read from `.env` and the environment, **only** when you pass `--live`). It refuses with exit code 2 if the provider resolves to `mock`. **This sends the scenario text and the scripted lines to that provider and may cost money**; the run prints only the provider's label and whether a custom endpoint is used, never keys or URLs. Model output is not deterministic, so the scripted-content checks (the timed inject, Game Master verdicts, prompt capture) are marked `skipped (live mode)`, the facilitator's `advance` drives the scenes, and the NPC check accepts any non-empty reply or the fallback line.
- **`--security`.** Adds three checks to the default run (32 in all; plain `pnpm demo` keeps its 29), played in a security room of two extra in-process servers (not with `--url` or `--showcase`): `F-31` a missing, empty, wrong, truncated and over-long token is refused and closed and the right one joins, six wrong guesses block that address, and the token reaches no client, log or line of output; `F-32` a client that floods the server is told `rate_limited` and closed while another client's lines arrive unchanged; `F-33` the per-address and total connection caps (503), the Origin check (403) and the join timeout. The ordinary servers in the run have no token and generous limits, so nothing else changes. CI runs it as an extra step.
- **`--url ws://host:port`.** Starts no server; runs the externally observable subset (join, start, speech, the NPC reply, whisper and private-event isolation, pause/resume, advance, reconnect with the token, hostile frames, terminal safety) against a running one and marks the checks that need control of the process (fake clock, prompt capture, restart and log rotation, heartbeat, the log file) as `skipped (needs in-process server)`. It checks structure, not content: an NPC reply is "non-empty or the fallback line". The server must allow facilitator joins (open, or export its `FACILITATOR_TOKEN` in the same environment: the demo sends it in `join_facilitator` and never prints it) and must have a **fresh** session (the runner starts it), so restart the server between runs. The URL must be `ws:` or `wss:` with no credentials, query or fragment. **Only point it at a throwaway server with a fresh session: the run drives the target's real session to its end (`script_complete`), after which that session cannot be resumed, and everything it sends goes into the target's permanent event log.** It first prints exactly what it will do: a facilitator join and the commands start, pause, resume, advance and whisper; scripted player lines (one containing an escape sequence and a forged newline, and speech while paused); role-claim attempts (taken, NPC and unknown roles), forged-token takeover attempts and a rejoin with the real token; player-issued start and pause, speech before the start, a facilitator say, speech from a role that is absent from the scene, speech and a resume command after the session ends, speech before joining and a whisper to the NPC role (all expected to be refused); malformed frames and one oversized (~70 kB) frame. Combined with `--live`, content checks are skipped as well, and the notice reminds you that the server's own provider receives the text.

A Docker smoke test: start the container, run the demo against it, restart it before the next run. This was verified with the image built from `deploy/compose/Dockerfile.runtime` and started as `docker run -d --rm --name acr-demo -e MODEL_PROVIDER=mock -p 18080:8080 <image>`, then `pnpm demo --url ws://localhost:18080 --fast` (17 checks passed, 12 skipped) and `docker restart acr-demo` before a second run. The `./run.sh` route (which uses your `.env`, so a real provider there would receive the scenario text) was not exercised for this.

### Reading the checklist

Each feature has an id (`F-01` to `F-29`), a title and one line of evidence. `✓` passed, `✗` failed (the evidence says why), `–` skipped (the evidence says why: `live mode`, `needs in-process server` or `prerequisite failed`). A failed check does not hide the others; checks that depend on it are skipped, not faked. The JSON report has the same content: `{ tool, version, mode, startedAt, durationMs, summary: { passed, failed, skipped }, results: [{ id, title, status, details, durationMs }] }`. It contains no secrets, no environment values and no paths from your home or temp directories. CI runs `pnpm demo --fast --json demo-report.json` and then `pnpm demo --showcase --fast --json demo-showcase-report.json --transcript demo-transcript.md` as the (non-required) "Demo Run" job and uploads the reports and the transcript.

An excerpt of a real run (`pnpm demo --fast --no-color`); `...` marks lines left out:

```text
ACT 3 · Scene 2: Call with Priya
  ...
  facilitator: pause
  delivery_lead tries to speak while paused: refused (paused)
  facilitator: resume
  tech_lead is not on the client call and cannot speak into it (not_in_scene)
  clock at 6:59, one second before the inject
  clock at 7:00
  inject cfo_pressure fires now (addressed only to client_sponsor)
  account_manager: We can phase the module after go-live and price it properly.
  Priya Raman (client_sponsor): I hear you. What would phasing actually look like for Finance?
  ✓ F-07 cfo_pressure was absent at 6:59 and fired at 7:00; its goal reached the NPC's next prompt
  ...
Checklist
  ...
  ✓ F-07  The timed inject fires at its fake-clock minute, not before
      cfo_pressure was absent at 6:59 and fired at 7:00; its goal reached the NPC's next prompt
  ...
  ✓ F-18  Players never receive facilitator-only events, other roles' secrets or participant identities
      100 messages in 3 players' whole inboxes audited against 54 real scenario strings, 7 names and scene/inject scopes: nothing leaked
  ...
Summary: 29 passed, 0 failed, 0 skipped (mock mode, 0.9 s)
```

### Scoring and feedback

After a session, the evaluator drafts feedback from the recorded log: a score per criterion for each player and for the team, learning-objective results, a personal report per player (strengths, development points, 2 to 3 next actions tied to learning objectives) and a group report with talking points for the facilitator. Full details are in [docs/EVALUATOR.md](docs/EVALUATOR.md).

```bash
pnpm evaluate data/sessions/local.jsonl                 # reports in data/reports/local/ (index.md links them all)
pnpm evaluate <session.jsonl> [--scenario <dir>] [--out <dir>] [--json -]
pnpm demo --showcase --fast --evaluate                  # the showcase, then the reports; adds check S-16
```

- **Scoring method.** A Behaviourally Anchored Rating Scale (BARS): four levels per criterion with no midpoint, 1 Not yet demonstrated, 2 Developing, 3 Proficient, 4 Advanced, plus Not observed (N/O, no score) when there is no evidence either way. Each level has a written behavioural anchor per criterion in the scenario's `rubrics/` files.
- **Evidence rule.** Every score of 3 or 4 needs a verified, verbatim, timestamped quote from that participant (at least 15 characters and 3 words); a 1 or 2 may stand without one (flagged, Low confidence). The program checks the quote against the recording; unverifiable or overlapping quotes are dropped and a 3 or 4 without a qualifying quote is capped at 2 and flagged. Level 1 means there was a clear opportunity and the behaviour was absent; Not observed means no opportunity or no usable evidence; an unusable answer from the AI is shown as Invalid and its learning objective as incomplete. Confidence (High, Medium, Low) comes from the number of distinct lines with a verified quote and the model's own statement. A learning-objective score is the mean of the observed criteria it maps to; there is no single overall grade.
- **Every report prints the method** (the scale, the evidence and confidence rules, how scores are combined and the limitations: AI-drafted and needs facilitator review, a small sample of three players, one session is a snapshot, first-person evidence only) and is written as Markdown and as a JSON twin (`schema: "acr.report/1"`).
- **Draft status.** Reports are labelled "AI-drafted - held for facilitator review before release (facilitator editing is planned)".
- **Visibility: all participants (prototype setting; per-participant isolation is planned).** Everyone may see everyone's scores and reports for now; there is no access control.
- **Privacy and cost.** A real run sends the session transcript to the configured model provider (a one-line notice says so) and makes one call per player plus one for the team (and at most one re-ask each). With `MODEL_PROVIDER=mock` a scripted offline evaluator is used and nothing leaves the machine.
- **Exit codes** of `pnpm evaluate`: 0 ok, 1 an evaluation failed (the other reports are still written), 2 usage or input error. Reports go into a fresh directory per run and are never overwritten (`data/reports/` is git-ignored).

### Showcase: a longer scenario so the AI does real work

The default run plays one short AI scene, so a live run shows only a couple of model replies. `pnpm demo --showcase` plays **`scenarios/friday-escalation-extended`** instead: six scenes (about 50 minutes of scenario time), three players and **two** AI characters, Priya Raman (`client_sponsor`) and a new CFO, Helena Brandt (`cfo`), a numbers-first finance executive. Players-only huddles frame a call with Priya (scene 2) and an escalation call and a negotiation of the final terms with Priya and the CFO (scenes 4 and 5). The bots speak 30 scripted lines (`showcase.yaml` in the scenario folder; the file may also hold scripted facilitator steps, below), which produce about 20 AI replies and 16 Game Master evaluations in a full run. Each scene has a `gm_detects` exit condition, a time box and a facilitator-advance backstop, plus timed and private injects (two aimed at the AI characters).

```bash
pnpm demo --showcase --fast                       # mock: scripted AI characters and Game Master, offline, deterministic, about a second
pnpm demo --showcase --live                       # the REAL provider for the AI characters AND the Game Master
pnpm demo --showcase --live --max-lines 2         # a shorter run for a slow model
pnpm demo --showcase --live --max-fallbacks 0     # fail the run if any AI reply was a canned fallback line
pnpm demo --showcase --live --players generated   # the model plays the three player roles too (see Generated players)
pnpm demo --showcase --live --players generated --player-model qwen3:8b   # a different model for the player bots
pnpm demo --showcase --fast --evaluate            # then write the feedback reports for the run (scripted offline evaluator; with --live a real one), check S-16
pnpm demo --showcase --scenario scenarios/my-scenario --fast   # your own package (needs its own showcase.yaml)
pnpm -s demo --showcase --fast --json -           # JSON report on stdout (with a `showcase` section)
```

Flags: `--scenario <dir>` (default `scenarios/friday-escalation-extended`, relative to the repo root; must load and have a `showcase.yaml`), `--max-lines <n>` (1 to 20 scripted lines per scene), `--max-fallbacks <n>` (0 to 1000: more fallback lines than this fail the run; without it they are only a warning) and `--watchdog <minutes>` (default 3, or 30 with `--live`), `--players scripted|generated` (default `scripted`) and `--player-model <id>` (see below), and `--evaluate` with `--eval-out <dir>` (default `data/reports`): after the checks the evaluator runs on that run's own session log, the narration gets a short summary, the `--json` report lists the report files under `evaluation` and check `S-16` is added (the default run keeps exactly `S-01` to `S-14`). See [Scoring and feedback](#scoring-and-feedback). `--url` is not supported (exit 2). Invalid scenario or showcase files exit 2 with one line naming the file and the problem.

**In live mode the real Game Master ends the scenes** (every third utterance it judges each `gm_detects` condition); the facilitator's `advance` is only a safety net after a scene's scripted lines run out, recorded as the observation `GM did not exit; facilitator advanced (<scene>)`, never a failure. Every wait is bounded by the configured NPC timeouts. **Run time:** mock about a second. Live depends on the model: an OpenRouter free-tier model takes minutes (and may answer some replies with the fallback line when it is overloaded); a slow local model can take about a minute per reply, so use `--max-lines 2`. `--live` sends the AI characters' personas and goals and the scripted conversation to your provider and may cost money (the run prints how many calls to expect); it prints only the provider's label, never keys or URLs, and refuses a `mock` provider with exit 2.

The narration labels every line by its source: `[player bot]`, `[AI character]`, `[Game Master]` (condition, verdict and its sanitized reasoning), `[system]` and `[alert]` (for example a fallback line with its reason), notes each scene's exit reason, and ends with an **AI contribution** summary: per character the replies, how many were real model output and how many canned fallback lines, the median and maximum reply latency (derived from event timestamps, from the previous line to the reply; `n/a` in mock mode, where the clock is fake), the Game Master's evaluations with verdict counts and the scenes it ended, facilitator advances, alerts and total wall time. The same data is in the JSON report under `showcase` (per-character stats, every Game Master decision, scene exit reasons, and a per-line record with `source` `player-bot`, `ai-character`, `game-master` or `system` plus the transcript `tag`). The showcase has its own checks, `S-01` to `S-14` (plus `S-18` in a live run, see below; session completed, every character spoke in its scenes and never where absent, the Game Master decided, fallback count within the limit, the prompt-leak audit (mock only, `skipped (live mode)` live), per-player isolation, no control characters, the on-disk log, no secrets, no swallowed failure, the watchdog, **no scene skipped** (S-13) and, in mock mode only, **no exhausted script and no scene that needed the facilitator advance** unless you capped the lines (S-14)).

**Generated players (`--players generated`, US-0027).** By default the player roles speak the scripted lines of `showcase.yaml`, so every run is the same. With `--showcase --live --players generated` the model speaks them too, as a human trainee would: for each scripted line slot (`--max-lines` still counts slots per scene) the bot asks the same live provider, behind the same retry layer and with the same first-token and reply timeouts and `NPC_MAX_TOKENS`, to speak that role's next line. The prompt holds only what that player may see: its brief and private facts (what its `join` received), the scene title and goal (the demo reads them from the scenario file; the server does not send them to players), the injects addressed to it and the conversation it has seen as `[role_id]: text` turns (the same turn rules as the AI characters), plus the scripted line as a **private intent** (what to get across, never to be quoted). It never holds NPC goals, hidden facts, the rubric, other roles' secrets or participant names (check `S-15` audits every player prompt). The reply is cleaned like an AI character's (a leading own tag is dropped, lines written for other speakers are cut), must be non-empty and within the server's line limit, and reaches the server only through the ordinary `say`. If the model fails (error, empty, timeout), the scripted line is spoken instead, stays `[SCRIPTED]` and the narration and transcript say `player <role>: generation failed (<reason>); used the scripted line`. A line is tagged `[GENERATED]` only when the model wrote the recorded text. **Intents.** Right before each player line the transcript and the narration log a `[SYSTEM]` entry `intent for <role> (private to the player bot; the server and the other players never see it): <scripted line>` (the line the bot was asked to express, whether the model then generated it or the scripted line was spoken as the fallback), so you can compare what the player was asked with what it said; the JSON `showcase.players.intents` lists per slot the role, scene, intent, source (`generated` or `scripted-fallback`) and the recorded text, and the summary counts the intents logged. The intent stays in the demo process: it is never sent to the server, so it is not in the session log, any client's inbox or the Game Master's input (tests prove it). `--no-intents` (only with `--players generated`) hides them everywhere. `--player-model <id>` picks a different model for the player bots (default: the NPC model, `NPC_MODEL`); the same provider is used. `--players generated` needs `--showcase` and `--live` (a one-line usage error otherwise; mock and CI runs are unchanged). The summary counts the player lines apart from AI character replies and Game Master verdicts and reports how many generated lines repeated the scripted line verbatim (an observation, not a failure); the `showcase.players` JSON section has `generated`, `scriptedFallbacks`, `verbatimRepeats` and `cutReplies`, and the run has the extra check `S-15` (15 instead of 14 checks). Both the AI character and the player prompts tell the model not to repeat or reword what was said and to move the conversation forward, and list the speaker's own last three lines under `## Your last lines`; sampling uses `NPC_TEMPERATURE` / `PLAYER_TEMPERATURE`. A player saying its own private fact aloud (or anyone saying a hidden-fact fragment) is not an `S-07` leak: only what the server delivers outside the speaker's own words is audited, and such spoken fragments are reported as an observation. The player calls add about one model call per scripted line (more with retries); `--live` prints the expected count.

**Scene guards.** Every scripted line and the safety-net advance name the scene they belong to (`expectSceneId`, an optional field of the `say` and `command` WebSocket messages; clients that omit it behave exactly as before). If the scene ended in between (a time box in a live run, the Game Master), the server refuses the message with `stale_scene` and appends nothing; the showcase records `scene changed under us: ...`, carries on in the actual scene and never skips one. A scene that ended by a time box before its first line is an observation; one that was left with no scripted line any other way fails S-13. Lines left unspoken after an early Game Master exit are recorded too. In a live run the 1 s ticker can judge a scene while a line is being recorded, before the characters answer, so before concluding "GM did not exit" the showcase asks the Game Master for one more evaluation of the full turn (only if the scene was already evaluated; the ticker keeps running, so time boxes stay real). With `--max-lines 2` scenes 1, 3 and 6 (players only, two utterances) get no Game Master evaluation and end by the facilitator advance.

**Scripted facilitator steps (US-0016).** A scene entry of `showcase.yaml` may hold `facilitator: [{ after_line: 1, release_hidden: { role: cfo, fact: 1 } }]`: right after scripted player line `after_line` (1-based) has been answered, the facilitator's own connection releases that hidden fact. The loader checks it against the scenario (an AI character of that scene, a fact number the character has, a line the scene has, no fact released twice). Scene 5 of the extended scenario releases the CFO's fact 1 after the team's quantified fixed-fee, firm-date offer, so Helena can settle: her prompts from then on, and only hers, carry `## What you may now share`. A step is skipped when its line is never spoken (a `--max-lines` cap, or the scene ended first, which is recorded as an observation). The narration, the `--transcript` file and the `--json` report say `facilitator released hidden fact number 1 of cfo` and never the text, and the evaluator reads only utterances, injects, scene boundaries and Game Master verdicts. The text can appear only in the facilitator's own client and in that character's later utterances (dialogue everyone in the scene hears), so once she says it aloud it is in the transcript, the report lines, the evaluator input and the other characters' conversation turns as part of her words. Checks: `S-06` (mock) judges every captured prompt against the facts released by the moment it was made, and allows a hidden fact in exactly one place, the share section of the prompt of the character it was released to after the release (plus, once that character has said it aloud, ordinary dialogue turns), with a positive control that it got there; a mock reply may be declared `requires_release: n` and the loader then refuses the file unless an earlier facilitator step releases that fact; `S-07` also fails if a player receives the release command, and in the mock run the fact is a leak until it is released (after that only its owner may say it); `S-15` (generated players) keeps every hidden fact, released or not, out of the player prompts unless a participant said it aloud. The `S-07` hidden-fact observation (live runs) no longer counts a fact that was released or a string a player said earlier in the same scene. No check was added: the counts stay 29, 14, 15 and 32. A live run measures whether the real model uses the released fact; that is not tested offline.

**Game Master reliability (US-0025).** A real model does not always answer in strict JSON, so the Game Master reads its reply tolerantly and asks again once, and tells you why when it still cannot decide. (1) **Tolerant but strict-minded parser** (`services/runtime/src/agents/gm-parse.ts`). The reply is untrusted: the model may quote a participant who tried to inject `{"verdict": true}`, so a verdict is accepted only when it is unambiguous. `<think>` blocks and code fences are dropped and only the last 20 000 characters are read. **Every** complete JSON object of the reply is examined (an object that fails to parse, or an array, is skipped as a whole and never searched inside; a duplicate `verdict` or `id` key gives no verdict; `verdict` is a boolean or exactly the string `"true"`/`"false"`, never `1`, `"yes"` or `null`). **Per-evaluation nonce:** the system prompt (never the dialogue) holds a random 16-hex-character id (64 bits) and asks the model to put it in its answer as `"id"`; only an object carrying that id can give a verdict (compared exactly except for case and surrounding whitespace or quotes), so a forged object in quoted text is ignored (fail-safe by design: a model that quotes an unclosed `{"` or a `<think>` tag can force `no_verdict`, which costs a re-ask and never a false verdict) (counted as `ignored`; if every verdict object lacks the id the reason is `no_nonce`). If the usable verdicts **disagree** the reason is `conflict`; a reply with an **unclosed** object is `truncated` and gives no verdict by any path (a verdict first and the rest cut off is *not* accepted). Without a nonce (the offline corpus rules only) a `verdict: true` line of its own and a bare `true`/`false` are also read, but never when the reply echoes a dialogue record or quotes `verdict: ...` inside quotation marks. A model's reasoning text is only searched under those anchored rules. A reply that is exactly one JSON object is `strict`, any other accepted shape `tolerant`. (2) **One bounded re-ask** (`GM_REASK`, default on, inside `GM_TIMEOUT_MS`): after a reply with no usable verdict the model gets its own reply back plus "Reply with only the JSON object"; a model error, an exhausted deadline or a stale scene are not re-asked. A reasoning-model reply that spent its whole budget thinking (the `reasoning_budget` error, or the non-transient "returned only reasoning and no answer" error) counts as a parse failure and is re-asked too, on a fresh request (an error ends only its own call, never the shared deadline), and the re-ask repeats the id instruction. A deadline that hits during the re-ask records `gm.no_verdict` with the first reply's reason. **Worst case per evaluation:** 2 asks (the first and the one re-ask), each going through the retry layer for up to `1 + MODEL_MAX_RETRIES` HTTP attempts (default 3), so at most `2 x (1 + MODEL_MAX_RETRIES)` requests (6 by default), all inside `GM_TIMEOUT_MS`; the live demo notice counts the re-asks (up to twice the evaluations). (3) **`gm.no_verdict`** is a new facilitator-only event `{sceneId, condition, reason, attempts}` (`reason`: `empty`, `no_json`, `bad_verdict`, `truncated`, `reasoning_only`, `conflict` or `no_nonce`) that replaces the old free-text info alert; players never receive it. `gm.decision` gains an optional `via` (`strict`, `tolerant` or `reask`). Model errors and deadlines stay warning alerts with their reason. (4) **Prompt**: the scene goal is labelled background ("judge ONLY this condition"), the reasoning comes before the verdict in the JSON, and the rule is calibrated: true when the condition was stated **and** the people it concerns agreed or confirmed it; false when it was only proposed, suggested or asked about, is disputed or is still open, **even if nobody has objected yet** (silence is not agreement). Scene 3 of the extended showcase therefore has three more lines: after the proposal ("Are we all happy with that plan?") the delivery lead and the tech lead agree and the account manager confirms. (5) **Seen in the showcase**: the narration prints `[Game Master] no verdict for "<condition>"` with the reason and "after the re-ask"; the summary adds a `Game Master reliability` line and the JSON `showcase.gm` has `noVerdicts`, `noVerdictByReason`, `reasks` and `via`; the mock script **declares** (in `showcase.yaml`, `kind: tolerant` / `kind: malformed` / `kind: forged`, the last served without the id so the mock can exercise `no_nonce`) one fenced reply and one malformed reply followed by the reply that answers the re-ask, and `S-04` holds the run to those declarations in every CI run (the mock stamps the evaluation's id into each verdict it serves, like a model that follows the prompt). In a `--live` run the extra check **`S-18`** reports how many scenes the Game Master ended and its no-verdict rate by reason; it fails only with `--min-gm-exits <n>` (needs `--showcase --live`), . **Early exits** (a Game Master exit at or before the last scripted line after which the labelled negative controls say the condition is not yet met, i.e. before the scripted agreement) are always reported in the evidence line; they gate only with an explicit `--max-false-exits <n>` (never implied by `--min-gm-exits`), count only scenes without AI characters (in a scene with AI characters their live replies can legitimately meet the condition), are not gated with `--players generated` (a usage error with it), and refuse to judge when `tests/gm-cases` is out of date with `showcase.yaml`. `--gm-trace <file>` (needs `--showcase`) records every raw Game Master reply and how it was read (one JSON line each, owner-only file; it holds judgements about the whole conversation, so keep it private).

**`pnpm gm-eval` (offline-first).** `pnpm gm-eval` checks, with no model call and no `.env`, that the labelled cases in `tests/gm-cases/` are valid and in step with `showcase.yaml` (each scene in full is labelled *met*; a negative control cut before the agreement, such as scene 3 ending on the unanswered proposal, is labelled *not met*; two hard negatives (scene 1 after line 4, which ends on the unanswered "What if we offer it as a phase two...?", and scene 6 after line 3, where the tech lead has only raised the risk review and the build plan with "someone needs to ..." so they still have no owner); `pnpm gm-eval --build tests/gm-cases` regenerates them and the labels you review are `NEGATIVE_CUTS`, keyed by scenario id and scene id in `services/runtime/src/gm-eval/cases.ts`), and that the parser reads every raw reply of `tests/gm-cases/parser-corpus.json` as expected (add a captured reply there whenever a model finds a new shape). `--trace <file>` replays a captured `--gm-trace` through the current parser under the nonce each record stored (an old trace without one is replayed with the offline rules and flagged "no nonce recorded"): parse rate by reason and any drift from the parse recorded at capture. `--live [--runs 3]` (by hand, never in CI) asks the configured `GM_MODEL` to judge every case with the production prompt, re-ask and timeout and reports the usable-verdict rate, agreement with the labels, precision, recall, false exits on the negative controls, attempts and latency; it sends the case dialogues to your provider and may cost money. `--json <path|->` writes the figures as JSON. Exit codes: 0 all checks passed, 1 a check failed (invalid or missing/stale cases, a parser corpus mismatch, or every `--live` model call failed), 2 usage or input error. The corpus carries the injection cases (quoted verdicts, duplicate keys, truncation, arrays) and nonce cases. The acceptance measure for the Game Master is a scripted-player showcase run on two real models in which it ends at least 4 of the 6 scenes (`pnpm demo --showcase --live --gm-trace <file> --min-gm-exits 4`) and `pnpm gm-eval --live` shows at most 1 false exit on the negative controls; the baseline before this change was 61% of scenes ended.

An excerpt of a real mock run (`pnpm demo --showcase --fast --no-color`):

```text
SCENE 4 of 6: Escalation call with Priya and the CFO
  goal: Present the phased proposal and learn what the CFO needs in order to accept it
  in the room: delivery_lead, tech_lead, account_manager; AI characters: Priya Raman, Helena Brandt
  [player bot] delivery_lead: Thanks both. To recap: we propose a phased reconciliation module, delivered three weeks after go-live, so the launch date stays safe.
  [AI character] Priya Raman (client_sponsor): Helena, this is the phased option I mentioned. It gets Finance the module, just not on day one.
  [AI character] Helena Brandt (cfo): I have one question before adjectives: what does it cost in total, and is that a fixed price or an estimate?
  [Game Master] FALSE for "the CFO has heard the priced phased proposal and has said what she needs in order to accept it": The CFO asked about cost but has not said what she needs in order to accept.
  ...
  [system] scene ended: the Game Master judged the exit condition true (gm_detects)

AI contribution
  Priya Raman (client_sponsor): 12 replies, 12 scripted (mock) output, 0 fallback lines; latency n/a
  Helena Brandt (cfo): 8 replies, 8 scripted (mock) output, 0 fallback lines; latency n/a
  Game Master: 16 evaluations (6 true, 10 false); exited: s1_huddle, s2_priya_call, s3_internal_huddle, s4_escalation_call, s5_final_terms, s6_wrap_up
  Game Master reliability: no usable verdict 0; re-asks 1; verdicts read strictly 14, tolerantly 1, after a re-ask 1
  Scenes played: 6 (ended by Game Master 6, time box 0, facilitator advance 0)
  Player-bot lines: 30; AI character replies: 20 (0 canned fallback)
  AI voices: 0 of 8 comparable AI reply pair(s) (different characters, same player line) were near-duplicates (similarity >= 0.6); silent turns: none
  Facilitator advances: 0
  Alerts: 0
  Total wall time: 0.0 s
```

### Scenario authoring: AI character voices

When two AI characters share a scene, give each its own kind of contribution, or the more senior one tends to rephrase the junior one. An AI character role (`roles/<id>.yaml`, `type: npc`) takes these optional fields:

| Field | Meaning |
| --- | --- |
| `seniority` | Integer 1 to 5 (default 3); higher is more senior. After a player line the AI characters of the scene reply junior first (ties by the order of the scene's participants), so the senior one reads the junior one's reply and answers with the decision. |
| `responds_with` | Up to 5 short strings (160 characters each): the KIND of contribution this character makes, e.g. `a ruling or decision on price and terms`, `a concrete condition or number she needs before agreeing`, `a consequence if the date slips`, `challenges one assumption at a time`. |
| `only_you_say` | Up to 5 short strings: what only this role would say, e.g. `total cost, what it displaces, fixed price, penalties, contract precedent`. |
| `defer_to` | Role ids of AI characters this one lets have the final say when both are in the scene (wording in the prompt only; the reply order follows `seniority`). Must be other `npc` roles of the scenario; the validator warns when one is less senior or two defer to each other. |
| `defers_text` | Optional (up to 200 characters, your own role's prompt text only): replaces the generic sentence "leave the final decision on price, terms and approval to <name> (<title>)". |

The AI character's prompt gets a `## Who else is in the room` section (the other AI characters of the scene: name, title and `more senior`, `less senior` or `peer`; never their goals, knowledge or hidden facts) and a `## How you respond` section from `responds_with` and `only_you_say`, with the rules: do not restate, paraphrase or agree-and-repeat the previous speaker; open with your own angle; a senior character answering after a junior one must open with a decision, a condition with a number or a date, or the cost or consequence, and then stop; a junior one speaks to its own area first and does not pre-empt the decision it defers. The roster also tells the character how the others' lines are tagged (`[role_id]`). When another AI character is present, a character may stay silent by replying exactly `<silent/>` if the last speaker already said what it would say and it has no decision, condition or number to add (never when addressed by name or asked a question): this records nothing (no line, no fallback, no alert), is never shown to players, is allowed at most 2 turns in a row, and the last character of a round that nobody has answered yet must speak (if every character is somehow silent a facilitator warning is raised). `(silent)`, `*stays silent*` and `...` as a whole reply count as silence, never as text. In the showcase, the summary and the `--json` `showcase.voices` section count silent turns per character and, as `echoes / eligiblePairs`, the near-duplicate replies of two different AI characters to the same player line (token-set Jaccard similarity of at least 0.6 after lowercasing, punctuation and stop-word removal, at least 4 content tokens per side, same polarity), as observations and never as failures. `scenarios/friday-escalation-extended` shows it with Priya Raman (seniority 3) and Helena Brandt (seniority 5). The scripted mock replies are per character, so the mock runs needed no change.

### Markdown transcript

`--transcript <path.md>` writes a Markdown transcript of the run in **every** mode (default, `--showcase`, mock, `--live`, `--url`; with `--url` only what the facilitator observes). It is a file only: the terminal narration is unchanged, and it can be combined with `--json`. A relative path is relative to where you ran pnpm (like `--json`); a directory, a symbolic link (also as a parent folder) and the same file as `--json` (compared by device and inode, so hard links and aliases count) are refused (exit 2), and the file is opened with `O_NOFOLLOW` at write time so a link swapped in later is never followed; an existing regular file is overwritten (your own earlier transcript), and missing parent folders are created only under the repo, the working directory or the temp directory (otherwise exit 2). The file is built from structured line records the stories emit, not by parsing the narration.

Every dialogue line is **bold in full** and starts with a tag:

| Tag | Meaning |
| --- | --- |
| `[SCRIPTED]` | authored in advance: bot player lines, facilitator whisper text and every reply of the scripted mock providers (mock mode) |
| `[GENERATED]` | produced by a live model at run time: live AI character replies and the Game Master's reasoning |
| `[FALLBACK]` | the character's canned fallback line standing in for a missing model reply (the persona's fallback text AND the engine's fallback alert); never labelled generated, in any mode, including the mock side room |
| `[UNVERIFIED]` | an AI character or Game Master line seen through `--url`, with or without `--live`: the runner cannot tell whether the remote server used a real model or a script |
| `[SYSTEM]` | technical logging, not dialogue (plain, not bold) |

This supersedes any earlier "four tags" wording: with `--url` the runner cannot know the target's provider, so AI character and Game Master lines are `[UNVERIFIED]` (bot lines and whispers stay `[SCRIPTED]`, a canned line stays `[FALLBACK]`), and the metadata says "AI line tags are unverified: remote server". Only a live in-process run with the real provider can emit `[GENERATED]`. Under `--url` the `[FALLBACK]` marker is asserted by the remote server (a hostile server can set it; it can never produce `[GENERATED]`). A canned line is recognised by an optional `fallback: true` marker that only the NPC agent's fallback path sets on its `utterance` event (older servers without it are recognised by the character's own fallback alert right before the line). The file has a title, a metadata table (mode, provider label only, scenario, date, tool version, summary), the legend, one `##` heading per act or scene (the scene's exit reason is a `[SYSTEM]` line), the AI contribution table for a showcase, and the checks as a table. Text from a model or a server is scrubbed (secrets, home and temp paths), sanitized, truncated and **escaped for Markdown**: invisible and format characters (every Unicode `Cf` character, fillers, variation selectors) are removed and look-alikes folded (NFKC) so a tag cannot hide in them; a tag-shaped token such as `[SCRIPTED]`, `[ generated ]`, `［SCRIPTED］` or `【SYSTEM】` becomes inert `(SCRIPTED)`; backslash, `*`, `_`, backtick, brackets, `<`, `>`, `|`, `~`, `!`, `#`, `&` and `$` are escaped; URLs, `www.` hosts, addresses, GitHub references (`#123`, `GH-123`, `owner/repo#1`) and 7 to 40 digit hex runs (SHAs) are broken with a zero-width entity so nothing autolinks; leading and trailing whitespace and line-break markers are trimmed so the bold span closes; text is truncated by code points, so a reply cannot forge a tag, end the bold span, add a heading, a table row or a link. An excerpt of `pnpm demo --showcase --fast --transcript t.md`:

```markdown
## Scene 4 of 6: Escalation call with Priya and the CFO

[SYSTEM] goal: Present the phased proposal and learn what the CFO needs in order to accept it; AI characters in the room: Priya Raman, Helena Brandt

**[SCRIPTED] delivery_lead: Thanks both. To recap: we propose a phased reconciliation module, delivered three weeks after go-live, so the launch date stays safe.**

**[SCRIPTED] Priya Raman (client_sponsor): Helena, this is the phased option I mentioned. It gets Finance the module, just not on day one.**

**[SCRIPTED] Game Master (verdict: false) on "the CFO has heard the priced phased proposal and has said what she needs in order to accept it": The CFO asked about cost but has not said what she needs in order to accept.**
```

In a live run the AI character and Game Master lines read `**[GENERATED] ...**`, and a canned line reads `**[FALLBACK] Priya Raman (client_sponsor): Sorry, you cut out for a second there. Say that again?**`.

## Update

```bash
git pull
pnpm install        # picks up new or changed dependencies
```

Then read [CHANGELOG.md](CHANGELOG.md) for anything that changes how you run or configure the project (new environment variables, protocol changes). If you run it in Docker, `./run.sh` rebuilds the image on each start (Docker caches unchanged layers), so just run it again.

## Develop

```bash
pnpm test           # all unit and integration tests (Vitest)
pnpm test:coverage  # the same with coverage; each package must stay at or above 80% lines
pnpm typecheck      # TypeScript, strict
pnpm lint:sdk       # fails if anything outside packages/adapters imports a provider SDK
pnpm dev:runtime    # server with auto-restart
pnpm demo --fast    # unattended end-to-end run of the whole scenario with a feature checklist
```

The default test run never calls a real model or touches the network.

### Layout

```
packages/events     session event types and the state reducer
packages/script     scenario schema, loader, validator, scene state machine
packages/adapters   model provider adapters (mock, Anthropic, OpenAI-compatible)
services/runtime    session engine, NPC agents, Game Master, WebSocket server, terminal client, demo runner (src/demo), post-session evaluator (src/evaluator)
scenarios/          playable scenarios (YAML): friday-escalation (3 scenes, 1 AI character) and friday-escalation-extended (6 scenes, 2 AI characters, plus the showcase.yaml script for `pnpm demo --showcase`); each has rubrics/ (BARS rubric files)
docs/               architecture, release plan, plans and the generated plan dashboard
```

### Project tracking and workflow

The repository uses PlanVisualizer (npm-based tooling in `tools/`, spec in `plan_visualizer.md`) for planning (`docs/RELEASE_PLAN.md`, `docs/BUGS.md`, `docs/TEST_CASES.md`). Regenerate the dashboard with `npm run plan:generate` and open `docs/plan-status.html`. Its own tests run with `npm run plan:test`.

Work follows `feature/*` → `develop` (pull request) → `main` (pull request). `main` and `develop` are protected and every pull request must pass the required CI checks (Lint, Test & Coverage Gate, Build, Orchestrator Validation, Dependency Audit, Secret Scanning, Analyze JavaScript). CI also runs Workspace Typecheck, Workspace Tests (with the per-package 80% coverage gate), SDK Import Guard, Workspace Audit, Docker Build and Demo Run (the unattended demo, `pnpm demo --fast`) for the TypeScript workspace. Conventions are in [AGENTS.md](AGENTS.md).

## Known limitations

- **Facilitator token, no TLS, open player roles.** With `FACILITATOR_TOKEN` set, `join_facilitator` needs the token (compared in constant time, never logged or echoed, one attempt per connection, repeated failures from one address are blocked), which protects the facilitator's event stream (whispers, NPC goals, hidden facts, Game Master reasoning) and the start and command rights. It does **not** protect: the traffic itself (there is no TLS, so the token and all text are clear text on `ws://`: put a TLS reverse proxy in front off a trusted network); the player roles (anyone who can reach the port can claim an unclaimed role and read its brief and private facts, and a role is freed when its connection closes, so also after a crash or restart; per-role join codes are planned as US-0033); the session logs at rest; the model provider; or a flood bigger than the connection and rate limits. **With `FACILITATOR_TOKEN` unset the server is open and prints a warning at startup**; refusing to start without a token on a non-loopback address is planned. The server also caps connections (total and per address), message rate, queued messages and frame size (16 KiB), closes connections that never join and refuses browser origins that are not allowed. See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
- **The Game Master trace file is sensitive.** `GM_TRACE_FILE` and `--gm-trace` (both off by default) write the model's raw replies about the whole conversation, including its reasoning, to a file created with mode `0600`. It is never part of the session log and never sent to a player, but it is facilitator-grade data: keep it private and delete it when you no longer need it.
- Text only: no voice, no web or Teams client yet.
- One session per server process.
- Sessions are not resumed after a restart: on start, an earlier log for the same session id is moved aside as `data/sessions/<id>.<timestamp>.jsonl` and a fresh session begins. The move uses a hard link and falls back to a file copy, so the data directory's filesystem must support one of the two.
- Two server processes on the same data directory and session id will rotate each other's log file; use a different `SESSION_ID` (or data directory) per process.
- NPCs are a scripted mock unless you configure a model provider.
- Scoring and feedback reports are a first, AI-drafted version: no facilitator edit workflow, no participant self-assessment, no isolation between participants (everyone may see every report), and not yet validated against human raters. See [docs/EVALUATOR.md](docs/EVALUATOR.md).

## License

[MIT](LICENSE) © 2026 Kamal

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

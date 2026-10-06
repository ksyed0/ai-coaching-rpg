# AI Coaching RPG

Script-driven, multiplayer role-play training with AI counterparts.

A small team plays a scripted workplace scenario in real time. Some roles are played by people, the rest by AI characters (NPCs). A **Game Master** model watches the conversation, fires timed events and moves the scene forward. Everything that happens is recorded as an append-only event log, so a session can be replayed and, in a later release, scored against a rubric.

> **Status: proof of concept (Slice 1).** Three people on one local network play the *Friday Escalation* scenario in text from a terminal. There is no voice, no web or Teams client, no scoring and no authentication yet. See [Known limitations](#known-limitations).

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

`./run.sh` creates `.env` from `.env.example` if it is missing (mock model, no key needed). `--dev` uses `tsx watch`, so it restarts (and rotates the live session log, see [Known limitations](#known-limitations)) on every source change. It needs Node 22+ and pnpm and prints an error if either is missing; the Docker start needs Docker with the `docker compose` plugin. The Docker start rebuilds the image on each start (Docker caches unchanged layers), so there is no separate build step.

The server listens on `0.0.0.0:8080` (set `RUNTIME_PORT` to change it with `--dev`) and loads the *Friday Escalation* scenario. **It listens on all network interfaces on purpose, so teammates on your LAN can join; there is no authentication yet** (see [Known limitations](#known-limitations)).

Docker notes:

- `.env` is passed to the container at run time and is never baked into the image. In Docker the server always listens on 8080 inside the container; to publish a different host port run `HOST_PORT=9000 ./run.sh`.
- Session logs are written to `./data/sessions/` on the host (bind mount). The container runs as the non-root user that invoked `./run.sh` (`HOST_UID`/`HOST_GID`), so the logs are owned by you. If you start it with plain `docker compose` on Linux instead, set `HOST_UID`/`HOST_GID` yourself (default 1000:1000) or the container may not be able to write to `./data`.
- Docker Compose reads `.env` with its own rules (quotes, `$` interpolation, inline `#`), which differ slightly from the app's own parser used by `./run.sh --dev`. Keep API keys free of `$`, `#` and quotes, or quote them per Compose rules.
- If `./run.sh` is run as root it starts the container as 1000:1000 instead (unless `HOST_UID`/`HOST_GID` are set), so `./data` must be writable by that user.
- The `scenarios/` folder is mounted read-only into the container, so you can edit a scenario and just restart.

### 2. Connect the participants

In separate terminals, on the same machine or any machine on the same network (use the host's IP in `--url`):

```bash
pnpm play --facilitator
pnpm play --role delivery_lead   --name Kamal --url ws://<host-ip>:8080
pnpm play --role tech_lead       --name Alex  --url ws://<host-ip>:8080
pnpm play --role account_manager --name Sam   --url ws://<host-ip>:8080
```

The client sponsor (`client_sponsor`) is played by an AI.

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
| `/quit` | Disconnect |

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
| `NPC_FIRST_TOKEN_TIMEOUT_MS` | `10000` | Milliseconds an NPC waits for the model's first token before speaking its scripted fallback line and alerting the facilitator. Whole number, `500` to `600000` |
| `NPC_REPLY_TIMEOUT_MS` | `20000` | Milliseconds allowed for a whole NPC reply (stalls after the first token included). Whole number, `500` to `600000`, and **must be at least `NPC_FIRST_TOKEN_TIMEOUT_MS`** |
| `NPC_MAX_TOKENS` | `600` | Token budget (`max_tokens`) for one AI character reply. Reasoning models spend part of it thinking before they answer. Whole number, `50` to `4000` |
| `GM_MAX_TOKENS` | `400` | Token budget for one Game Master verdict. Whole number, `50` to `4000` |
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
- **Deadlines still rule.** The retries happen inside the deadlines: an NPC reply stops at `NPC_FIRST_TOKEN_TIMEOUT_MS` / `NPC_REPLY_TIMEOUT_MS`, and the Game Master's model call now has its own deadline of `max(NPC_REPLY_TIMEOUT_MS, 60 s)`. When a deadline fires during a backoff wait the retrying stops at once (the character speaks its fallback line, or the Game Master records no verdict) and the alert says how many attempts were made and the last error. So retries never make a reply later than the deadline you configured; the worst case without a deadline would be the number of attempts times a 10 s `Retry-After`, and the deadline cuts it. If you shorten the timeouts, fewer retries fit.
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

- **Default (mock).** Scripted models and a fake clock make the run deterministic, so all 29 checks run: the lobby rules (taken, NPC and unknown roles, who may start), scene flow and the timed inject at exactly minute 7, the AI character answering once per line and staying silent where it is absent, the Game Master exiting a scene, ignoring a malformed reply and refusing stale verdicts, pause/resume, advance, whispers, per-player isolation (every player's whole inbox is audited against strings taken from the scenario files, and every model prompt is audited for the rubric, other roles' secrets, hidden facts and names), hostile and oversized frames, terminal safety, reconnecting with the token, a client that stops answering pings, log rotation on restart, and the on-disk event log. A short side room (a second in-process server) covers the failure paths a main run cannot wait for: a stalled model, an empty reply and the dead client.
- **`--live`.** Uses the provider you configured (`MODEL_PROVIDER`, read from `.env` and the environment, **only** when you pass `--live`). It refuses with exit code 2 if the provider resolves to `mock`. **This sends the scenario text and the scripted lines to that provider and may cost money**; the run prints only the provider's label and whether a custom endpoint is used, never keys or URLs. Model output is not deterministic, so the scripted-content checks (the timed inject, Game Master verdicts, prompt capture) are marked `skipped (live mode)`, the facilitator's `advance` drives the scenes, and the NPC check accepts any non-empty reply or the fallback line.
- **`--url ws://host:port`.** Starts no server; runs the externally observable subset (join, start, speech, the NPC reply, whisper and private-event isolation, pause/resume, advance, reconnect with the token, hostile frames, terminal safety) against a running one and marks the checks that need control of the process (fake clock, prompt capture, restart and log rotation, heartbeat, the log file) as `skipped (needs in-process server)`. It checks structure, not content: an NPC reply is "non-empty or the fallback line". The server must allow facilitator joins (Slice 1 has no authentication) and must have a **fresh** session (the runner starts it), so restart the server between runs. The URL must be `ws:` or `wss:` with no credentials, query or fragment. **Only point it at a throwaway server with a fresh session: the run drives the target's real session to its end (`script_complete`), after which that session cannot be resumed, and everything it sends goes into the target's permanent event log.** It first prints exactly what it will do: a facilitator join and the commands start, pause, resume, advance and whisper; scripted player lines (one containing an escape sequence and a forged newline, and speech while paused); role-claim attempts (taken, NPC and unknown roles), forged-token takeover attempts and a rejoin with the real token; player-issued start and pause, speech before the start, a facilitator say, speech from a role that is absent from the scene, speech and a resume command after the session ends, speech before joining and a whisper to the NPC role (all expected to be refused); malformed frames and one oversized (~70 kB) frame. Combined with `--live`, content checks are skipped as well, and the notice reminds you that the server's own provider receives the text.

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

### Showcase: a longer scenario so the AI does real work

The default run plays one short AI scene, so a live run shows only a couple of model replies. `pnpm demo --showcase` plays **`scenarios/friday-escalation-extended`** instead: six scenes (about 50 minutes of scenario time), three players and **two** AI characters, Priya Raman (`client_sponsor`) and a new CFO, Helena Brandt (`cfo`), a numbers-first finance executive. Players-only huddles frame a call with Priya (scene 2) and an escalation call and a negotiation of the final terms with Priya and the CFO (scenes 4 and 5). The bots speak 24 scripted lines (`showcase.yaml` in the scenario folder), which produce about 20 AI replies and 14 Game Master evaluations in a full run. Each scene has a `gm_detects` exit condition, a time box and a facilitator-advance backstop, plus timed and private injects (two aimed at the AI characters).

```bash
pnpm demo --showcase --fast                       # mock: scripted AI characters and Game Master, offline, deterministic, about a second
pnpm demo --showcase --live                       # the REAL provider for the AI characters AND the Game Master
pnpm demo --showcase --live --max-lines 2         # a shorter run for a slow model
pnpm demo --showcase --live --max-fallbacks 0     # fail the run if any AI reply was a canned fallback line
pnpm demo --showcase --live --players generated   # the model plays the three player roles too (see Generated players)
pnpm demo --showcase --live --players generated --player-model qwen3:8b   # a different model for the player bots
pnpm demo --showcase --scenario scenarios/my-scenario --fast   # your own package (needs its own showcase.yaml)
pnpm -s demo --showcase --fast --json -           # JSON report on stdout (with a `showcase` section)
```

Flags: `--scenario <dir>` (default `scenarios/friday-escalation-extended`, relative to the repo root; must load and have a `showcase.yaml`), `--max-lines <n>` (1 to 20 scripted lines per scene), `--max-fallbacks <n>` (0 to 1000: more fallback lines than this fail the run; without it they are only a warning) and `--watchdog <minutes>` (default 3, or 30 with `--live`), `--players scripted|generated` (default `scripted`) and `--player-model <id>` (see below). `--url` is not supported (exit 2). Invalid scenario or showcase files exit 2 with one line naming the file and the problem.

**In live mode the real Game Master ends the scenes** (every third utterance it judges each `gm_detects` condition); the facilitator's `advance` is only a safety net after a scene's scripted lines run out, recorded as the observation `GM did not exit; facilitator advanced (<scene>)`, never a failure. Every wait is bounded by the configured NPC timeouts. **Run time:** mock about a second. Live depends on the model: an OpenRouter free-tier model takes minutes (and may answer some replies with the fallback line when it is overloaded); a slow local model can take about a minute per reply, so use `--max-lines 2`. `--live` sends the AI characters' personas and goals and the scripted conversation to your provider and may cost money (the run prints how many calls to expect); it prints only the provider's label, never keys or URLs, and refuses a `mock` provider with exit 2.

The narration labels every line by its source: `[player bot]`, `[AI character]`, `[Game Master]` (condition, verdict and its sanitized reasoning), `[system]` and `[alert]` (for example a fallback line with its reason), notes each scene's exit reason, and ends with an **AI contribution** summary: per character the replies, how many were real model output and how many canned fallback lines, the median and maximum reply latency (derived from event timestamps, from the previous line to the reply; `n/a` in mock mode, where the clock is fake), the Game Master's evaluations with verdict counts and the scenes it ended, facilitator advances, alerts and total wall time. The same data is in the JSON report under `showcase` (per-character stats, every Game Master decision, scene exit reasons, and a per-line record with `source` `player-bot`, `ai-character`, `game-master` or `system` plus the transcript `tag`). The showcase has its own checks, `S-01` to `S-14` (session completed, every character spoke in its scenes and never where absent, the Game Master decided, fallback count within the limit, the prompt-leak audit (mock only, `skipped (live mode)` live), per-player isolation, no control characters, the on-disk log, no secrets, no swallowed failure, the watchdog, **no scene skipped** (S-13) and, in mock mode only, **no exhausted script and no scene that needed the facilitator advance** unless you capped the lines (S-14)).

**Generated players (`--players generated`, US-0027).** By default the player roles speak the scripted lines of `showcase.yaml`, so every run is the same. With `--showcase --live --players generated` the model speaks them too, as a human trainee would: for each scripted line slot (`--max-lines` still counts slots per scene) the bot asks the same live provider, behind the same retry layer and with the same first-token and reply timeouts and `NPC_MAX_TOKENS`, to speak that role's next line. The prompt holds only what that player may see: its brief and private facts (what its `join` received), the scene title and goal, the injects addressed to it and the conversation it has seen as `[role_id]: text` turns (the same turn rules as the AI characters), plus the scripted line as a **private intent** (what to get across, never to be quoted). It never holds NPC goals, hidden facts, the rubric, other roles' secrets or participant names (check `S-15` audits every player prompt). The reply is cleaned like an AI character's (a leading own tag is dropped, lines written for other speakers are cut), must be non-empty and within the server's line limit, and reaches the server only through the ordinary `say`. If the model fails (error, empty, timeout), the scripted line is spoken instead, stays `[SCRIPTED]` and the narration and transcript say `player <role>: generation failed (<reason>); used the scripted line`. A line is tagged `[GENERATED]` only when the model wrote the recorded text. `--player-model <id>` picks a different model for the player bots (default: the NPC model, `NPC_MODEL`); the same provider is used. `--players generated` needs `--showcase` and `--live` (a one-line usage error otherwise; mock and CI runs are unchanged). The summary counts the player lines apart from AI character replies and Game Master verdicts and reports how many generated lines repeated the scripted line verbatim (an observation, not a failure); the `showcase.players` JSON section has `generated`, `scriptedFallbacks`, `verbatimRepeats` and `cutReplies`, and the run has the extra check `S-15` (15 instead of 14 checks). The player calls add about one model call per scripted line; `--live` prints the expected count.

**Scene guards.** Every scripted line and the safety-net advance name the scene they belong to (`expectSceneId`, an optional field of the `say` and `command` WebSocket messages; clients that omit it behave exactly as before). If the scene ended in between (a time box in a live run, the Game Master), the server refuses the message with `stale_scene` and appends nothing; the showcase records `scene changed under us: ...`, carries on in the actual scene and never skips one. A scene that ended by a time box before its first line is an observation; one that was left with no scripted line any other way fails S-13. Lines left unspoken after an early Game Master exit are recorded too. In a live run the 1 s ticker can judge a scene while a line is being recorded, before the characters answer, so before concluding "GM did not exit" the showcase asks the Game Master for one more evaluation of the full turn (only if the scene was already evaluated; the ticker keeps running, so time boxes stay real). With `--max-lines 2` scenes 1, 3 and 6 (players only, two utterances) get no Game Master evaluation and end by the facilitator advance.

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
  Game Master: 14 evaluations (6 true, 8 false); exited: s1_huddle, s2_priya_call, s3_internal_huddle, s4_escalation_call, s5_final_terms, s6_wrap_up
  Scenes played: 6 (ended by Game Master 6, time box 0, facilitator advance 0)
  Player-bot lines: 24; AI character replies: 20 (0 canned fallback)
  Facilitator advances: 0
  Alerts: 0
  Total wall time: 0.0 s
```

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
services/runtime    session engine, NPC agents, Game Master, WebSocket server, terminal client, demo runner (src/demo)
scenarios/          playable scenarios (YAML): friday-escalation (3 scenes, 1 AI character) and friday-escalation-extended (6 scenes, 2 AI characters, plus the showcase.yaml script for `pnpm demo --showcase`)
docs/               architecture, release plan, plans and the generated plan dashboard
```

### Project tracking and workflow

The repository uses PlanVisualizer (npm-based tooling in `tools/`, spec in `plan_visualizer.md`) for planning (`docs/RELEASE_PLAN.md`, `docs/BUGS.md`, `docs/TEST_CASES.md`). Regenerate the dashboard with `npm run plan:generate` and open `docs/plan-status.html`. Its own tests run with `npm run plan:test`.

Work follows `feature/*` → `develop` (pull request) → `main` (pull request). `main` and `develop` are protected and every pull request must pass the required CI checks (Lint, Test & Coverage Gate, Build, Orchestrator Validation, Dependency Audit, Secret Scanning, Analyze JavaScript). CI also runs Workspace Typecheck, Workspace Tests (with the per-package 80% coverage gate), SDK Import Guard, Workspace Audit, Docker Build and Demo Run (the unattended demo, `pnpm demo --fast`) for the TypeScript workspace. Conventions are in [AGENTS.md](AGENTS.md).

## Known limitations

- **No authentication.** Anyone who can reach the server's port can join as facilitator (full event stream, whispers, NPC goals, Game Master reasoning, start/command control) or claim any unclaimed player role and read its brief and private facts. A role is freed when its connection closes (a connection that stops answering heartbeat pings is dropped within about 30 seconds). The server binds all network interfaces. Run it on a trusted local network only. A facilitator token is the planned fix.
- NPC hidden facts are loaded and kept out of prompts, but nothing releases them yet, so they never surface in play; a facilitator release command is planned.
- Text only: no voice, no web or Teams client yet.
- One session per server process.
- Sessions are not resumed after a restart: on start, an earlier log for the same session id is moved aside as `data/sessions/<id>.<timestamp>.jsonl` and a fresh session begins. The move uses a hard link and falls back to a file copy, so the data directory's filesystem must support one of the two.
- Two server processes on the same data directory and session id will rotate each other's log file; use a different `SESSION_ID` (or data directory) per process.
- NPCs are a scripted mock unless you configure a model provider.
- No scoring or feedback reports yet; sessions are recorded for later.

## License

[MIT](LICENSE) © 2026 Kamal

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

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
- An **Anthropic API key** (optional; without one the NPCs use a scripted mock)

## Install

```bash
git clone https://github.com/ksyed0/ai-coaching-rpg.git
cd ai-coaching-rpg
pnpm install
cp .env.example .env        # defaults to MODEL_PROVIDER=mock, no key needed
```

To use a real model for the NPCs and Game Master, edit `.env`:

```bash
MODEL_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

`.env` is git-ignored. Never commit it.

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
| `MODEL_PROVIDER` | `mock` | `mock` or `anthropic` |
| `ANTHROPIC_API_KEY` | – | Required when `MODEL_PROVIDER=anthropic` |
| `NPC_MODEL`, `GM_MODEL` | `claude-sonnet-4-5` | Model for NPC replies / the Game Master |
| `RUNTIME_PORT` | `8080` | Port the server listens on |
| `SCENARIO_DIR` | `scenarios/friday-escalation` | Scenario folder (relative paths resolve from the repository root) |
| `SESSION_ID` | `local` | Session id clients join (`--session`) |
| `DEPLOYMENT_STAGE` | `local` | Present in `.env.example` but not read by the code yet |
| `RUN_LIVE_MODEL_TESTS` | unset | Set to `1` (with a key) to run the live-API contract tests. Costs money; off by default |

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
```

The default test run never calls a real model or touches the network.

### Layout

```
packages/events     session event types and the state reducer
packages/script     scenario schema, loader, validator, scene state machine
packages/adapters   model provider adapters (mock, Anthropic)
services/runtime    session engine, NPC agents, Game Master, WebSocket server, terminal client
scenarios/          playable scenarios (YAML)
docs/               architecture, release plan, plans and the generated plan dashboard
```

### Project tracking and workflow

The repository uses PlanVisualizer (npm-based tooling in `tools/`, spec in `plan_visualizer.md`) for planning (`docs/RELEASE_PLAN.md`, `docs/BUGS.md`, `docs/TEST_CASES.md`). Regenerate the dashboard with `npm run plan:generate` and open `docs/plan-status.html`. Its own tests run with `npm run plan:test`.

Work follows `feature/*` → `develop` (pull request) → `main` (pull request). `main` and `develop` are protected and every pull request must pass the required CI checks (Lint, Test & Coverage Gate, Build, Orchestrator Validation, Dependency Audit, Secret Scanning, Analyze JavaScript). CI also runs Workspace Typecheck, Workspace Tests (with the per-package 80% coverage gate), SDK Import Guard, Workspace Audit and Docker Build for the TypeScript workspace. Conventions are in [AGENTS.md](AGENTS.md).

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

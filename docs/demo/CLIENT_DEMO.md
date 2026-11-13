# Client demo: cue card (SceneCoach.ai v0.2.1, all local)

Scenario: **The Friday Escalation** (`scenarios/friday-escalation`, 3 scenes, 4 roles). Model: Qwen3.8-27B on LM Studio (`192.168.139.3:1234`), a reasoning model, so AI replies take about 6 to 30 s. Plan around the pauses (see "Filling the silence").

## Roles in the demo

| Role | Who plays it |
| --- | --- |
| Facilitator | You, Chrome profile A, `http://localhost:3000/console` |
| `delivery_lead` | Human 1: Chrome profile B (or a colleague) |
| `account_manager` | Human 2: **Firefox** (a second incognito window shares Chrome's cookie jar and would overwrite seat 1) |
| `tech_lead` | **AI player** (in scenes 1 and 3 only; not in scene 2) |
| `client_sponsor` (Priya) | AI character (scene 2 only) |

Always use exactly `http://localhost:3000`, never `127.0.0.1` (every POST would be refused).

## Before the client arrives (T-60 to T-15 min)

1. LM Studio host awake and reachable; `qwen3.8-27b-uncensored-splash` loaded, idle auto-unload off. Venue network can reach `192.168.139.3`.
2. Fresh Terminal (not this Claude shell): `cd` to the repo worktree, then `docs/demo/demo-up.sh check`. All lines must say `ok`. (`check` needs ports 3000 and 8787 free, so run it while the stack is stopped.)
3. `docs/demo/demo-up.sh` (leave it running). Control log: `~/.scenecoach/logs/control.log`.
4. `docs/demo/demo-up.sh secret` copies the console secret to the clipboard. Paste it when signing in; never show it.
5. **Rehearse once, end to end** (below), and keep that rehearsal as the "one I prepared earlier". Screen-record it as the last-resort fallback.
6. Close `.env`, terminals with secrets, and any open Hidden facts list before sharing the screen. End every rehearsal session so they do not fill the 10-session limit.

## Live script (about 25 min)

**1. Framing (2 min).** Practising hard conversations with AI characters, a Game Master and a facilitator. What is real today: text, browser, facilitator console, AI players, evaluator and reports. Roadmap only: voice, 3D, branding, multi-client, French.

**2. Create the session (3 min).** Console, sign in, **New session**, pick *The Friday Escalation*. Codes are shown once: copy them (do not read them out). On the readiness screen click **Make AI player** on `tech_lead`; point at the AI label and the consent notice that says a seat may be played by an AI.

**3. Humans join (3 min).** The console shows each role's code once but no ready-made player link (the code is never put in a URL). The join link is `http://localhost:3000/join?session=<id>&role=<role>`: `<id>` is the last part of the console URL (`/console/<id>`), and the roles are `delivery_lead` and `account_manager`. Run `docs/demo/demo-up.sh links <id>` in a second terminal to print both full URLs, ready to paste into the other browsers. Each human opens their own URL in their own browser, types a name and **their own code**, then agrees to the consent notice. **Start** stays disabled ("Waiting for: ...") until both consent and the AI bot has joined. Press **Start**.
- Players must be on this Mac: the seat cookie is `Secure`, and browsers accept it over plain HTTP only on `localhost`. Remote players need an HTTPS front end and `PUBLIC_ORIGIN` set to it, which this kit does not set up.

**4. Scene 1, Team huddle (3 to 4 min).** Priya's email arrives. Humans talk; the AI tech lead answers after about 4 s of quiet.
- Cue: **Send whisper** to one human (shows under "Updates").
- Cue: **Prompt AI player** with a hint such as "worry about the six-week estimate" (works only in scenes 1 and 3, and not while paused). Show **Show recent turns**.
- Cue: **Pause**, explain, **Resume**.
- When the team states a position the Game Master may end the scene; otherwise press **Move on**.

**5. Scene 2, Call with Priya (4 to 5 min).** The AI tech lead is not in this scene.
- Humans negotiate with Priya (AI character).
- Cue: **Fire inject** `cfo_pressure` by hand (it is set for minute 7 and goes to Priya only).
- When a player explains the risk and offers a phased delivery, the Game Master may suggest releasing Priya's hidden fact. Open **Hidden facts** (close it again before moving on), then **Release fact**.
- Press **Move on** when the call has made its point. Scene 2 ends by Move on in nearly every run.

**5b. Scene 3, Internal wrap-up (2 to 3 min).** Owners and next steps. Prompt the AI player again if scene 1 was skipped. **End session** with a closing message.

**6. Reports (5 min), on the prepared session.** Order matters: **Evaluate** (up to 6 model calls, slow) then **Review** (edit a level, accept, comment), **issue a report link** for a human role, the participant opens it and **self-rates**, **then Release**, participant reloads and reads the released report. A role that is already released shows the report, not the self-rating form. The AI player gets no link and is not scored.
- Say on screen: the evaluator is not yet validated against human raters. Reports will show "not calibrated" and "this report includes AI players: this case is not covered by the calibration baseline".

**7. Roadmap and Q&A (2 min).**

## Filling the silence (Qwen is slow)

- Explain what the Game Master is doing while it thinks (it judges exit conditions every 3 lines).
- Show the console live view: transcript, talk time, AI players panel.
- If a reply takes over a minute, **Whisper** or **Fire inject** to keep momentum, or **Move on**.

## If something goes wrong

| Symptom | Do this |
| --- | --- |
| AI lines read `[mock reply]` | The `.env` was not loaded. Stop, run `docs/demo/demo-up.sh check`, restart the control service, create a NEW session (running sessions keep old settings). |
| Priya says "Sorry, you cut out for a second there" | Model timed out. Ask the player to repeat; if it keeps happening switch to the recording. |
| A player's seat is stuck or overwritten | Facilitator **Reissue code** for that role; the player rejoins in their own browser. |
| Page refuses actions | You are on `127.0.0.1`; use `localhost`. |
| Start disabled | Read the reason under the button (someone has not consented, or the AI bot has not joined). |
| LM Studio down | Screen recording of the rehearsal. Cloud fallback: `MODEL_PROVIDER=openrouter` with a fresh key (the pasted key is still unrotated). |

## Facts to know

- AI player and AI character lines are always labelled. A participant can talk an AI into revealing its role's private facts; fencing reduces it.
- `pnpm demo --fast` is a terminal checklist of the mock model, not a browser fallback.
- The model name is shown in the console. It is an uncensored model whose guardrails are only in the character prompts; keep the hidden-facts list closed and steer off-topic remarks.
- Never restart the control service with new `COOKIE_KEYS` during a session: it signs everyone out (the launcher keeps them in `~/.scenecoach/demo.env`).

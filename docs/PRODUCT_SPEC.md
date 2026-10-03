<!--
Exported 2026-10-02 from the Claude doc "AI Coaching RPG — Product Specification"
(https://claude.ai/artifact/1grc9sm7BBHbotTgJEh9VX, revision 37). This file is a snapshot;
re-export from the Claude doc to refresh it. Referenced as "Spec §n" by docs/ARCHITECTURE.md
and the implementation plans.
-->

# AI Coaching RPG — Product Specification

Oct 1, 2026 · @Kamal  M. Syed

The AI Coaching RPG is a multiplayer, script-driven role-play simulator that trains teams on real-world situations, records and transcribes everything said, and scores individuals and the group against defined learning objectives and rubrics. This specification is the working source of truth for scope, design and sequencing across the product lifecycle.

## 1. Vision and problem

Teams learn judgement under pressure by practising it, not by reading about it. Today that practice is expensive: live role-play needs a skilled facilitator, trained actors or peers playing counterparts, and a note-taker, and the feedback that follows is subjective, inconsistent and rarely tied back to the objectives the programme set out.

The AI Coaching RPG turns a written scenario into a playable, multiplayer simulation. A scenario author scripts the situation, the roles, the twists and the learning objectives. A team joins a session and plays their own roles while AI agents play everyone else (the difficult client, the regulator, the stressed colleague). The platform records and transcribes the whole interaction, then scores each participant and the group against the rubric, with quoted evidence, and produces a facilitator-ready debrief.

The product exists to make high-quality, repeatable, measurable team practice available on demand, at a fraction of the cost of a facilitated workshop, with feedback that is consistent from session to session and cohort to cohort.

**Design principles**

- Script-first: everything the simulation does is driven by an author-editable script, so L&D owns the content without engineering help.
- Humans play humans: participants are real people interacting with each other; AI fills the roles nobody on the team should play.
- Evidence over opinion: every score links to a timestamped quote from the transcript.
- Facilitator in the loop: the AI drafts feedback; a human can review, adjust and release it.
- Safe to fail: sessions are private to the cohort, and recordings are governed by explicit consent and retention rules.

**A game world, not a chat window.** The session runs in a real 2D or 3D scene built on an existing game engine: participants and NPCs appear as avatars in a level (a boardroom, a trading floor, an incident bridge) with idle animations, gestures and selectable actions. Levels and avatars come from a library or are imported in standard formats, and everything in the scene is driven by the same script that drives the dialogue.

**Runs on a laptop first.** The MVP runs entirely on one machine with a single command; participants join from their browsers over the LAN or a tunnel, and only model and speech calls leave the machine (or none, with local models for an offline demo). The same containers move unchanged to a cloud for the pilot and to Kubernetes for enterprise use. The technical design is in the companion document *Architecture.md*.

## 2. Users and personas

Four personas use the product; the first two are the primary buyers and the third is where the value lands.

| Persona | Who they are | What they need from the product | Success looks like |
| --- | --- | --- | --- |
| Scenario author | L&D designer, practice lead or subject-matter expert | Write and test a scenario without code; reuse rubrics across scenarios; version scripts | A new scenario is playable within a day of drafting |
| Facilitator | Programme lead, coach or team manager running the session | Launch sessions, watch progress live, nudge or pause, review AI-drafted feedback before release | Runs a 45-minute session and a debrief with under 30 minutes of prep |
| Participant | Team member being trained (3 to 8 per session) | Clear role brief, low-friction joining, realistic counterparts, feedback that is specific and fair | Can name one concrete behaviour to change after each session |
| Programme sponsor | Head of L&D, delivery leadership, HR | Cohort-level trends against objectives, completion and engagement data, audit trail | Can show measurable movement on target competencies across a quarter |

**Initial target segment.** Professional services and financial services delivery teams practising client-facing situations: escalations, scope negotiations, difficult status conversations, incident communication and stakeholder alignment. The same engine applies to sales, support, leadership and compliance training later.

## 3. Core concepts

The product is built on a small vocabulary that authors, facilitators and the system all share.

| Concept | Definition | Owned by |
| --- | --- | --- |
| Scenario | A complete, reusable training package: context, roles, script, rubrics, learning objectives and facilitator notes | Scenario author |
| Learning objective | A statement of what participants should be able to do after the session, mapped to one or more rubric criteria | Scenario author |
| Rubric | A set of criteria, each with behavioural descriptors at defined levels (for example 1 to 4), used to score participants and the group | Scenario author (reusable library) |
| Script | The ordered sequence of scenes, triggers and injects that drive the session | Scenario author |
| Scene | A bounded segment of play with its own setting, goal, participants, time box and exit conditions | Scenario author |
| Inject | A scripted event dropped into a scene (an email arrives, a stakeholder changes position, a deadline moves) on a timer, a trigger or a facilitator action | Scenario author or facilitator |
| Role | A character in the scenario. Player roles are assigned to participants; NPC roles are played by AI agents | Scenario author |
| NPC (non-player character) | An AI-played role with a persona, goals, knowledge, hidden information and behavioural guardrails | Scenario author |
| Game Master (GM) | The orchestrating AI that advances the script, fires injects, keeps NPCs consistent and tracks scene exit conditions | System |
| Session | One run of a scenario with a specific team on a specific date, producing a recording, transcript and feedback | Facilitator |
| Cohort | A group of participants progressing through a programme of sessions | Programme sponsor |
| Transcript | Time-coded, speaker-attributed text of everything said and written in a session | System |
| Evidence | A quoted transcript excerpt linked to a rubric criterion and a score | System (reviewed by facilitator) |
| Debrief | The feedback package for a session: individual reports, a group report and facilitator talking points | System and facilitator |
| Level (map) | A 2D or 3D environment a scene plays in, with named spawn points, seats, props and cameras the script can reference; chosen from the library or imported in a standard format | Scenario author (library curated by L&D) |
| Avatar | The character model a participant or NPC appears as, with idle animations, gestures and a set of selectable actions (wave, nod, raise hand, point at the screen) | Participant (own), scenario author (NPCs) |
| Action | A named, scriptable thing an avatar can do in the scene: a gesture, moving to a spawn point, handing over a prop, opening a document on the screen | Scenario author (library), participant (triggers) |

## 4. How it works end to end

&#91;embedded content: end-to-end flow · 3 stages, 12 steps\]

An author publishes a versioned scenario; a facilitator runs it with a team while the Game Master and NPCs play the script; the recording is transcribed, scored and moderated before reports go out. Scores and transcripts feed back into the next version of the scenario, so content improves with every cohort.

## 5. Functional requirements

Requirements are grouped by capability area and prioritised MoSCoW-style for the first release (M = must, S = should, C = could, W = won't for now). Each has an ID for traceability into backlog and test plans.

**5.1 Scenario authoring**

| ID | Requirement | Priority |
| --- | --- | --- |
| AUT-01 | Author creates a scenario with title, context, audience, duration, learning objectives and facilitator notes | M |
| AUT-02 | Author defines player roles and NPC roles, each with a private brief, goals and known facts | M |
| AUT-03 | Author writes a script as an ordered list of scenes, each with goal, participants, time box, exit conditions and injects | M |
| AUT-04 | Author attaches rubrics from a library or creates new ones; each criterion maps to at least one learning objective | M |
| AUT-05 | Scripts are stored as a structured, human-readable text format (see section 6) and can be imported and exported | M |
| AUT-06 | Author can test-run a scenario solo, playing any role, before publishing | M |
| AUT-07 | Scenarios are versioned; a session always records which version it ran | M |
| AUT-08 | AI-assisted drafting: generate a first draft of NPC personas, injects or rubric descriptors from a brief | S |
| AUT-09 | Branching: injects and scene transitions can be conditional on what has happened so far | S |
| AUT-10 | Scenario templates by domain (escalation, negotiation, incident, feedback conversation) | C |
| AUT-11 | Marketplace or cross-tenant sharing of scenarios | W |

**5.2 Session setup and lobby**

| ID | Requirement | Priority |
| --- | --- | --- |
| SES-01 | Facilitator schedules a session, picks a scenario version and invites participants by email or link | M |
| SES-02 | Participants join from a browser with no install; join flow completes in under 2 minutes | M |
| SES-03 | Facilitator assigns roles manually or lets the system assign them randomly or by rotation across sessions | M |
| SES-04 | Each participant sees only their own role brief; shared context is visible to all | M |
| SES-05 | Recording consent is captured per participant before play starts and is stored with the session | M |
| SES-06 | Facilitator can run a session without being a player, or can take a role | S |
| SES-07 | Calendar integration (Google, Microsoft 365) for scheduling and reminders | C |

**5.3 Live session runtime**

| ID | Requirement | Priority |
| --- | --- | --- |
| RUN-01 | Participants interact through voice and text chat in a shared session view | M |
| RUN-02 | NPCs respond in character, in real time, by text; voice responses with low latency | M (text and voice) |
| RUN-03 | The Game Master advances scenes on time box, exit condition or facilitator command | M |
| RUN-04 | Injects are delivered as in-world artefacts (an email, a document, a message) to the right roles only | M |
| RUN-05 | Facilitator console shows live transcript, scene progress, timer and who has spoken how much | M |
| RUN-06 | Facilitator can pause, skip a scene, fire an inject early, whisper a hint to a player or adjust an NPC's stance | M |
| RUN-07 | Private channels: a player can speak to one NPC or one player without the group hearing | S |
| RUN-08 | Shared whiteboard or document that players can edit during a scene | C |
| RUN-09 | Reconnect handling: a dropped participant rejoins with the transcript so far | M |

**5.4 Recording and transcription**

| ID | Requirement | Priority |
| --- | --- | --- |
| REC-01 | All audio, text chat, injects, NPC turns and facilitator actions are captured with timestamps | M |
| REC-02 | Speech is transcribed with speaker attribution per participant and per NPC | M |
| REC-03 | Transcript is available within 5 minutes of session end; live transcript during the session | M |
| REC-04 | Transcript segments link to the audio for playback | S |
| REC-05 | Participants can flag a transcript error; corrections are tracked | C |
| REC-06 | Recordings can be deleted by an admin and expire by retention policy | M |
| REC-07 | Speaker identification: in the standalone view each participant's audio arrives on its own track, so speech is attributed to their signed-in identity; inside Teams or Zoom it comes from the meeting roster; voice enrolment is a fallback only where audio arrives mixed, with manual correction by the facilitator | M |

**5.5 Assessment and feedback**

| ID | Requirement | Priority |
| --- | --- | --- |
| ASM-01 | Each participant is scored on every rubric criterion with a level, a rationale and quoted evidence | M |
| ASM-02 | The group is scored on team-level criteria (shared understanding, decision quality, role clarity, escalation discipline) | M |
| ASM-03 | Feedback reports are drafted automatically and held for facilitator review before release | M |
| ASM-04 | Facilitator can edit scores, rationale and comments and the edit history is kept | M |
| ASM-05 | Participants receive a personal report with strengths, development points and two or three suggested next actions | M |
| ASM-06 | Confidence indicator on each score where the evidence is thin | S |
| ASM-07 | Participants can respond to feedback and self-assess against the same rubric | S |
| ASM-08 | Calibration mode: two evaluators (AI and human, or two humans) score blind and differences are surfaced | C |
| ASM-09 | Default result visibility is the participant, their line manager, the facilitator, L&D and HR; the facilitator can share a report with additional named SSO users; line-manager mapping comes from the SSO directory; the consent screen states who will see results | M |

**5.6 Reporting and analytics**

| ID | Requirement | Priority |
| --- | --- | --- |
| RPT-01 | Session report: scores by participant and criterion, group score, talk-time distribution, scene timeline | M |
| RPT-02 | Cohort dashboard: trend by criterion across sessions, completion, participation | S |
| RPT-03 | Export of transcripts and reports (PDF, CSV, DOCX) | S |
| RPT-04 | Learning management system (LMS) integration via SCORM or xAPI | C |

**5.7 Administration**

| ID | Requirement | Priority |
| --- | --- | --- |
| ADM-01 | Tenant workspace administered by a central L&D team (admin role), with author, facilitator and participant roles granted by the admin to specific users | M |
| ADM-02 | Single sign-on (SAML or OIDC); every user is identified by their SSO identity, and role grants are made against SSO user IDs or groups | M |
| ADM-03 | Retention and deletion policies per tenant | M |
| ADM-04 | Audit log of who viewed or exported recordings, transcripts and reports | M |
| ADM-05 | Model and prompt configuration per tenant (provider, region, temperature, guardrails) | S |
| ADM-06 | Admins grant and revoke authorship and editing rights per scenario or per rubric to named SSO users or groups; the rubric library is owned by the central L&D team and programme leads edit only what they are granted | M |

**5.8 Game world: engine, levels and avatars**

| ID | Requirement | Priority |
| --- | --- | --- |
| WLD-01 | The session scene is rendered by an existing game engine (see section 9); the product does not build its own renderer, physics or animation system | M |
| WLD-02 | Everything in the scene is scriptable from the scenario script: which level loads, where each role spawns, camera framing per scene, props, and actions triggered by injects or by the Game Master | M |
| WLD-03 | Level library: a curated set of environments (boardroom, open-plan office, client site, incident bridge, trading floor) selectable per scene | M |
| WLD-04 | Level import: authors upload their own level in glTF 2.0 (.glb) with a small manifest that names spawn points, seats, screens and props; the app validates the manifest and previews the level | S |
| WLD-05 | Avatar library: participants pick an avatar and customise it (body, hair, skin tone, clothing) before their first session; the choice is remembered | M |
| WLD-06 | Avatar import: participants or authors import avatars in glTF 2.0 or VRM 1.0, with a standard humanoid rig so library animations apply | S |
| WLD-07 | Idle animations: avatars have semi-realistic idle, listening and speaking states; the speaking state is driven by live audio so the speaker is visibly animated | M |
| WLD-08 | Gestures and actions: a participant can trigger a selectable action (wave, nod, shake head, raise hand, point, hand over a document) from a quick menu or hotkey; NPCs trigger the same actions from the script | M |
| WLD-09 | Avatar lip sync for NPC voice and for participants' live speech | S |
| WLD-10 | Camera modes: fixed cinematic framing per scene, free look for the facilitator, first-person for participants | S |
| WLD-11 | 2D mode: a top-down or illustrated-panel rendering of the same scene for low-spec machines and accessibility, using the same script and level manifest | C |
| WLD-12 | Actions, gestures and movements are logged with timestamps alongside the transcript so the evaluator can use non-verbal evidence where the rubric asks for it | S |

**5.9 User interface surfaces**

The product has five surfaces. Each is listed with who uses it, what it must let them do, and what ships in the MVP versus v1. The screen-level design lives in *Architecture.md*, section 6.

| ID | Surface | Who | What it must let them do | MVP | v1 |
| --- | --- | --- | --- | --- | --- |
| UI-01 | Authoring Studio | Scenario author | Browse scenarios and versions; edit metadata, roles, rubrics and the script; validate; test-run solo from any scene; publish an immutable version | YAML editor with schema autocomplete and inline errors, asset pickers, test-run, publish | Form-based editors for roles and rubrics, scene cards with an inject timeline, AI drafting assistant, version diff |
| UI-02 | Lobby | Facilitator, participant | Schedule and invite; assign roles; pick and customise an avatar; give consent; check microphone and camera; join | Yes | Calendar integration, rotation-based role assignment |
| UI-03 | Session view | Participant | See the 3D scene and the private role brief; speak and type; trigger actions and gestures; receive inject artefacts; reconnect | Yes | Private channels, shared whiteboard, 2D mode |
| UI-04 | Facilitator console | Facilitator | Watch the live transcript, scene progress and timers, talk-time; pause, advance, fire an inject, whisper, change an NPC stance; after the session, review scores with evidence, edit with a reason, release and share reports | Transcript, scene controls, score moderation and release | Full console with talk-time, GM reasoning log, calibration view |
| UI-05 | Admin console | Central L&D admin | Manage users and grants, the rubric library, retention policy, provider and model configuration; search the audit log | Configuration files loaded at startup | Full console |

Design rules across surfaces: the scenario is always the YAML package in section 6, whichever view edits it; validation runs the same code in the editor, on save and at session start; a test-run is an ordinary session flagged as a test and excluded from reports; every surface is keyboard-navigable and the session view has a text-only mode.

## 6. Scenario script format

A scenario is a folder of plain-text YAML files so it can be authored in the app, edited in any text editor, diffed and version-controlled. The structure below is the proposed v1 schema; the worked example is a delivery escalation scenario.

```markdown
scenario/
  scenario.yaml      # metadata, objectives, duration, audience
  roles/             # one file per role (player or NPC)
  script.yaml        # scenes, injects, exit conditions
  rubrics/           # one file per rubric, reusable across scenarios
  assets/            # documents, emails, data the injects reference
```

**scenario.yaml**

```markdown
id: esc-scope-creep-01
title: The Friday Escalation
version: 1.2
audience: Delivery leads and project managers
duration_minutes: 45
players: { min: 3, max: 5 }
context: >
  A fixed-fee data platform programme is six weeks from go-live. The client
  sponsor has emailed asking for a "small" additional reconciliation module
  before launch and expects an answer by end of day Friday.
learning_objectives:
  - id: LO1
    statement: Separate the client's stated request from their underlying need before responding
    rubric_criteria: [discovery, listening]
  - id: LO2
    statement: Protect scope and margin while preserving the relationship
    rubric_criteria: [negotiation, commercial_judgement]
  - id: LO3
    statement: Align the delivery team on one position before engaging the client
    rubric_criteria: [team_alignment, role_clarity]
rubrics: [individual_delivery_v2, group_collaboration_v1]
facilitator_notes: >
  Common failure mode is agreeing to the module in scene 2 without pricing it.
  Let it happen; the debrief is where the learning lands.
```

**roles/client\_sponsor.yaml** (an NPC)

```markdown
id: client_sponsor
name: Priya Raman
type: npc
title: VP Operations, client side
persona: >
  Direct, time-poor, under pressure from her CFO. Likes the team but is
  testing whether they will push back. Respects clear reasoning; dislikes
  being told "we'll take it away and come back".
goals:
  - Get the reconciliation module before go-live
  - Avoid a change request going to her CFO
knowledge:
  - The CFO has already asked why the programme costs what it does
  - The module was in an early scope draft but was removed in contract negotiation
hidden:
  - Would accept a phased delivery after go-live if the risk is explained well
guardrails:
  - Never reveal hidden information unless a player asks a question that earns it
  - Stay professional; frustration shows as brevity, not rudeness
  - Do not invent contractual facts beyond the knowledge list
voice: { style: warm-but-brisk, pace: fast }
```

**roles/delivery\_lead.yaml** (a player role)

```markdown
id: delivery_lead
type: player
brief: >
  You run the programme day to day. Margin is already thin. You want to keep
  Priya happy without eating the cost of the module.
private_facts:
  - The module is roughly 6 person-weeks of work
  - Your account lead has hinted that a renewal is being discussed
```

**script.yaml**

```markdown
scenes:
  - id: s1_huddle
    title: Team huddle
    goal: Agree the team's position before replying to the client
    participants: [delivery_lead, tech_lead, account_manager]
    time_box_minutes: 10
    opening_inject: email_from_priya
    exit_when:
      any_of:
        - time_box_elapsed
        - facilitator_advance
        - gm_detects: "team states a single agreed position"
  - id: s2_client_call
    title: Call with Priya
    goal: Respond to the request and agree next steps
    participants: [delivery_lead, account_manager, client_sponsor]
    time_box_minutes: 15
    injects:
      - id: cfo_pressure
        at_minute: 7
        to: [client_sponsor]
        content: "Priya's CFO messages her during the call asking for an update."
        effect: client_sponsor.goals += "Get a yes on this call"
    exit_when: { any_of: [time_box_elapsed, facilitator_advance] }
  - id: s3_internal_wrap
    title: Internal wrap-up
    goal: Capture decisions, owners and the message to the wider team
    participants: [delivery_lead, tech_lead, account_manager]
    time_box_minutes: 8
    exit_when: { any_of: [time_box_elapsed, facilitator_advance] }
```

**Format rules**

- Every `id` is unique within the scenario and stable across versions so evidence and analytics stay comparable.
- `exit_when` conditions are evaluated by the Game Master; `gm_detects` conditions are natural-language and are logged with the GM's reasoning.
- Injects can target players, NPCs or both; an inject to an NPC changes its goals or knowledge, an inject to a player appears as an artefact.
- The app validates the schema on save and on publish, and shows unmapped learning objectives and unused rubric criteria as warnings.

## 7. Assessment model

Assessment is rubric-driven, evidence-backed and reviewed by a human before anyone sees it. The model has four layers: rubrics define what good looks like, the evaluator scores against them, the facilitator moderates, and reports present the result.

**7.0 Competency framework (proposed)**

Rubrics sit on two layers. The core layer is a small, stable set of behavioural competencies that every rubric criterion maps to, so results can be compared across scenarios, programmes and cohorts. The domain layer is scenario-specific criteria (commercial judgement, incident communication, regulatory escalation) that an author adds for one scenario or family of scenarios.

For the core layer the proposal is to adopt the behavioural factors from [SFIA 9](https://sfia-online.org/en/sfia-9/responsibilities/generic-attributes-business-skills-behaviours/generic-attributes-a-z), the Skills Framework for the Information Age, which is freely available, widely used in technology and delivery organisations, and already defines these behaviours at seven levels of responsibility. The seven factors relevant to live role-play are the core competencies; the other five (improvement mindset, creativity, digital mindset, learning and development, planning) are better assessed outside a 45-minute session.

| Core competency (SFIA 9 behavioural factor) | What a session can observe | Example rubric criteria that map to it |
| --- | --- | --- |
| Communication | Clarity, structure, listening, adapting the message to the audience | Clarity, Listening, Discovery |
| Collaboration | Building on others, sharing information, agreeing a joint position | Team alignment, Role clarity, Airtime balance |
| Decision-making | Choosing a course of action with incomplete information and owning it | Decision quality, Escalation discipline |
| Problem-solving | Separating symptoms from causes, generating and weighing options | Discovery, Negotiation (options with trade-offs) |
| Leadership | Setting direction, holding the team to a position under pressure | Team alignment, Follow-through |
| Adaptability | Responding to injects and changed positions without losing the thread | Response to injects, Composure |
| Security, privacy and ethics | Handling confidential or sensitive information appropriately in the conversation | Information handling, Commercial judgement (contractual facts) |

If a client already has its own leadership or competency model, the core layer is swapped for theirs; the mapping table is the only thing that changes. Rubric levels (1 to 4) stay scenario-specific and are not the SFIA responsibility levels.

**7.1 Rubric structure**

A rubric is a named set of criteria. Each criterion has a short definition and a behavioural descriptor at each of four levels, so the evaluator and the facilitator are judging observable behaviour rather than impressions.

| Criterion (individual\_delivery\_v2) | Level 1: Developing | Level 2: Capable | Level 3: Strong | Level 4: Exemplary |
| --- | --- | --- | --- | --- |
| Discovery | Responds to the stated request without probing | Asks at least one clarifying question about the need | Uncovers the underlying driver and reflects it back | Reframes the conversation around the driver and tests the reframing with the client |
| Listening | Talks over or ignores key points | Acknowledges points but moves on | Summarises and checks understanding | Builds on the other party's words to move the conversation |
| Negotiation | Concedes or refuses without options | Offers one alternative | Offers options with trade-offs made explicit | Lands an option that protects scope and relationship, with next steps agreed |
| Commercial judgement | Does not reference cost, margin or contract | Mentions cost or contract in passing | Quantifies the impact and names the mechanism (change request, phasing) | Positions the commercial path as a benefit to the client |
| Clarity | Rambling or ambiguous | Clear but unstructured | Structured, with a clear ask | Concise, structured, and lands the ask without being asked to repeat it |

Group rubrics follow the same shape with team-level criteria: shared understanding, decision quality, role clarity, airtime balance, escalation discipline and follow-through.

**7.2 Scoring pipeline**

1. Segment: the transcript is split by scene and speaker, with NPC turns and injects kept as context.
2. Tag: for each criterion, the evaluator identifies the transcript segments that are relevant evidence (positive or negative).
3. Score: the evaluator assigns a level per criterion per participant with a rationale citing two or more quotes where available, and a confidence rating (high, medium, low) based on the quantity and clarity of evidence.
4. Aggregate: individual scores roll up to learning objectives via the mapping in the scenario; group criteria are scored from the whole-session transcript.
5. Moderate: the facilitator sees scores, rationale and evidence side by side, can change any score, must give a reason for a change, and releases the report.
6. Report: once released, a participant's report is visible by default to the participant, their line manager, the facilitator, the central L&D team and HR; the group report and cohort view go to the same audience plus the programme sponsor. The facilitator can share any report with additional named users, and every view and share is in the audit log.

**7.3 Fairness and quality controls**

- Scores are never released without a facilitator reviewing low-confidence items; high-confidence items can be auto-released by tenant policy.
- The evaluator is given the rubric descriptors verbatim and is instructed to quote evidence; a score with no quote is flagged.
- Talk time and interruption counts are reported as context, never as a criterion on their own.
- A calibration set of 20 to 30 annotated sessions per rubric is maintained to measure evaluator agreement with human raters; target agreement is within one level on 85% of criterion scores before a rubric is marked production-ready.
- Participants can dispute a score; disputes go to the facilitator and are tracked.

**7.4 What a participant receives**

A one-page report: the scenario and objectives, a score per criterion with one or two quoted moments, two strengths, two development points, and two or three concrete actions to try in the next session. The tone is coaching, not grading; levels are shown as descriptors, with the numeric level available on request.

## 8. AI design

&#91;embedded content: AI design · 9 components, live loop and offline evaluation\]

The live loop is Participants, Session service, Game Master and NPC agents, with speech services turning audio into attributed transcript and NPC text into voice. The Game Master is the only component that reads the script: it decides when a scene ends, which inject fires and what each NPC currently knows and wants. NPC agents never see the rubric or other roles' private briefs. The evaluator runs after the session, reads the full transcript and the rubric, and writes scores with quoted evidence to the store; the facilitator console reads those drafts for moderation.

**Agent responsibilities**

| Agent | Inputs | Outputs | Must never |
| --- | --- | --- | --- |
| Game Master | Script, scene state, transcript so far, facilitator commands | Scene transitions, inject delivery, NPC goal updates, exit-condition log | Speak as a character; reveal hidden information; change scores |
| NPC agent | Role file, scene goal, transcript visible to that role, GM updates | In-character turns (text, optionally voice) | Break character; invent facts beyond its knowledge list; see the rubric |
| Evaluator | Full transcript, rubric descriptors, learning-objective mapping, role briefs | Level, rationale, quotes and confidence per criterion per participant; group scores | Score without a quote; see facilitator identity or prior scores for the same person |
| Drafting assistant (authoring) | Author brief, templates, rubric library | Draft personas, injects, descriptors for the author to edit | Publish without author review |

**Prompt and context design**

- Each NPC turn receives a fixed persona block, the current scene goal, the GM's current goal and knowledge list, and a sliding window of the transcript visible to that role; long sessions use a running summary to stay within context limits.
- NPC latency budget is 1.5 s to first token; a smaller, faster model is acceptable for NPCs and a stronger reasoning model for the GM and evaluator.
- The evaluator scores one criterion at a time per participant with the descriptor text in the prompt, then a second pass checks that every quote exists verbatim in the transcript.
- All prompts are versioned; a session records the prompt and model version for each agent.

## 9. Platform architecture and integrations

The platform is a web application with a real-time session service, an AI orchestration layer and a storage layer, deployed per region so tenants can keep recordings in-country. The AI design in section 8 sits inside the orchestration layer.

| Layer | Responsibility | Proposed technology (v1) |
| --- | --- | --- |
| Web client | Authoring studio, lobby, session view, facilitator console, reports | Next.js (React, TypeScript) hosting the 3D scene from the game engine below; WebRTC for voice |
| API and real-time service | Auth, tenancy, scenario CRUD, session state, WebSocket fan-out | Node.js (TypeScript) or Python (FastAPI); WebSockets |
| AI orchestration | Game Master loop, NPC agents, inject scheduler, evaluator jobs | Python; model-agnostic provider adapter (Anthropic, OpenAI, Azure OpenAI, Bedrock) |
| Speech | Live speech-to-text with diarisation; text-to-speech for NPC voice | Streaming STT provider (Deepgram, Azure Speech or Whisper-based); TTS provider with low-latency streaming |
| Data | Scenarios, sessions, transcripts, scores, audit log | PostgreSQL (Supabase or managed Postgres); object storage for audio and assets |
| Jobs | Post-session transcription finalisation, evaluation, report generation | Queue (Redis or cloud-native) with idempotent workers |
| Identity | SSO, roles, consent records | OIDC/SAML via the identity provider; Supabase Auth or Auth0 for v1 |
| Observability | Latency, cost per session, model errors, evaluator drift | OpenTelemetry, dashboards, per-session cost ledger |
| Game engine | Scene rendering, level loading, avatar animation, cameras, actions, scripting API | Proposed: Babylon.js (web-native, Apache 2.0, first-class glTF and VRM support, runs in a Teams app); alternatives: PlayCanvas, Unity WebGL (see section 13) |

**Engine choice.** Two constraints decide it: participants join from a browser with no install (SES-02), and the pilot runs inside a Teams companion app (section 9, item 2), which is a web view. A web-native engine such as Babylon.js or PlayCanvas loads in seconds, runs inside Teams, and reads glTF 2.0 levels and avatars directly. Unity or Unreal give richer rendering and tooling but ship as a large WebGL build with slower load times, licensing costs and a harder fit inside Teams; they are the better choice only if a native desktop client is accepted later. The recommendation is Babylon.js for the MVP, with the script-to-scene API kept engine-neutral so the engine can change without rewriting scenarios.

**Standard formats.** Levels and avatars use glTF 2.0 (.glb) as the interchange format, with a JSON manifest naming spawn points, seats, screens and props; avatars may also arrive as VRM 1.0, which is glTF with a standard humanoid rig and expressions. Animations ship as glTF animation clips retargeted to the standard rig, so one library of idles, gestures and actions works on every imported avatar. Avatar creation can use an off-the-shelf creator that exports glTF, rather than a bespoke editor.

**Integrations by priority**

1. Calendar (Google, Microsoft 365) for scheduling and reminders.
2. Meeting platform integration (Teams first, then Zoom, from v1): the session runs inside a meeting the team already uses. A meeting bot joins the call to capture audio, receive the platform's speaker-attributed transcript and speak NPC turns; a companion app (Teams app or Zoom app) carries role briefs, injects and the facilitator console. Benefits: no new tool for participants, the platform's audio, recording and SSO, and speaker attribution from the meeting roster so voice enrolment is only needed in the standalone session view. Costs: bot admission must be allowed by the tenant's admin, NPC voice latency depends on the bot media path, and audio transits the meeting provider.
3. LMS via xAPI statements for completion and scores.
4. Export to DOCX, PDF and CSV for reports and transcripts.
5. Webhooks for session events so tenants can build their own automations.

**Model strategy.** Each AI function (GM, NPC, evaluator, drafting assistant) has its own prompt set and can be pinned to a different model and provider. NPCs favour low latency; the evaluator favours reasoning quality and runs offline. Prompts and model versions are recorded per session so results are reproducible and drift can be investigated.

## 10. Non-functional requirements

| Area | Requirement | Target |
| --- | --- | --- |
| Consent and privacy | Explicit per-participant recording consent before play; participants can view and request deletion of their own data | 100% of sessions have consent records; deletion within 30 days |
| Data residency | Tenant chooses region; audio, transcripts and model calls stay in-region | Canada and EU regions at v1; US at MVP |
| Security | MVP: TLS on the browser connection and WebRTC audio, and the host laptop's disk encryption, with no application-level encryption. From v1: mTLS between services, encrypted volumes with customer-managed keys, and field-level encryption of PII (names, consent, transcripts, scores, evidence, audio, reports). Role-based access; audit log on all access to recordings and reports; SSO | SOC 2 Type II readiness by v2 |
| Model data handling | No tenant data used for provider model training; zero-retention agreements with model providers where offered | Contractual, verified per provider |
| Latency | NPC text reply starts streaming within 1.5 s; NPC voice reply starts within 2.5 s; live transcript lag under 3 s | p95 |
| Availability | Session service and recording are the critical path; evaluation can be delayed | 99.5% monthly for session service |
| Scale | Concurrent sessions per tenant and per region | 50 concurrent sessions of 8 participants per region at v1 |
| Transcript accuracy | Word error rate on clear English speech, with diarisation attribution accuracy | WER under 10%; attribution over 95% |
| Evaluator quality | Agreement with human raters within one level | 85% of criterion scores before a rubric is production-ready |
| Accessibility | Keyboard navigation, screen-reader support, captions for all audio, text-only participation mode | WCAG 2.2 AA |
| Cost | Model, speech and storage cost per 45-minute session with 5 participants | Under CAD 15 at v1; tracked per session |
| Resilience | Participant reconnect without data loss; session state persisted every turn | Reconnect within 10 s with full context |
| Localisation | UI and NPCs in English first; French (Canada) UI and NPC support next | English at MVP; French at v2 |
| Speaker identification | In the standalone session view, speech is attributed from each participant's own audio track and signed-in identity; inside Teams or Zoom, from the meeting roster; by enrolled voice profile only as a fallback for mixed audio; voice profiles are biometric data, so they need explicit consent, are stored per tenant and are deleted with the participant's data | Attribution over 95% in sessions of up to 8 speakers; profiles deleted within 30 days of a request |
| Rendering performance | The 3D scene runs smoothly on a standard corporate laptop with integrated graphics, inside a browser or Teams app, with no install | 30 fps or better with 8 avatars on a 2022-era integrated GPU; scene load under 10 s on a 20 Mbps connection; 2D fallback mode available |

## 11. Release roadmap

&#91;embedded content: release roadmap · 4 phases, 3 gates\]

Durations are indicative and to be confirmed once the pilot cohort and team size are known. Each gate is a decision, not a date: the next phase starts only when its criteria are met.

| Phase | Scope | Gate to leave the phase |
| --- | --- | --- |
| Discovery | Confirm the pilot cohort and sponsor, write two scenarios and the first two rubrics with L&D, get HR and legal sign-off on recording and consent, choose model providers and regions | A named pilot cohort, a signed-off consent flow, two playable scripts |
| MVP pilot | Runs locally on a laptop with one command; voice-enabled multiplayer sessions in the standalone browser view with participants joining over the LAN or a tunnel; speaker identification from each participant's own audio track; live speech-to-text; text chat as fallback, a 3D scene with library levels and selectable avatars with idle animations and gestures, scripted NPCs with voice replies and Game Master, live transcript, rubric scoring with evidence, facilitator moderation and release, basic session report | Runs end to end from a single laptop; two cohorts complete a programme; participant usefulness 4 of 5 or better; facilitator edit rate under 25% |
| v1 release | Cloud deployment in the client's region, Teams integration via meeting bot and companion app (Zoom next), field-level PII encryption and mTLS, form-based authoring studio and admin console, voice latency and attribution tuning, transcript playback, level and avatar import (glTF, VRM), lip sync, camera modes, authoring studio over the YAML format, cohort dashboard, SSO, Canada and EU data residency, DOCX and PDF export | Evaluator agreement with human raters within one level on 85% of scores; p95 NPC latency targets met; security review passed |
| v2 release | Branching scripts, calibration mode, LMS integration via xAPI, French (Canada) UI and NPCs, SOC 2 readiness, webhooks | Decided by v1 adoption and sponsor demand |

## 12. Success metrics

The product succeeds when teams practise more often and get measurably better, and when facilitators spend their time coaching rather than preparing.

| Metric | What it tells us | Target (12 months after v1) |
| --- | --- | --- |
| Sessions per participant per quarter | Whether practice becomes a habit | 3 or more |
| Session completion rate | Whether the experience holds attention | 90% of started sessions complete |
| Facilitator prep time per session | Whether the product removes effort | Under 30 minutes |
| Facilitator edit rate on AI scores | Whether the evaluator is trusted | Under 15% of criterion scores changed |
| Participant feedback usefulness | Whether the feedback lands | 4.2 of 5 on the post-session survey |
| Movement on target criteria | Whether people improve | Median gain of 1 level on the two weakest criteria across a 4-session programme |
| Scenario authoring time | Whether L&D can self-serve | New scenario playable within 1 day |
| Cost per session | Whether the economics work | Under CAD 15 all-in |
| Active scenarios per tenant | Whether content grows | 10 or more after 6 months |

## 13. Risks, assumptions and open questions

**Key risks**

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Participants do not trust AI-generated scores | Low adoption; feedback ignored | Facilitator moderation by default, quoted evidence on every score, calibration data published to tenants |
| NPCs break character or invent facts | Session feels fake; wrong lessons learned | Guardrails in the role file, knowledge boundaries, GM consistency checks, facilitator override |
| Voice latency makes conversation stilted | Participants switch to text or disengage | Streaming STT and TTS from the MVP, latency budget tracked per turn, text chat as a fallback in every session |
| Transcription errors on accents, jargon and cross-talk | Wrong evidence, unfair scores | Custom vocabulary per scenario, diarisation tuning, participant flagging, confidence-weighted scoring |
| Privacy and employment-law concerns about recording colleagues | Blocked by HR or works councils | Consent flow that states who sees results (participant, line manager, facilitator, L&D, HR), retention controls, audit log of every view and share, tenant policy on whether results feed performance reviews, HR and legal sign-off during discovery |
| Model and speech costs exceed budget | Unit economics fail | Per-session cost ledger, model tiering, caching of scenario context |
| Authoring is too hard for non-technical L&D staff | Content bottleneck | Authoring studio with forms over YAML, AI drafting assistant, templates |
| Client IT blocks meeting bots or third-party Teams apps | Pilot cannot run inside Teams | Confirm bot and app admission with the pilot tenant's admin during discovery; keep the standalone browser session view as the fallback path |
| The 3D world adds scope and cost, and uncanny avatars distract from the conversation | MVP slips; participants focus on the visuals rather than the role-play | Use an existing engine and off-the-shelf level and avatar assets; keep the MVP to library levels and stylised (not photoreal) avatars; test the scene with the pilot cohort before voice and scoring work depends on it |

**Assumptions**

- Teams of 3 to 8 is the sweet spot; larger groups split into parallel sessions.
- Sessions run on a browser with a microphone; no dedicated hardware.
- A facilitator is present for v1 sessions; fully self-serve sessions are a later goal.
- English is sufficient for the first cohorts.

**Open questions**

- [x] Should the MVP be text-only, or is voice required for the first pilot cohort to find it credible?
- [x] Does the first pilot run inside Teams or Zoom, or in the platform's own session view?
- [x] Who owns rubric design: a central L&D team, or each programme lead? This decides how much rubric library tooling the MVP needs.
- [x] Are individual reports ever visible to line managers? Default is no; confirm with HR and legal before the pilot.
- [ ] Which model providers are approved for pilot tenants, and in which regions?
- [x] Is there an existing competency framework the rubrics must map to?

Decided 1 October 2026: the MVP is voice-enabled, with live speech-to-text and speaker identification that matches each voice to a participant name (RUN-02, REC-07, section 10, section 11 updated).

Decided 1 October 2026: the MVP runs locally on a laptop in the standalone session view; from v1 the platform also runs inside Teams (Zoom next) through a meeting bot and companion app, leveraging the platform's audio, recording, SSO and speaker attribution; the standalone session view remains the fallback where bots are not admitted (section 9, section 10, section 11 and the risk register updated).

Decided 1 October 2026: a central L&D team administers the platform and owns the rubric library; it grants authorship and editing rights to specific users through their SSO identities, so SSO moves to a Must (ADM-01, ADM-02 and new ADM-06 updated).

Decided 1 October 2026: results are visible by default to the participant, their line manager, the facilitator, L&D and HR, and the facilitator can share them further; the consent screen must say so (scoring pipeline step 6, new ASM-09 and the privacy risk updated).

Decided 1 October 2026: there is no existing framework, so the spec proposes a two-layer model with SFIA 9 behavioural factors as the core and scenario-specific criteria on top (new section 7.0); to be validated with the central L&D team.

Decided 1 October 2026: application-level PII encryption, mTLS and key management are out of the MVP and arrive in v1; the MVP keeps TLS on the browser connection and the laptop's disk encryption, and the consent screen says so. The five UI surfaces are defined in new section 5.9, with the YAML studio in the MVP and the form-based studio and admin console in v1.

- [ ] Engine: confirm Babylon.js (web-native, runs inside Teams) over Unity WebGL or PlayCanvas; decide whether a native desktop client is ever acceptable, since that changes the answer.
- [ ] Avatar style: stylised or semi-realistic? Semi-realistic raises asset cost and the uncanny-valley risk; decide with the pilot cohort.
- [ ] Asset sources: which level and avatar packs and which avatar creator are licensed for commercial use by EPAM and its clients?

## 14. Glossary

| Term | Meaning |
| --- | --- |
| Diarisation | Separating a recording into segments by speaker so each line of transcript is attributed to the right person |
| Game Master (GM) | The orchestrating AI that runs the script, fires injects and keeps the session moving |
| Inject | A scripted event introduced into a scene to change the situation |
| MoSCoW | Prioritisation scheme: Must, Should, Could, Won't (for now) |
| NPC | Non-player character; a role played by an AI agent rather than a participant |
| Rubric | A set of criteria with levelled behavioural descriptors used to assess performance |
| STT / TTS | Speech-to-text (transcription) and text-to-speech (NPC voice) |
| WER | Word error rate; the standard measure of transcription accuracy |
| xAPI | A standard for sending learning activity statements to an LMS or learning record store |

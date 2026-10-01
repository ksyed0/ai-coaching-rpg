# Lessons

## L-0001 — PlanVisualizer installs are additive; install only from the released main

@agent: all

**Rule:** Install PlanVisualizer only from a fresh clone of the released `main` branch, never from a local `develop` checkout. `install.sh` copies files but never deletes them, so installing over a different-version install leaves orphaned tools and tests that fail against the new version. When reinstalling, restore your own `AGENTS.md`, `plan-visualizer.config.json` and docs afterwards; the installer replaces a missing `AGENTS.md` with a 7-line stub and resets the config project name.
_Learned when a develop-era install (repository layer needing `proper-lockfile` and `better-sqlite3`) was overwritten by `main` v2.4.0 and 47 test suites failed on 189 leftover files._
**Date:** 2026-10-01

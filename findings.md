# Findings

## Dependencies added for the web client (`apps/web`, US-0056)

All pinned to exact versions. Release dates are the publish date of the pinned version; "last active" is the registry `time.modified` (checked 2026-10-27).

| Package | Version | Purpose | Licence | Released | Last active |
| --- | --- | --- | --- | --- | --- |
| next | 16.4.1 | App Router framework and server | MIT | 2026-10-14 | 2026-10-26 |
| react | 19.3.0 | UI library | MIT | 2026-09-09 | 2026-10-27 |
| react-dom | 19.3.0 | React DOM renderer | MIT | 2026-09-09 | 2026-10-27 |
| ws | 8.22.0 | WebSocket client from the BFF to the runtime | MIT | 2026-09-26 | 2026-09-26 |
| @types/ws | 8.18.2 | Types for ws | MIT | 2026-09-29 | 2026-10-04 |
| @types/react | 19.3.0 | Types for react | MIT | 2026-09-09 | 2026-10-04 |
| @types/react-dom | 19.3.0 | Types for react-dom | MIT | 2026-09-09 | 2026-10-04 |
| @types/node | 22.20.5 | Node types (same line as the other packages) | MIT | 2026-10-01 | 2026-10-09 |
| typescript | 5.9.3 | Typechecking (same version as the workspace) | Apache-2.0 | 2025-09-30 | 2026-10-27 |
| vitest | 5.0.3 | Unit tests (same version as the workspace) | MIT | 2026-09-30 | 2026-10-19 |
| jsdom | 30.1.2 | DOM for component tests | MIT | 2026-10-04 | 2026-10-15 |
| @testing-library/react | 16.3.3 | Component test helpers | MIT | 2026-08-27 | 2026-08-27 |
| @testing-library/dom | 10.4.2 | Required peer of @testing-library/react | MIT | 2026-09-13 | 2026-09-13 |
| @vitejs/plugin-react | 5.2.0 | React transform for vitest (6.x needs Vite 8; the workspace is on Vite 7) | MIT | 2026-03-12 | 2026-10-05 |
| @playwright/test | 1.64.0 | Browser end-to-end tests | Apache-2.0 | 2026-10-07 | 2026-10-27 |
| @axe-core/playwright | 4.13.0 | Accessibility checks in the e2e tests | MPL-2.0 | 2026-08-11 | 2026-10-27 |
| tsx | 4.23.15 | Runs `src/demo/web-demo.ts` and the e2e runtime child (`pnpm demo --web`, US-0065); the version the workspace lockfile already resolves, so no new package | MIT | 2026-09-20 | 2026-09-20 |

## Voice slice A1a (`services/speech`, `packages/adapters/src/speech`, US-0070): no new dependency

No new package (AGENTS.md section 19). WAV encoding and parsing are written by hand (16-bit PCM), the Whisper client uses Node 22's global `fetch`, `FormData` and `Blob`, the speech worker is a `fork()` child over Node's IPC channel, and the tests' HTTP server is `node:http`. The new `@acr/speech` workspace package depends only on workspace packages (`@acr/adapters`, `@acr/events`) and the versions of `zod`, `vitest` and `typescript` the workspace already pins.

## Voice slice A1b (`packages/adapters/src/livekit`, US-0071): LiveKit server SDK

Pinned to an exact version, installed into `packages/adapters` only (`pnpm --filter @acr/adapters add -E`), reachable only through the `@acr/adapters/livekit` subpath (the root index does not load it: `src/__tests__/root-index-imports.test.ts`); `lint:sdk` refuses it anywhere else. Pure JavaScript (no native code); its own dependencies are `jose` 5.10.0, `@livekit/protocol` 1.51.0 and `@bufbuild/protobuf` 1.10.1. `pnpm audit --audit-level high` on 2026-11-08: no high or critical advisory (the 1 low and 4 moderate reported are in the root dev tools, jest and eslint, not in this package's tree). The adapters package also gains the workspace link `@acr/events` (for `isScenarioId` in the identity helpers): no download.

| Package | Version | Purpose | Licence | Released | Last active |
| --- | --- | --- | --- | --- | --- |
| livekit-server-sdk | 2.19.2 | Control mints the per-seat microphone-only and worker LiveKit tokens and calls `removeParticipant` / `listParticipants` / `deleteRoom` | Apache-2.0 | 2026-10-22 | 2026-10-22 |

## Voice slice A1b (`services/speech`, US-0071, batch 3): LiveKit realtime client for the speech worker

Pinned to an exact version, installed into `services/speech` only (`pnpm --filter @acr/speech add -E @livekit/rtc-node@1.2.1`); `lint:sdk` refuses it anywhere else, and inside the worker only `src/ingest/livekit-room.ts` imports it, dynamically and only with `SPEECH_INGEST=livekit` (a file-ingest run never loads it: `imports.test.ts`). It is a **native** package: `@livekit/rtc-ffi-bindings` 0.13.1 ships prebuilt binaries for darwin-arm64, darwin-x64, linux-x64-gnu, linux-arm64-gnu and win32-x64-msvc only (**glibc only: the worker cannot run on Alpine/musl**; the control and runtime images are unaffected because nothing else loads it). Native load checked on this macOS arm64 machine and in the `node:22` (Debian, glibc) container on linux/arm64, as root and as `node` (`pnpm install --frozen-lockfile` fetched the linux-arm64-gnu binary); linux-x64-gnu (the CI runner) is in the lockfile and is exercised by CI (`src/__tests__/livekit-room.test.ts` loads the library). It pulls `pino` ^9 and `pino-pretty` ^13: its JavaScript logger (`dist/log.cjs`, `pino({ name: "lk-rtc" })`, level `debug` unless `NODE_ENV=production`) is not exported, so the worker reaches the module by its resolved file path and sets it to `silent` before any room is opened (several of its warnings quote a participant identity); the native core runs with `captureLogs: true` and its log records are dropped by the library (never printed), and `RUST_LOG` stays out of `SPEECH_ENV_ALLOWLIST`. `pnpm audit --audit-level high` on 2026-11-08: no high or critical advisory (the 1 low and 4 moderate reported are in the root dev tools, jest and eslint, not in this package's tree).

| Package | Version | Purpose | Licence | Released | Last active |
| --- | --- | --- | --- | --- | --- |
| @livekit/rtc-node | 1.2.1 | The speech worker joins each recording seat's LiveKit room hidden, subscribes only to the current holder's microphone track and reads its audio as 16 kHz mono PCM | Apache-2.0 | 2026-10-22 | 2026-10-22 |

## Voice slice A1b (`apps/web`, US-0071, batch 6a): LiveKit browser client for the participant page

Pinned to an exact version, installed into `apps/web` only (`pnpm --filter @acr/web add -E livekit-client@2.23.0`); `lint:sdk` refuses it anywhere else, and inside the web app only `src/lib/livekit-room-browser.ts` imports it (`src/__tests__/source-rules.test.ts`). That wrapper is loaded **lazily**, by a dynamic `import()` on the participant's first "Join with voice" on the session page: no other page and no visit that never joins loads it (the production build puts it in its own chunk, 558 KB, 143 KB gzipped; the session page's own chunks stay at 53 KB). It runs with `setLogLevel("warn")`. Read from the installed source: `setMicrophoneEnabled(false)` only mutes the published track, so the wrapper unpublishes the microphone track explicitly on mute (`unpublishTrack(track, true)`), and `stopMicTrackOnMute` is a publish default (`publishDefaults`), not a room option. New in the lockfile with it: `@livekit/protocol` 1.52.1 (beside the server SDK's 1.51.0), `@types/dom-mediacapture-record` 1.0.22, `events` 3.3.0, `jose` 6.2.16, `loglevel` 1.9.2, `machina` 7.0.1, `rxjs` 7.8.2, `sdp` 3.2.3, `sdp-transform` 2.15.0, `typed-emitter` 2.1.0, `webrtc-adapter` 9.0.6 (`@livekit/mutex` and `tslib` were already there). `pnpm install --frozen-lockfile` passes. `pnpm audit --audit-level high` on 2026-11-09: no high or critical advisory (the 1 low and 4 moderate reported are in the root dev tools, jest and eslint, not in this package's tree).

| Package | Version | Purpose | Licence | Released | Last active |
| --- | --- | --- | --- | --- | --- |
| livekit-client | 2.23.0 | The participant's browser joins its own seat's LiveKit room with a microphone-only token, publishes the microphone, unpublishes it on mute and leaves on every final stream event | Apache-2.0 | 2026-10-16 | 2026-10-16 |

## Exceptions to the two-week rule

- next 16.4.1 was released 13 days before the pick. Every earlier 16.x (up to 16.4.0) and every 15.x is flagged by the npm advisory database (GHSA-673q-mjm6-r5xr and GHSA-2464-fhr4-w9xw, critical remote code execution; GHSA-p3m5-59mp-jv5r, denial of service), and `next build` refuses to run on them. 16.4.1 is the oldest release without an advisory.
- jsdom 30 declares node `^22.22.2`; CI's `node-version: '22'` resolves to the latest 22.x, which satisfies it.

## Build notes

- `dev` and `build` run with `--webpack`: Turbopack has no `resolve.extensionAlias`, so it cannot resolve the `./state.js` style imports inside `@acr/events` (verified: Turbopack fails, webpack builds).
- `@axe-core/playwright` is MPL-2.0 (file-level copyleft, used unmodified as a dev tool only).

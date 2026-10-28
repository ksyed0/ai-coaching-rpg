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

## Exceptions to the two-week rule

- next 16.4.1 was released 13 days before the pick. Every earlier 16.x (up to 16.4.0) and every 15.x is flagged by the npm advisory database (GHSA-673q-mjm6-r5xr and GHSA-2464-fhr4-w9xw, critical remote code execution; GHSA-p3m5-59mp-jv5r, denial of service), and `next build` refuses to run on them. 16.4.1 is the oldest release without an advisory.
- jsdom 30 declares node `^22.22.2`; CI's `node-version: '22'` resolves to the latest 22.x, which satisfies it.

## Build notes

- `dev` and `build` run with `--webpack`: Turbopack has no `resolve.extensionAlias`, so it cannot resolve the `./state.js` style imports inside `@acr/events` (verified: Turbopack fails, webpack builds).
- `@axe-core/playwright` is MPL-2.0 (file-level copyleft, used unmodified as a dev tool only).

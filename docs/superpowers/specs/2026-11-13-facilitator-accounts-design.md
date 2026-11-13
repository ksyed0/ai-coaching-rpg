# Facilitator accounts and admin console: design

Date: 2026-11-13. Status: draft for the owner's approval. Story ids proposed: US-0083 (this design); backlog US-0084 to US-0089 (below). Nothing here is built.

## Intent and why

Today every facilitator signs in to the console with one shared secret (`FACILITATOR_SECRET`) set by whoever deploys the server. There is no way to add or remove a person, no per-person audit, and changing the secret signs everyone out. The name a facilitator types at sign-in is only a label. That cannot run a real client rollout.

The owner wants invite-style accounts managed from a UI: a default admin who creates facilitators (name and email), who then sign in with a generated temporary password and must change it. This design gives each facilitator a real account, lets an admin manage them from the console, and ties each session to the facilitator who created it.

## Goals

1. Two account kinds: **admin** and **facilitator**.
2. A **default admin** exists on first start, with a fixed default password (owner's decision). The admin is **forced to change it on first login**.
3. An **admin screen** lists facilitators (name, email, status: invited, active, revoked) and lets the admin create one, **resend** (issue a new temporary password) and **revoke**.
4. Creating a facilitator generates a temporary password. **For now the credentials are shown once on screen** for the admin to copy (email is backlogged). A facilitator is forced to change the temporary password on first login, then follows the normal console flow.
5. A facilitator sees and runs **only sessions they created**. The admin sees all sessions. Sessions created before accounts exist are visible to the admin only.
6. Persistent data lives in a **local file** in `CONTROL_DATA_DIR` behind a small store interface, so moving to a database later is a swap.
7. Revoking a facilitator or replacing a temporary password takes effect **immediately** (no waiting for a cookie to expire).

## Non-goals (this story)

- Sending email (backlog: US-0084). The credentials screen is the delivery mechanism for now.
- A database (backlog: US-0085). SSO or OIDC (US-0086). A separate auth service (US-0087, owner's option C). Password complexity rules (US-0088; the first-login change only requires a new, different, non-empty value of a minimum length chosen by the builder). Per-client tenant admins, tied to EPIC-0008 (US-0089).
- Multi-factor authentication, self-service password reset, account lockout beyond throttling.

## Anti-goals (a failure even if it "works")

- Passwords or temporary passwords stored in the file in readable form. The file is plain text (JSON) but holds **salted password hashes only**.
- Credentials in logs, URLs, query strings, error messages or browser storage.
- A revoked or replaced credential that still works for any request after the revoke returned.
- A facilitator able to read or act on another facilitator's session, codes, hidden facts or reports.

## Constraints from the existing system

- State lives in the control service (`services/control`), as files under `CONTROL_DATA_DIR`, mode 600, written atomically (see how `report-access.json` and `sessions.json` are written and how report links store only salted hashes).
- The web app (`apps/web`) is a backend-for-frontend with sealed cookies; today the console cookie is derived from `FACILITATOR_SECRET` and carries the typed name (`apps/web/src/server/console-session.ts`). Console routes check Origin and `X-Requested-With`. The web app calls the control service with `LAUNCHER_TOKEN`.
- Login attempts need throttling like join codes and report cookies (per account and per address).
- A deploy-order note: control before web, and a rollback note in `docs/ROLLBACK.md`.
- `docs/THREAT_MODEL.md` needs a section (accounts, default admin password risk, temporary passwords shown on screen, session ownership).

## Approaches considered

- **A. Accounts in the web app's server side.** Keeps sign-in where the cookie is sealed, but that tier holds no persistent data, so it would need its own file store and a second place for state. Rejected.
- **B. Accounts in the control service, called by the web app (chosen by the owner).** The control service already owns persistent files and the hash-and-recheck pattern (report links), so revoke is immediate. Cost: one extra local call per console request and new control routes.
- **C. A separate auth service.** Cleanest long term and the natural place for SSO, but too heavy now. Owner asked for it to be backlogged (US-0087).

## Decisions

Owner's decisions:
- A default admin with a fixed default password, change forced on first login. (Risk: a well-known default is attackable until the first login. Record it in the threat model; the builder may add cheap mitigations that do not change the behaviour, such as throttling and a loud log line while the default is unchanged.)
- No email for now; show credentials once on screen. Backlog the emailing.
- Local plain-text file now, database later (backlog).
- Facilitators see only their own sessions; admin sees all.
- Approach B; backlog approach C.

My calls (for the owner to correct):
- Passwords are stored as salted hashes (scrypt or the platform's equivalent), never readable.
- A temporary password expires after **72 hours**; **resend** issues a new one and invalidates the old; **revoke** ends open sessions at once and refuses further sign-in.
- Console requests are re-checked against the control service, so revoke and expiry are immediate.
- The old shared secret keeps working **only until the admin first changes the default password**, so an existing setup is not locked out; after that, account sign-in is the only way in. (If `FACILITATOR_SECRET` is unset the console already shows "not set up"; keep that message meaningful.)
- Email is the account's login name; it must be unique (case-insensitive). The default admin's login name is a fixed documented value (builder chooses, for example `admin`).
- The session list records an `owner` (account id) at creation; sessions without one are admin-only.
- The audit label (today a typed name) becomes the account's display name.

## What it looks like (sketch)

```
Sign in
  Email [____________]   Password [____________]   [ Sign in ]

First login:  Change your password
  New password [______]  Repeat [______]            [ Save ]

Admin > Facilitators                         [ + New facilitator ]
  Name        Email              Status           Actions
  Dana Lee    dana@client.com    Invited          Resend · Revoke
  Sam Ortiz   sam@client.com     Active           Revoke

After create / resend:  "Share these with Dana. Shown once."
  Login: dana@client.com     Temporary password: ************  [Copy]
```

Facilitator console = the existing console, filtered to their sessions. Admin also gets the Facilitators page.

## Left to the builder

File layout and locking, hash parameters, the exact control routes and cookie contents, minimum new-password length, the form wording, and the tests. The builder should reuse the report-access hashing and throttle code where it fits, keep the store behind an interface, and write the security tests (revoke is immediate, expiry, throttle, no secrets in logs or responses, a facilitator cannot reach another's session).

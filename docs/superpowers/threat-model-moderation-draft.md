# DRAFT — Moderation threat model expansion (EPIC-0005)

Replaces/extends the short "review log and attested participant channel" section already in PR #50. Not applied to any branch.

## Assets
| Asset | Why it matters |
| --- | --- |
| Unreleased drafts and scores | Peer scores or a rejected score reaching a participant is the core harm |
| `review.jsonl` | The record of who decided, edited, released, amended, withdrew |
| Released snapshots and exports | What participants and the facilitator hand on; frozen at release |
| Participant words (self-assessment, response, dispute) | Attributed to a person; must not be forged silently |

## Actors
| Actor | Capability assumed |
| --- | --- |
| Facilitator (trusted operator) | Runs `pnpm moderate`, holds file access to the reports directory |
| Participant at the facilitator's machine | Same OS user as the facilitator |
| Another local user | May read/write the directory if permissions allow |
| Hostile text author | Controls model output, scenario text, `--by` and rationale strings |
| Line manager, L&D, HR, sponsor | No access path; `canView` is inert for them (default-deny) |

## Threats and mitigations (STRIDE)
| # | Threat | Class | Mitigation | Residual |
| --- | --- | --- | --- | --- |
| 1 | Hand-edit the log mid-file | Tampering | Hash chain, contiguous seq, `ReviewIllegalError` on any break | Unkeyed: whole-log rewrite undetected |
| 2 | Cut lines off the end | Tampering | Last-line check | Tail truncation of whole lines undetected |
| 3 | Edit a draft after release | Tampering | Drafts hashed into the chain; snapshots frozen at release | No snapshot hash in `report.released` (follow-up) |
| 4 | Terminal escape / control characters in text | Elevation / injection | `cleanText`, per-line strip in `show`, `loadDrafts` validation, `<` escaping in JSON | Terminals with unusual handling |
| 5 | Peer score reaches another participant | Info disclosure | `canView` frozen versioned table, default-deny, `redactGroupForParticipant`, S-17 scripted check, no peer rows in exports | Only checked for the roles modelled |
| 6 | Facilitator notes leak to participant | Info disclosure | Participant views built from allow-listed fields only | New fields must be added to the allow-list deliberately |
| 7 | Withdrawn or replaced score still shown | Info disclosure | Group table built from each player's last released snapshot; withdraw is terminal; `tableStale` surfaced | Stale until re-release |
| 8 | Forged participant words | Spoofing | Actor `participant:<role>` plus `attestedBy` | Facilitator-attested, not authenticated; EPIC-0002 replaces it |
| 9 | Racing writers corrupt the log | Tampering / DoS | Single-writer lock, durable append, rollback on failure | Sibling-release check not atomic across directories |
| 10 | Log or event flood | DoS | Byte cap, 10,000-event cap, bounded messages | Cap hit makes a review unusable until superseded |
| 11 | Symlink / TOCTOU on export | Tampering | Audit event first, exclusive no-follow file creation, scrub like `show` | Other local user with directory write |
| 12 | Agent runs release/amend/withdraw unprompted | Repudiation | AGENTS.md rule: owner must name subjects/roles and supply words | Policy, not enforcement |
| 13 | Error text echoes secrets or hostile input | Info disclosure | Bounded no-echo messages, scrubbed, truncated by code points | — |

## Out of scope
Compromised facilitator machine; a participant with their own shell on the same OS user; network attackers (the CLI is local); model-provider confidentiality (see the main model).

## Candidate hardening, in priority order
1. Snapshot hash in `report.released` (closes #3).
2. Session-level parent-directory lock for the sibling check (closes the #9 residual; never per-sibling locks because of supersede's lock order).
3. `release --expect-seq` to stop releasing a draft that changed since it was read.
4. Keyed or externally anchored chain head (closes #1, #2) — only if the log leaves the single-operator setting.
5. Participant logins (EPIC-0002) to replace attestation (closes #8).

## Review triggers
New principal, new event type visible to participants, any new export format, any change to `POLICY`, or the log moving off the local disk.

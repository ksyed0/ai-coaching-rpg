# Hide a participant response (US-0069): design

Status: Draft 1 (2026-11-17). Story: US-0069 (EPIC-0002, Low, AC-0392..AC-0395, filed 2026-11-07). Parents: `2026-11-05-slice-2c-2-participant-actions-design.md` (section 8), `docs/THREAT_MODEL.md` ("Participant ratings and responses"), BUG-0029 (resend is a no-op) and BUG-0030 (per-link cap). Approved by the owner in conversation on 2026-11-17 (the design, with the confirm dialog added).

## 1. Intent

A participant can answer their released report through their personal link. A response is stored forever as a `response.added` event, and nothing today lets a facilitator take one out of view. When a response is abusive or posted by mistake (or by someone who only has the forwarded link) the facilitator needs to remove it from every place a person reads, **without deleting the record**.

Goals: a facilitator hides one response with a required reason; the hide is audited (who, when, why); a hidden response never appears in a participant or facilitator export or on the participant's page; the original text stays in the log; hiding never refunds either response cap.

Non-goals: unhide; telling the participant; deleting or rewriting a `response.added` event; hiding a comment, a self-rating or a score (only responses); a bulk hide; redacting part of a response; a new report version for a hide.

Anti-goal: a hide that quietly changes a number someone relies on (a cap, a count of open disputes that gates a release) or that lets hidden text leak through a path nobody listed.

## 2. Approaches considered

1. **A new facilitator-only review event `response.hidden { response, reason }` (chosen).** It points at a response by its sequence number exactly as `dispute.resolved` does. The response stays in the fold's list with a `hidden` mark, so the caps behave as AC-0395 requires with no special case.
2. Rewrite or blank the `response.added` event. Rejected: breaks AC-0394 and the append-only hash chain.
3. A separate redaction store keyed by response. Rejected: a second source of truth that the fold, the supersede carry and the audit would all have to read.

A second owner-approved choice: **no unhide event**. A mistaken hide is made unlikely by a confirm step in the console (section 6) instead.

## 3. The event

```
{ type: "response.hidden", response: number, reason: string }   // actor: facilitator only
```

- `response` is the `seq` of an existing `response.added`; `reason` is required, trimmed, 1 to `LIMITS.reason` (500) characters after the same cleaning every other reason gets.
- Who hid it is the actor (`facilitator`, `by`); when is the event's `ts`; both are already in the log (AC-0392).
- The fold refuses (as it does for every malformed event): a participant or system actor; no such response; a response already hidden; an empty or over-long reason. The schema stays `acr.review/2` (a runtime older than this change refuses a review that holds a hide: ROLLBACK entry, section 9).

## 4. The fold

`ResponseView` gains `hidden: { seq: number; reason: string; by: string } | null` (null until hidden). The response is **not removed** from `sv.responses`.

- **Caps (AC-0395).** The per-role cap is `sv.responses.length` and the per-link cap counts `response.added` events; neither changes, so hiding refunds nothing. A test pins both.
- **Disputes.** A hidden dispute leaves the open-disputes lists (`moderation/read.ts` `openDisputes`, `review/cli.ts` status) and `dispute.resolved` on a hidden response is refused (fold, `resolveDispute`, the console). Resolving first and hiding later is allowed; the resolution stays in the log.
- **Resend (BUG-0029).** The identical-unresolved-response check in `participant/write.ts` ignores hidden responses. Otherwise a participant who posts the same text again would be told "saved" (`wrote: 0`) for a response nobody can see. A re-post is stored and counts toward the caps as any new response does.

## 5. Read paths: one filter, applied at the source

`viewReport` (`review/view.ts`) builds the released audience's responses from the live view (`liveResponses`) because responses are made after the release and are not part of the frozen snapshot. **The filter goes there: hidden responses are dropped from `liveResponses` before they are mapped** for every audience that is not the facilitator's own console review. That one place feeds the participant page, the group report, the Markdown (`report-md.ts`) and JSON exports and the facilitator export (AC-0393). Review of the other readers of `.responses` (`moderation/read.ts`, `review/cli.ts`, `store.ts` supersede) is part of the plan; a canary test plants a distinctive string in a hidden response and checks it appears in no export, no participant-page payload and no group report.

The facilitator's **console review** shows a hidden response as "Hidden by facilitator" with the reason, who and when, and **not the text** (the text stays in the log and, for a facilitator who needs it, the CLI `status`/raw log). The DTO the console receives carries `hidden` and omits `text` for a hidden response.

The frozen view (`frozenView`) is unchanged: a hide after a release changes what is read at once, never the snapshot's scores or summary, and creates no new version.

## 6. Entry points

- **CLI:** `moderate hide --response <n> --reason "<text>"` (runtime `moderation/write-b.ts`, beside `resolveDispute`; same refusals: no such response, already hidden, reason required).
- **Control:** `POST /api/v1/sessions/:id/report/hide { seq, reason, by }` in `moderation-routes.ts` through `Moderation.hide` (same `by` rule and the same neutral errors as `resolve`).
- **Console:** a "Hide" button beside each response in the report review (`SubjectView`). It opens a **confirm dialog that shows the response text and a required reason field** (500 characters, counter, keyboard operable, focus returns to the button), and hides only on confirm. This is the owner-approved guard against a misclick, because there is no unhide. Disabled (with the existing sentence) when the console cannot write.

## 7. Carried across a re-run (supersede)

`CARRIED_PARTICIPANT` gains `response.hidden`. In `store.ts` supersede, a `response.hidden` is carried only when its response was carried (`newSeq.has(e.response)`), with `response` remapped to the new seq, exactly as `dispute.resolved` is. A hide whose response is not carried (the player or criterion is not in the re-run) is dropped with it, and the existing "not carried" notice names it. The new seq order is the push order, so the loop must see the hide after its response, which the log order guarantees.

## 8. Behaviour the participant sees

Nothing is announced. The response stops appearing on their page. Their "used N of 50" counter counts visible responses only, so near the cap it can show fewer than the server counts; the existing "too many" refusal still explains it. Documented limit, not fixed here.

## 9. Documents and rollback

THREAT_MODEL ("Participant ratings and responses"): the "there is no redaction" sentence is replaced by what a hide does and does not do (text stays in the log; the participant is not told; a forwarded link can post again and be hidden again; per-link cap still bounds it). ROLLBACK, "US-0069": a runtime rolled back to before this change **refuses a review log that contains `response.hidden`**, so roll back only before the first hide, or restore the log from before it. TEST_CASES, CHANGELOG, RELEASE_PLAN (ACs reworded to match, Notes).

## 10. Review focus (inputs the story does not name)

1. A hidden response's text in the **group report** and in the **Markdown** export (the two paths a reader forgets).
2. A hide of a response that already has a **resolution** (allowed) and of a response from a **superseded** review (carried or dropped, never dangling).
3. Hiding the **last** response of a role (an empty list must render as none, not as an error).
4. Two hides of the same response racing (the second is refused by the review lock and the fold).
5. A response hidden **after** a release and an **amend**: the next version must not show it either.

## 11. Open items

None for the owner. Builder calls recorded: no unhide (owner-approved, with the confirm dialog), the schema stays `/2`, the counter mismatch is documented, hidden responses are skipped by the resend dedupe.

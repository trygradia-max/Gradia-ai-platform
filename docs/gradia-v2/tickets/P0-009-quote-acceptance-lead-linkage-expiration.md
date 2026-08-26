# P0-009 — Quote acceptance, lead linkage and expiration repair

## Ticket ID
P0-009

## Epic
E00 — Stabilization

## Status
**Blocked — next implementation position** (moved up 2026-08-25 at the P0-008 close; P0-008 done 2026-08-25 PR #23). Blocked only until the `docs/close-p0-008` planning closeout lands on `main` — the Organizer flips this to ready on merge (entry in `../program/blocked.md`). One open decision noted: the expired-quote visitor experience copy (Q-04). Ship the minimal honest state described below; do not block on the decision. Soft ordering: merge before P0-011's scoping sweep re-reviews `approvals.ts` (`../program/dependency-map.md`). (Prior state: ready-after-P0-002, reconciled 2026-07-27; that review gate is long satisfied.)

## Priority
P0 — High. Money-path correctness: the quote→booking seam forks duplicate pipeline cards, quote status lies, and expired prices remain accept-able server-side.

## Objective
Make the quote lifecycle truthful end-to-end: accepting a quote resolves the quote's **existing** lead (no duplicate card), quote status advances to a booked/won linkage, and `valid_until` is enforced server-side so an expired quote can no longer be accepted.

## User outcome
An owner who sends a quote sees ONE pipeline card travel new → quote_sent → booked; the quote itself shows its real state; and a customer clicking an old quote link cannot accept a stale price — they see an honest "this quote has expired" state instead.

## Current code references
All from audit trace C (`docs/audit/04-workflow-traces.md` §C) and doc 12 item 6:
- `executeBookAppointment` creates a **brand-new lead row** (`approvals.ts:747`) instead of resolving the quote's existing lead → duplicate pipeline card; the quote's card never reaches `booked`.
- Quote status never advances past `accepted` — no booked/won linkage.
- **Expired quotes are still acceptable server-side** — `valid_until` is display-only (`quote-response.ts:82`).
- Accept with picked time AND phone stages `book_appointment` (`quote-response.ts:135`, hardcoded 120 min); no phone → booking silently not staged.
- Circular link exists: `quotes.lead_id` ↔ `leads.quote_id` (`docs/audit/05-database-audit.md` §weakness 3) — the payload plumbing must not worsen it.
- Security L-3 context (`docs/audit/06-security-and-tenancy-audit.md`): `/q/[token]` has no rate limiting; `respondToQuote` skips the length sanity-check `loadPublicQuote` performs.

## Exact scope
1. **Lead linkage:** the `book_appointment` payload staged from quote acceptance carries `quote_id` and `lead_id`; `executeBookAppointment` resolves that existing lead (stage → `booked`) when present instead of inserting a new lead. Fallback to current create-behavior only when no lead reference exists (voice-originated bookings unchanged).
2. **Quote status truth:** on successful booking execution, the quote advances to its booked/won linkage state (recorded on the quote row; exact column/enum value per existing schema conventions — additive if a new status value is needed). The schema choice (new status value vs existing columns) is **Builder-proposed and Reviewer-approved before implementation** — it does not drift silently into the diff (added 2026-07-27).
3. **Expiry enforcement:** `respondToQuote` rejects accept/decline mutations past `valid_until`, server-side. Public page renders a written, honest expired state (minimal copy now; richer re-quote CTA awaits the decision-queue answer).
4. **Parity/rate-limit hardening on the public surface (bounded):** `respondToQuote` performs the same token length sanity-check as `loadPublicQuote`; apply the existing `rate-limit.ts` machinery to the `/q/[token]` response action.
5. **Silent no-phone path made visible:** when acceptance cannot stage a booking because no phone is on file, record it (timeline note on the lead) so the owner learns the customer accepted — never a silent drop.

## Explicit non-goals
- **Token regeneration/CSPRNG + expiry-on-token (L-3 full hardening): deferred** — Organizer decision: this ticket takes rate-limit + length-check parity only; `randomBytes` token migration is a follow-up ticket.
- No deposits/payments on quotes (roadmap P5, D-019).
- No conflict checking on the staged booking (P0-003/P0-004 own that).
- No change to the hardcoded 120-minute duration (product decision, not stabilization).
- No pipeline-board UX changes beyond the duplicate-card fix falling out naturally.
- No re-quote generation flow for expired quotes (needs the founder decision first).

## Dependencies
- None hard. Sequencing note: if P0-003/P0-004 land first, `executeBookAppointment` will have changed — rebase carefully; the lead-resolution change and the conflict check touch the same executor.
- Open decision (non-blocking): expired-quote visitor CTA copy — decision queue.

## Expected modules affected
- `src/lib/approvals.ts` (`executeBookAppointment`)
- `src/app/actions/quote-response.ts` (`respondToQuote`, `loadPublicQuote`)
- `src/app/actions/quotes.ts` (staging payload at send/accept seam, if payload assembly lives there)
- `/q/[token]` page component (expired state rendering)
- `src/lib/strings.ts` (expired-state copy — chrome strings rule)
- Possibly one additive migration (quote status value / booked linkage column)
- Tests across the approval-engine and quote suites

## Database impact
- Possible additive quote-status enum value or linkage column (booked appointment reference). No destructive change. The existing circular `quotes.lead_id` ↔ `leads.quote_id` is used as-is, not extended.

## Migration impact
- At most one additive, idempotent migration; migration test via integration tier. If the linkage can be expressed with existing columns, zero migrations (preferred).

## API impact
- `respondToQuote` server action gains a rejection path (expired) — public-facing behavior change, must return a typed, user-renderable result, not a thrown error.
- `pending_actions` payload shape for `book_appointment` gains optional `quote_id`/`lead_id` fields — backward compatible (executor must still handle old in-flight payloads staged before deploy).

## UI impact
- `/q/[token]`: new **expired** state (written, honest, no dead controls); acceptance error state if a quote expires between page load and submit.
- Pipeline board: duplicate card stops appearing (no new UI, behavior fix).
- Owner timeline: note when acceptance happened but booking could not stage (no phone).
- All states: loading/empty/error/success already exist on the public page — extend, don't regress; mobile behavior unchanged (public page is already responsive).

## Permission impact
- None. Public token surface stays token-authenticated; owner surfaces stay session/RLS.

## Tenant-isolation impact
- `executeBookAppointment`'s lead resolution must scope by `claimed.shop_id` (service-role path). Includes the L-2 nit while in the file: add the missing `.eq("shop_id")` on the `customers.update` at `approvals.ts:797` (audit doc 06 L-2) — one-line consistency fix, in scope because this ticket owns that executor.
- Tenant-isolation test: a payload carrying a foreign shop's `lead_id`/`quote_id` must not resolve — executor verifies the referenced rows belong to `claimed.shop_id`.

## Security impact
- Closes "accept a stale price" server-side. Adds rate limiting to a public money surface. Validates cross-references in the executor payload (defense against forged/stale payload references).

## Idempotency requirements
- Approval claim already atomic (audit doc 06) — unchanged. Re-execution after rollback-to-pending must remain safe with the new lead-resolution path (no duplicate stage moves; stage move to `booked` is idempotent).
- Double-submit of accept on the public page: second submit hits the status guard (already status-guarded per trace C) — add a test.

## Observability requirements
- Structured log when acceptance is rejected for expiry, and when a booking resolves an existing lead vs falls back to create (so the fallback rate is observable).
- Timeline/decision-log entries per existing glass-box conventions where rows are available (never fabricated).

## Analytics requirements
- None new this ticket (quote funnel analytics is roadmap P8). Do not add ad-hoc events.

## Feature flag
**None — fix**, for the lead-linkage and status-truth defects (no state where the old behavior is wanted). The **expired-state rendering** is copy-gated via `strings.ts` only. If the Builder judges the executor change risky mid-alpha, the fallback-to-create path doubles as the safety valve — document, don't flag.

## Automated tests
- **Unit:** expiry rejection at the boundary (day-of, timezone-explicit); payload carrying quote/lead ids resolves the existing lead; missing ids falls back to create; no-phone acceptance records the timeline note.
- **Integration (approval engine, real Postgres):** accept → approve → one lead total, stage `booked`, quote reaches booked linkage; rollback-to-pending re-run creates no duplicates.
- **Tenant-isolation:** foreign `lead_id`/`quote_id` in payload → refused.
- **Failure-path:** expiry check when `valid_until` is null (must not lock out non-expiring quotes); acceptance race with expiry; double-submit.
- **Rate-limit test** on the public response action.

## Manual acceptance procedure
1. Seeded shop: create + send a quote; open `/q/[token]` as the customer; accept with a picked time.
2. Approve the staged booking in `/approvals`; confirm the **original** pipeline card moved to `booked`, no second card exists, and the quote shows its booked state.
3. Create a quote with `valid_until` in the past; open the public page → expired state renders (written copy, no accept control); attempt a direct action replay → server rejects.
4. Accept a quote for a customer with no phone → no booking staged, timeline note visible on the lead, owner can see the acceptance.
5. Hammer the public response action past the rate limit → limited, page stays honest.
6. Voice-originated `book_appointment` (no quote refs) still books exactly as before.

## Failure cases
- Quote's lead was deleted/merged before approval → executor falls back to create, logs the fallback.
- Quote expires between staging and approval → executor re-checks? No — expiry binds at *acceptance* (customer-facing moment); an owner approving an already-accepted quote's booking is not re-gated. Documented behavior.
- Old-shape payloads in flight at deploy → executor handles absent ids (fallback path).

## Rollback strategy
Revert the PR. If the additive migration shipped, it remains (harmless unused value/column). In-flight payloads with the new ids are ignored by the old executor (unknown fields tolerated) — verify this before merge.

## Definition of done
Per `12-definition-of-done.md`, plus: integration-tier tests green (this ticket touches the approval engine — the integration tier must be un-quarantined per P0-002 before this merges), all six manual steps evidenced, and the completion report states the deferred L-3 token work as a follow-up ticket.

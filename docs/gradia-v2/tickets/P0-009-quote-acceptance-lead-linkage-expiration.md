# P0-009 — Quote acceptance, lead linkage and expiration repair

## Ticket ID
P0-009

## Epic
E00 — Stabilization

## Status
**Done — merged to `main` 2026-08-26 in PR #25 (`d3c0e4d`; pre-squash Builder implementation `829ddfd` → Cursor review-fix `aba1068`, both 2026-08-25).** Independent Cursor verdict **APPROVE** — no BLOCKER; **one HIGH found and fixed pre-merge** in `aba1068` (transient read errors during quote-lead resolution could fall through to fallback lead creation — now fails closed with a `lead_resolve_error` reconciliation marker; see H-1 in the Close record). Founder acceptance **PASS 2026-08-26** on the exact reviewed commit `aba10682101c30a3155ad212910b00a19945b3fe` (isolated local staging; full evidence below). Q-04 (richer expired-quote UX) remains open and non-blocking — the minimal honest expired state shipped. Quote-token regeneration remains deferred per the explicit non-goal. Residual dispositions (M-1, L-1, L-2, L-3, pre-existing `recordPayloadReconciliation` note) in the Close record; follow-ups in `../program/backlog.md`. (Prior state: blocked — next implementation position from the 2026-08-25 P0-008 close, unblocked when `docs/close-p0-008` landed as `eae12a5` PR #24.)

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

## Close record (docs-close session, 2026-08-26)

**Merged:** PR #25 → `main` as `d3c0e4d` ("fix: repair quote acceptance and
lead linkage"), 2026-08-26. Verified sequence: Builder implementation
`829ddfd` → Cursor review-fix `aba1068` (local) → `aba1068` pushed →
PR #25 head verified as `aba1068` → CI green on `aba1068` → founder
acceptance PASS on `aba1068`. The squash-merge tree of `d3c0e4d` is
byte-identical to `aba1068`'s tree (`bfb5b60…`) — what merged is exactly
what was reviewed and accepted. Process note: the review-fix was initially
reported as pushed before it had actually reached GitHub; earlier
acceptance attempts made before the push were precondition failures only
and carry no evidentiary weight — the sequence above is the authoritative
record.

**Review evidence:** independent Cursor verdict **APPROVE**; **no
BLOCKER**; **one HIGH found and fixed** in `aba1068` (H-1 below). CI on
the exact reviewed commit `aba1068`: `ci / checks` green,
`ci-integration / integration` green, Vercel Preview green.

### Final architecture (as merged)

- **Lead linkage repaired:** quote-backed booking (`executeBookAppointment`)
  now resolves and reuses the **existing quote-linked lead** — the
  duplicate pipeline-card fork (`approvals.ts:747` pre-fix) is closed.
  Fallback lead creation remains only for ref-less payloads (voice-
  originated and old in-flight shapes) and clean not-founds
  (deleted/merged lead — the documented fallback).
- **Quote status truth:** the quote advances to **`booked` only after
  durable appointment persistence** — never before. One additive
  migration (`supabase/migrations/20260825120000_quote_status_booked.sql`)
  adds the `quote_status = booked` value, per the Builder-proposed /
  Reviewer-approved schema-choice gate in Exact scope §2.
- **Expiry enforced server-side:** `respondToQuote` rejects accept AND
  decline past `valid_until`; the public page renders the minimal honest
  expired state (copy via `strings.ts`); replay of an expired accept is
  refused.
- **Replay/concurrency safety:** accept/decline transitions are
  replay- and concurrency-safe (atomic claim; double-submit hits the
  status guard; test-locked).
- **No-phone acceptance is honest:** acceptance without a phone on file
  records an explicit `accepted_no_booking` state with a timeline note
  and the requested time preserved — never a silent drop, and never a
  false `bookingStaged` claim.
- **Public-surface hardening:** `respondToQuote` gained the token
  length sanity-check parity and rate limiting via the existing
  `rate-limit.ts` machinery, keyed by server-resolved `shop_id`,
  fail-open on limiter infrastructure failure (confirmed in acceptance).
- **Tenant isolation:** quote/lead/customer linkage in the executor is
  scoped to `claimed.shop_id`; foreign `quote_id`/`lead_id` refs do not
  resolve (test-locked and acceptance-verified).
- **Preserved:** the P0-004/P0-004A booking architecture (serialized
  persistence-first executor, `pending_action_id` idempotency) is intact;
  ref-less voice bookings behave exactly as before. No deposits/payments/
  invoices. P0-010 not started. Production conflict enforcement remains
  **OFF**.

### H-1 — HIGH found in review, fixed in `aba1068`

Transient PostgREST **read errors** during quote-lead resolution could
previously fall through to fallback lead creation — recreating the
duplicate-card bug under infrastructure noise. `aba1068` distinguishes a
read error from a clean not-found and **fails closed**: no replacement
lead is created, the pending action records a `lead_resolve_error`
reconciliation marker, and replay retries resolution safely. A unit test
locks the fail-closed behavior. Acceptance-verified (evidence §6 below):
with an injected leads-SELECT transport error, the appointment remained
durable, no replacement lead appeared, and a healthy-read replay healed
the state — same appointment reused, original lead → `booked`, quote →
`booked`, no duplicate stage history.

### Founder acceptance — PASS (isolated local staging, 2026-08-26)

Acceptance commit: exactly `aba10682101c30a3155ad212910b00a19945b3fe`.
Environment: isolated local Supabase + local Next dev server; mock
Aurinko REST via the `AURINKO_API_BASE` seam; the **real** public
quote-response server action and the **real**
`executeApproval`/`executeBookAppointment` path; throwaway encrypted test
credentials only; zero production customer traffic; zero production
config changes. Evidence:

1. **Quote accept → book:** public acceptance returned accepted +
   `bookingStaged=true`; the quote stayed `accepted` before owner
   approval; exactly one booking pending action; approval created exactly
   one appointment; the original quote-linked lead was reused (leads
   total stayed 1, no duplicate pipeline card); the original lead moved
   `quote_sent` → `booked`; the quote moved to `booked` only after
   appointment persistence; stage history contained exactly one `booked`
   transition.
2. **Expired quote:** expired public state rendered with no accept/book
   controls; the server refused both accept and decline; replay refused;
   zero pending actions, zero appointments, zero lead mutation;
   `responded_at` unchanged.
3. **No-phone:** quote accepted honestly with `bookingStaged=false`;
   zero pending actions and zero appointments; `accepted_no_booking`
   timeline note recorded; requested time preserved.
4. **Rate limit:** calls 1–10 allowed; 11–13 refused generically with no
   quote/customer data leaked; bucket keyed by server-resolved
   `shop_id`; another shop unaffected; fail-open limiter behavior
   confirmed.
5. **Non-quote / voice regression:** a ref-less voice-style payload
   still used fallback lead creation in the correct shop only; the
   appointment was created; the normal `executeBookAppointment` path is
   intact.
6. **`aba1068` read-error fix:** injected leads-SELECT transport error →
   appointment remained durable, no replacement lead, existing lead
   initially unchanged, quote remained `accepted`, pending action
   recorded the `lead_resolve_error` reconciliation; replay with healthy
   reads healed state — same appointment reused, original lead →
   `booked`, quote → `booked`, no duplicate stage history.
7. **Tenant isolation:** an intruder shop carrying the victim's
   `quote_id`/`lead_id` could not resolve the foreign refs; the victim
   shop was untouched; the fallback lead was created only inside the
   intruder's own shop; no cross-tenant linkage.
8. **Reconciliation:** final primary acceptance shop held exactly
   1 quote, 1 lead, 1 appointment, 1 booking pending action, 0 usage
   events; no duplicate cards; no duplicate stage history.
9. **Cleanliness:** all staging rows purged; no application code changed
   during acceptance; no commit/push/merge during acceptance; no
   production traffic or config touched; no secrets or public quote
   tokens exposed by application logs; production conflict enforcement
   remains OFF; P0-010 not started; `.playwright-mcp` untouched.

### Residuals and dispositions (Cursor-recorded)

- **M-1 — acceptance-side crash window (follow-up filed):** a narrow
  window remains between the atomic quote → `accepted` claim and the
  `pending_actions` insert. If the process dies inside it, a retry may
  echo `accepted` without staging the requested booking and without a
  reconciliation marker. Not a merge blocker — outside this ticket's
  required idempotency scope (which covered the executor/replay side).
  Backlog follow-up: acceptance-side reconciliation.
- **L-1 — UTC-day expiry (tracked):** `valid_until` expires at end of
  UTC day; potential local-midnight mismatch for non-UTC shops. Track
  shop-local expiry once shop timezone is available (backlog).
- **L-2 — accept-race reporting (accepted, cosmetic):** a concurrent
  accept race loser may temporarily report `bookingStaged:false` before
  the winner's pending-action insert commits. Cosmetic only; no
  duplicate state. Documented residual — no work.
- **L-3 — per-shop rate bucket exhaustion (accepted pilot residual):**
  someone holding a valid token can exhaust a shop's `quote_response`
  bucket for ~1 minute. Consider a per-token sub-bucket only if pilots
  show abuse (backlog watch item).
- **Pre-existing — `recordPayloadReconciliation` scoping:** its
  update-by-id lacks an explicit `shop_id` predicate. Safe under the
  current claimed-UUID path, but **P0-011's sweep should re-review
  `approvals.ts` after P0-009** — recorded in the P0-011 ticket.

### Follow-ups recorded at close (Organizer sequences)

1. **M-1** acceptance-side reconciliation (backlog).
2. **L-1** shop-local `valid_until` expiry once shop timezone exists
   (backlog).
3. **L-3** per-token rate-limit sub-bucket, only on abuse evidence
   (backlog watch).
4. **Quote-token regeneration** (`randomBytes` + token expiry) remains
   the deferred E03-era follow-up per the explicit non-goal — the
   rate-limit + length-check parity half of audit L-3 shipped here.
5. **Q-04** richer expired-quote UX (re-quote CTA) remains open and
   non-blocking — the minimal honest state is live.
6. **P0-011** re-reviews `approvals.ts` post-P0-009, including the
   `recordPayloadReconciliation` `shop_id` predicate.
7. **P0-005A** retention/pruning remains open (unchanged by this ticket).
8. Production P0-004 conflict enforcement remains **OFF**; the P0-004
   manual production-enable gate remains outstanding.

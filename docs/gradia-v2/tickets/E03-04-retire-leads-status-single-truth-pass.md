# E03-04 — Single-truth pass: retire `leads.status`, consolidate activity timestamps and lifecycle vocabularies, flat vehicle columns read-cutover, quote↔lead link direction

_Cut 2026-09-01 by the Organizer for autorun Batch 3 (`../program/autorun.md`). Specification only._

## Ticket ID
E03-04

## Epic
E03 — CRM and import completion (phase P3) — **E03 exit ticket**

## Status
**draft — batch-gated.** Autorun Batch 3, queue item 13 (last implementation ticket on `auto/batch-3`; item 14 P3-001 is superseded by CLEANUP-001/D-052 and closes as a docs tombstone). Enters after E03-03 is committed. Risk class **database-sensitive** (the riskiest migration set in the program so far — E03 epic; dual-write → backfill-verify → cut-read → **no drop in this ticket**). Founder acceptance **no** (autorun table) — the Reviewer's falsification pass is the gate. Decisions binding: D-002, D-022 (import truth), D-025 (no fabricated figures), D-039 (lifecycle vocabulary), E03 epic §Missing work 4. No open decision.

## Priority
P3 — High. Live divergence today: `leads.status` (3 values) vs `leads.stage` (6) with a **lossy** write-through (`pipeline.ts:123-132` — `needs_quote`/`follow_up`/`lost` never propagate), so BI tools, audience filters, automation sweeps, KPIs and the customer file (`customers/[id]/page.tsx:42-52`) read a lead as "new" while the board says "lost". Three "last seen" timestamps with disjoint writers; flat vehicle columns on two tables vs `vehicles`; circular `quotes.lead_id` ↔ `leads.quote_id`.

## Objective
Make `stage` the only pipeline truth (every reader migrated, `status` write-through removed, column left dormant), collapse the three activity timestamps to one canonical derived field with a single writer, unify the lifecycle vocabularies, cut every reader of the flat vehicle columns over to `vehicles`, and pick one direction for the quote↔lead link — each slice with a backfill-equivalence proof, characterization tests, and a short-lived migration flag; drops deferred to a rollback-able file (E10 decides).

## User outcome
The board, the customer file, Ask Gradia, audiences and KPIs all agree on where a lead is and when a customer was last seen. Founder-as-operator: one vocabulary to reason about; imports and reports stop disagreeing.

## Current code references
- **`leads.status`** enum `lead_status('new','quoted','booked')` `20260507220000_gradia_core.sql:8`; `crm_stage` `…c1.sql:17-18` (TS `database.ts:1,435`). Writers: `src/lib/pipeline.ts:126-132` (lossy write-through), `actions/pipeline.ts:92`, `actions/recovery.ts:203-216`, `actions/leads.ts:51-60` (payload), `actions/demo-data.ts:60`, `approvals.ts:339,364,1447,1486`, `mcp/server.ts:704`. Readers: `bi-tools.ts:178,201,293,736-738`; `automation-sweeps.ts:125,304`; `agent-audience.ts:188` (+ schema `database.ts:780`); `agent-runtime.ts:175` (`lead_followup_sms`); `find-person.ts:151`; `mcp/server.ts:601,707`; `data/today-money.ts:89,146,202`; `actions/automations.ts:55`; `actions/quote-response.ts:202`; `actions/quotes.ts:154`; `actions/co-owner.ts:30`; `customers/[id]/page.tsx:42-52`; `data/kpis.ts:71`; `data/roi-receipt.ts:80,112`; `data/leads.ts:39` (scoring). Migration comment acknowledging the dual truth: `…c1.sql:5-11`.
- **Timestamps:** `last_service_at` (never written), `last_visit_at` (`approvals.ts:1512`), `last_transaction_at` (imports: `recovery/review.ts:171-173`, `structured-csv.ts:40,85,338`); reconciled only in `lifecycle.ts:41-46`; reader `whisper-tools.ts:170`. Lifecycle vocabularies: `customers.lifecycle` (`CustomerLifecycle` `database.ts:445`), `leads.lifecycle_status` (revival funnel, `database.ts:233`), plus `at_risk/lapsed/won_back/maintenance` — three vocabularies (E03 epic).
- **Flat vehicle columns:** `leads.vehicle_make/model/year/color` (`20260615130000_structured_segments.sql:7-9`, `20260615160000_vehicle_color.sql:5`), `customers.*` same (`:12-14`, `:7`); `@deprecated Write-through only` `database.ts:223-228,246-253`; write-through `vehicles.ts:136-152` (fill-if-empty); readers still on flat cols: `agent-audience.ts:168,218`, `owner-agent.ts:294`, `crm-health.ts:28,147`, `actions/crm-cleanup.ts:62-65`; backfill ran once `…c1.sql:117-121`; no drop.
- **Quote↔lead:** `quotes.lead_id` (`…c1.sql:194-221`) and `leads.quote_id` (`:237-238`); `appointments.quote_id` `:249`; P0-009 fixed acceptance linkage (`20260825120000_quote_status_booked.sql`); readers `actions/quotes.ts:141-211`, `actions/pipeline.ts:166-175`, `quote-response.ts:40,106,202`, `quotes-list.tsx:139-145`, `automation-sweeps.ts:275`.
- Types: generated (E03-01) — drift check will flag any schema change without regen.
- Tests: `eval/quote-booking.test.ts`, `eval/integration/quote-acceptance.int.test.ts`, pipeline/scoring tests, BI eval suite (`bi.eval.test.ts` — **BI prompt/tool descriptions may reference status**: if the prompt text changes, run the BI eval and paste).

## Exact scope
Each slice = its own migration file + characterization tests + a short-lived flag (`FEATURES.singleTruth.<slice>`) that switches reads; all four slices ship in this ticket but are independently revertible.
1. **Slice A — `leads.status` retirement:** (i) backfill-verify: derive `status` from `stage` for every row and record mismatches (expected: the lossy cases) — report counts; (ii) migrate **every reader** above to `stage` (BI tool descriptions, audience filter schema `lead_status` → `stage` with a compatibility mapping for saved agent configs, sweeps, KPIs, ROI receipt, scoring, MCP tools, customer file); (iii) remove all writers incl. the write-through; (iv) grep-test: `status` on `leads` is read nowhere (E03 acceptance criterion 3); column left dormant (`/** dormant — E03-04 */`), drop deferred to `supabase/rollbacks/e03-04_drops.sql`.
2. **Slice B — one activity timestamp:** introduce `customers.last_activity_at` (canonical, derived = max of the three + latest completed job + latest interaction if the audit rule says so — Builder proposes the derivation in the migration header; `lifecycle.ts` becomes the single writer of the derived value at derivation time, plus the two live writers call one helper `touchCustomerActivity(kind, at)` that updates the canonical field and keeps the legacy field for one release); backfill; readers (`whisper-tools`, lifecycle, home analytics) cut over; legacy three columns dormant.
3. **Slice C — one lifecycle vocabulary:** map `leads.lifecycle_status` (revival funnel) into either `stage` values or a `customers.lifecycle` value — Builder writes the mapping table in the migration header; readers cut over; legacy column dormant. `CustomerLifecycle` remains the vocabulary (D-039 values).
4. **Slice D — flat vehicle columns read-cutover:** the four readers switch to `vehicles` (primary vehicle = most recently updated or explicit `is_primary` if a flag exists — add `vehicles.is_primary` boolean additive if needed); write-through kept for one release then removed in a follow-up; columns dormant; drops deferred.
5. **Slice E — quote↔lead direction:** choose `quotes.lead_id` as truth (quotes reference leads; a lead's "current quote" becomes a derived query: latest non-void quote) — remove writers of `leads.quote_id`, migrate readers, verify P0-009 acceptance suite unchanged; column dormant. (If the Builder's characterization shows `leads.quote_id` is load-bearing for the public token path, keep it as a cache with one writer and record why.)
6. **Verification windows:** each slice's flag defaults ON at merge only after its backfill-equivalence test passes on the integration DB; production flip is the same deploy (flags are code-level; the migration files are additive so a revert is safe).
7. Docs: `03-domain-model.md` §2/§3/§4 + §Cross-cutting schema debts (mark resolved/deferred-drop), `05-feature-requirements.md` if it names `status`, `04`, `program/capability-status.md`, `supabase/rollbacks/e03-04_drops.sql` (not applied), generated types regenerated.

## Explicit non-goals
- **No column drops** (rollback file only; E10 decides). No table renames.
- No pipeline UX changes; no new stages; no scoring changes beyond reading `stage`.
- No prompt edits beyond tool-description wording for `status` → `stage` (eval-gated if touched).
- No change to quote public-token behavior (P0-009 locked).

## Dependencies
- E03-03 committed (lifecycle writer exists). E03-01 (generated types + drift check). P0-009 done.
- Decisions: D-002, D-025, D-039 — Approved. No decision open.

## Expected modules affected
Migrations ×3–5 (+ rollback drops file); the ~25 reader/writer files listed; `src/lib/lifecycle.ts`, `src/lib/customers.ts` (`touchCustomerActivity`), `src/lib/vehicles.ts`, `src/lib/types/database.ts` + regenerated types, `src/lib/features.ts` (short-lived slice flags), `eval/single-truth.test.ts` (+ integration equivalence proofs), BI tool descriptions (`bi-tools.ts`), docs.

## Database impact
Additive columns (`last_activity_at`, maybe `is_primary`), backfills, no drops; indexes on `leads(shop_id, stage)` if plans need it (PERF-001 may have added).

## Migration impact
Three to five additive, idempotent migrations, each with a header stating derivation/mapping and rollback; **occupies the DB-sensitive slot for the whole ticket**. Re-run twice locally.

## API impact
MCP tool contracts: `status` fields become `stage` (document as a breaking change for MCP consumers in the tool descriptions; keep a read-only alias for one release).

## UI impact
Customer file shows `stage`, lifecycle chip, `last_activity_at`; no layout change.

## Permission impact
None.

## Tenant-isolation impact
Backfills are set-based across shops (service-role migration SQL) — no app-level cross-tenant paths; app reads unchanged in scoping. Tenant-isolation suite green.

## Security impact
None new.

## Idempotency requirements
Backfills idempotent; `touchCustomerActivity` monotonic (never moves `last_activity_at` backwards).

## Observability requirements
Backfill mismatch counts logged in the migration output and pasted in the close record (real numbers, D-025).

## Analytics requirements
`First lead received` integrity improves (single stage truth) — note in 14.

## Feature flag
`FEATURES.singleTruth.{leadStage,activityAt,lifecycleVocab,vehicleRead,quoteLink}` — short-lived, default ON at merge, removed in a follow-up once the dormant columns' drop is decided (E10).

## Automated tests
- Per slice: characterization before (reader outputs on a seeded shop) == after with the flag on; backfill equivalence (derived vs legacy for every row; mismatches enumerated and expected).
- Grep-tests: no `leads.status` read; no flat vehicle column read outside the write-through helper; no `leads.quote_id` writer.
- Regression: P0-009 quote suites, pipeline/scoring, BI eval (if tool descriptions changed — pasted), audience tests, generated-types drift check.

## Manual acceptance procedure
1. Builder: seed a lead through new → needs_quote → quote_sent → lost; customer file, Ask Gradia ("how many open leads?"), audience preview and KPIs all agree at each step.
2. Builder: complete a job → `last_activity_at` updates; import a customer with `last_transaction_at` → canonical field set; lifecycle derives from the canonical field.
3. Builder: customer with two vehicles → agent audience/owner agent read the primary from `vehicles`.
4. Reviewer (Cursor): falsification pass on the backfill-equivalence proofs and the rollback file.

## Failure cases
- Equivalence mismatch beyond the expected lossy cases → stop the slice, report counts, keep the flag off for that slice (others proceed) — never "fix" by rewriting history silently.
- Saved agent audience configs referencing `lead_status` → compatibility mapping + a one-time migration of config JSON with a report.

## Rollback strategy
Per slice: flag off → legacy reads; migrations additive; legacy columns still written for one release (dual-write) so rollback is lossless within the window; drops never applied here.

## Definition of done
`../12-definition-of-done.md` plus: E03 acceptance criterion 3 evidenced (grep-tests + one vocabulary + one timestamp); equivalence reports with counts in the close record; rollback drops file present/not applied; `03` §Cross-cutting schema debts updated; E03 epic acceptance criteria 1–6 recorded as met (with E03-01/02/03 evidence); `- NEXT:` line for Batch 3 completion after the P3-001 tombstone note.

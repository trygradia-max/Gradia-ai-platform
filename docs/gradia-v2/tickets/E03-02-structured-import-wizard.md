# E03-02 — Structured import wizard (D-022): CSV + Jobber export + Urable export → staging → mapping → preview → commit → rollback

_Cut 2026-09-01 by the Organizer for autorun Batch 3 (`../program/autorun.md`). Specification only._

## Ticket ID
E03-02

## Epic
E03 — CRM and import completion (phase P3)

## Status
**draft — batch-gated.** Autorun Batch 3, queue item 11. Enters after E03-01 is committed. Risk class **database-sensitive** (extends `import_jobs`/`import_messages`; additive). Founder acceptance **YES — with real export files** (autorun table): the founder supplies a real Jobber export and a real Urable export (anonymized is fine) under `eval/fixtures/imports/` or a private location referenced in the log. Decisions binding: **D-022** (six stages), D-006 (real data during trial), D-036 (migration is a first-run requirement), D-035 (import committed = trial activation gate), D-052 (no HCP source), Q-20 open (Jobber stays file-based, no API pull). No open decision blocks it.

## Priority
P3 — Critical for D-036: an established shop arrives with a book of business in Jobber/Urable/spreadsheets; import quality is the first-run trust moment (D-006). The recovery pipeline already meets most of D-022 for mbox/CSV/vCard; the structured-CSV path has generic header rules only (`structured-csv.ts:84-100`), no vendor presets, no mapping persistence, no fixture per source, and **rollback is built but unwired** (`undoRecoveryImport` `actions/recovery.ts:253` has zero call sites).

## Objective
Extend the existing `import_jobs`/`import_messages` substrate (never a third pipeline — `03` §10) into the D-022 wizard for structured sources: source picker (generic CSV, Jobber export, Urable export, Excel `.xlsx` → CSV), per-source header presets + editable mapping, validation with quarantined rows, preview with real counts and dedupe verdicts, commit with source-identifier preservation and idempotent re-upload, and a wired one-action rollback — resumable, shop-scoped, 0 credits for non-LLM rows.

## User outcome
A shop owner drops their Jobber (or Urable) export in, sees "412 customers · 388 vehicles · 17 duplicates · 3 rows need a look", fixes the mapping if a column guessed wrong, commits, and can undo the whole import an hour later if it looked wrong — nothing touches their live customers until they say so.

## Current code references
- Substrate: `import_jobs` `20260616120000_customer_recovery.sql:33-48`, `import_messages` `:53-72`, RLS `:74-93`, bucket `20260616130000_recovery_storage.sql:6-8`, enums `:17-31`, `structured_csv` source `20260708150000_structured_csv_source.sql:9` (founder-applied; code tolerates unapplied `database.ts:290-293`).
- Modules `src/lib/recovery/` (17 files): `parse-contacts.ts:19` hand-rolled `parseCsv` (no library; no `.xlsx`), `structured-csv.ts` (`detectHeaderRow` `:115`, `autoMapColumns` `:153`, `HEADER_RULES` `:84-100`, 15 roles `:26-42`, `applyMapping`/`recordToExtraction` `:261,395`, `extractionNeedsVehicleLlm` `:421`; doc mention of "Urable/Jobber/GHL/Google Sheets" `:3` — **no vendor preset/fixture exists**), `ingest.ts:162,81`, `estimate.ts:27`, `run-extraction.ts:63,81-93`, `dedupe.ts:204` (3-layer), `review.ts:51,143,185,197,216`, `retention.ts:42` (30 d), `winback-eligibility.ts`.
- Routes/actions: `POST /api/recovery/import` `route.ts:40` (60 MB `:28`, types `:29-34`, mapping JSON `:94-103`; service-role → convert to `forShop` if E01-02 missed it), `extract/route.ts:30`; `approveRecoveryCandidates` `actions/recovery.ts:44` (merge `:68-120`, create `:121-130`, duplicate strategy `:29`), **`undoRecoveryImport` `:253` (deletes created customers `:302-308`, restores merges `:309-318`, vehicles by `import_job_id` `:323-327`, timeline `:330-334`) — unwired**, `listRecoveryImports` `:373` unwired, `getRecoveryErrorReport` `:346`.
- UI: `src/components/gradia/recovery-flow.tsx` (`MappingStep` `:331`, `EstimateStep` `:515`, `ReviewStep` `:583`, error CSV `:261`); page `customers/recovery/page.tsx` (flag redirect `:21`, `?job=` resume `:27-33`); `FEATURES.customerRecovery` `features.ts:54`.
- Standard: `07-onboarding-and-imports.md` §3 (six stages + binding rules: no outbound, consent conservatism, tenant scoping, idempotent re-upload via content hash, credits), `ui/flows/crm-import.md`, `03-domain-model.md` §10 (resumable, idempotent, preserve source ids).
- Jobber push seam untouched: `crm-provider.ts` (push-only; no pull method) — import is file-based.
- Source identifiers: no column today for the originating system's record id on `customers`/`vehicles` (needed by `03` §10 "preserve source identifiers").

## Exact scope
1. **Schema (additive):** `import_jobs.kind` (`recovery|structured`) or reuse `source_type`; `import_jobs.mapping jsonb`, `content_hash`, `source_preset`, `committed_at`, `rolled_back_at`; `import_messages` reused as the staged-row table for structured rows (rename in docs only; `extraction jsonb` holds the mapped record) **or** a sibling `import_rows` table if the message-shaped columns are a poor fit — Builder decides and records (ADR-005-style note in the ticket close; must extend the substrate, not fork it); `customers.source_system`, `customers.source_record_id`, `vehicles.source_record_id` (+ partial unique `(shop_id, source_system, source_record_id)`), `import_jobs.summary jsonb` (real counts).
2. **Sources + presets:** generic CSV; **Jobber** client/property/vehicle export (columns per the real fixture); **Urable** export (per fixture); `.xlsx` → parsed via a small pinned dependency (`xlsx`/`exceljs` — justify; or require CSV export and defer Excel with a written state — Builder picks; **prefer CSV-only if the dependency's size/security review is not trivial**, and record). Presets live in `src/lib/import/presets/*.ts` with golden fixtures under `eval/fixtures/imports/` (anonymized real files from the founder).
3. **Mapping UI:** per-source defaults + editable column→field mapping; unmapped **required** fields block with a named reason; mapping persisted on the job (resume-safe); "save as preset for this shop" optional.
4. **Validation:** E.164 phone normalization, email shape, date sanity, VIN format, duplicate detection against live customers (3-layer dedupe), quarantine invalid rows with reasons (never dropped); error report CSV (existing builder).
5. **Preview:** counts (rows / customers / vehicles / merges / skips / quarantined) as real numbers; sample records; dedupe verdict groups; credit estimate = 0 for structured rows, LLM only for `extractionNeedsVehicleLlm` rows (existing) with fail-closed pre-check.
6. **Commit:** idempotent (content hash + per-row source ids → re-running produces no duplicates; re-upload of the same file resumes/reports "already imported"); `source='import'`, `source_system`, `source_record_id` stamped; timeline note; **no outbound side effects** (FR-048); consent stays null; TCPA/EBR gate untouched; `last_transaction_at` from source where present.
7. **Rollback wired:** "Undo this import" on the import job (owner/admin), calling `undoRecoveryImport` extended for structured rows (removes created customers/vehicles not since edited; edited rows flagged for manual review; merges unwound from pre-images); `listRecoveryImports` wired into an Imports list (inside Customers → Import, no new destination).
8. **Resumability:** every stage restartable from staging (`?job=`), extraction chunked (existing), commit batched with progress.
9. **Trial activation:** commit emits the D-035 activation signal ("import committed") through the existing trial machinery if present (P0-013 shipped the tier model; the activation gate implementation is billing-scope — emit the event/flag the shop and record; do not build trial logic here).
10. **Permissions:** import = admin+; rollback = owner/admin (flow doc).
11. Docs: `07-onboarding-and-imports.md` §4 current→target table, `ui/flows/crm-import.md` maturity, `04`, `03` §10, `program/capability-status.md`, `runbooks/broken-import.md` updated for structured jobs, `14` (`Import started/completed` light up).

## Explicit non-goals
- No Housecall Pro source (D-052). No API-pull from Jobber (Q-20 open; file-based only). No Google Contacts (E03 fast-follow), no calendar/quote/payment/membership sources (post-E02/E05/E06 per the source roadmap).
- No LLM extraction changes; no dedupe algorithm changes; no win-back or outbound.
- No third pipeline; no replacement of the mbox/vCard recovery path.

## Dependencies
- E03-01 committed (codegen types; vehicle CRUD; `source_system` columns can land here or there — here). E01-02 (`forShop` on import routes). E01-03 (roles).
- **Founder precondition:** real Jobber + Urable export files (anonymized) provided before the ticket starts; recorded in `autorun-log.md`.
- Decisions: D-022, D-006, D-036, D-035, D-052 — Approved. Q-20 open but not blocking (file-based).

## Expected modules affected
New: `src/lib/import/presets/{jobber,urable,generic}.ts`, `src/lib/import/validate.ts`, `src/lib/import/commit.ts` (extends recovery approve), `eval/fixtures/imports/*`, `eval/import-wizard.test.ts` (+ integration), components `import-wizard.tsx` (extends `recovery-flow.tsx` steps), Imports list UI. Modified: `structured-csv.ts`, `ingest.ts`, `review.ts`, `actions/recovery.ts` (undo extension + wiring), `api/recovery/import/*` routes, `customers/recovery/page.tsx`, `strings.ts`, migration(s), `features.ts` (`crmImportWizard`), docs/runbook.

## Database impact
Additive columns on `import_jobs`, `customers`, `vehicles` (+ partial unique); possibly `import_rows`. RLS inherited (membership policies from E01-01).

## Migration impact
One or two additive, idempotent migrations with rollback notes. **Occupies the DB-sensitive slot.**

## API impact
Existing import routes extended (source + preset params); Imports list action; undo action.

## UI impact
Wizard steps (source → upload → mapping → validation/preview → commit → done) with skeletons, written empties, error report download, progress; Imports list with Undo (confirm dialog with real counts — no browser `confirm()`); mobile per flow doc.

## Permission impact
Admin+ import; owner/admin undo; tech none.

## Tenant-isolation impact
All staging rows shop-scoped; routes via `forShop`/session; fixture-based tenant-isolation test (import into A never touches B; undo scoped).

## Security impact
Bulk PII: private bucket + 30-day retention purge (existing cron extended to structured jobs); MIME/size validation; formula-injection guard on the error-report CSV; no outbound.

## Idempotency requirements
Content-hash per job; `(shop_id, source_system, source_record_id)` unique; commit re-run → zero duplicates (test); undo twice → no error.

## Observability requirements
`[import]` structured logs per stage with job id + counts; SEV-3 alert on commit failure; `runbooks/broken-import.md` procedure.

## Analytics requirements
`Import started`, `Import completed` (14) via the D-045 table if present.

## Feature flag
`FEATURES.crmImportWizard` — default true on merge for the structured path (the recovery path stays under `customerRecovery`). Off → wizard hidden with a written state.

## Automated tests
- Golden-file tests per source (Jobber, Urable, generic; xlsx if shipped): mapping defaults, validation quarantines, preview counts, commit results.
- Idempotency: same file twice → "already imported"; commit re-run → no dupes.
- Rollback: restores exact prior state (row-level equality on seeded DB) incl. merge unwinds; edited rows flagged not deleted.
- Resumability: kill mid-extraction → resume from staging.
- Permission + tenant-isolation tests; no-outbound assertion (no `pending_actions` created by an import).
- Regression: recovery (mbox/vCard) suites unchanged.

## Manual acceptance procedure
1. Builder: import the Jobber fixture → mapping shows sensible defaults → preview counts match the file → commit → customers/vehicles visible with `source_system=jobber` → undo → zero residue (SQL count check).
2. Builder: repeat with the Urable fixture and a generic CSV with a bad phone column → quarantined rows + error CSV.
3. Builder: re-upload the same Jobber file → "already imported".
4. **Founder:** run steps 1–2 with the real (non-anonymized) exports on Preview against a test shop; verify counts against the source system; PASS/FAIL in `autorun-log.md`.

## Failure cases
- Preset mismatch (vendor changed export columns) → mapping UI shows unmapped required fields with names; nothing commits.
- Storage/credit failure → fail closed with written explanation; job resumable.
- Undo after downstream edits → edited rows flagged, listed for manual review; others reverted.

## Rollback strategy
Flag off hides the wizard; migrations additive; any committed import is reversible via its own undo (that is the product). Revert commit otherwise.

## Definition of done
`../12-definition-of-done.md` plus: golden fixtures committed (anonymized); rollback-to-zero-residue test; founder acceptance with real exports PASS; `07`, `03` §10, flow, runbook, capability, analytics docs updated; E03 acceptance criterion 2 evidenced.

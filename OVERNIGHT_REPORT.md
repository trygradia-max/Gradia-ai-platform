# Overnight report — 2026-07-08 (CRM C1 code phase + C7 import wizard)

_Running log for `OVERNIGHT_RUN_2026-07-08.md`. Branch `redesign/glass-box`. Baseline: 282 passing / lint clean / tsc clean._

**Committed and pushed** to `origin/redesign/glass-box` (no main/PR actions):
`3628f17` vehicles accessor + service pricing · `27c7144` seeds + lifecycle ·
`d523d6f` C7 import wizard · `ccb2a59` this report.

## Queue item 1 — C1 vehicles ✅

Most of this item had already landed earlier today (same session, uncommitted):
`src/lib/vehicles.ts` accessor, all `vehicle_make/model/year/color` readers/writers
repointed (approvals lead+booking, owner-agent tools, agent-audience, crm-health,
crm-cleanup + card, recovery import), booking path creates/links the vehicle.
This run added the two things the queue mandates beyond that work:

- **Write-through-deprecated** (queue wording, adopted over the spec's
  read-through wording): every writer keeps writing the flat columns —
  `upsertCustomerVehicle` mirrors to `customers.vehicle_*` (fill-if-empty, the
  exact pre-C1 semantics), lead inserts carry the flat fields again,
  recovery-import insert/merge payloads restored. Rationale in the
  `lib/vehicles.ts` header: pre-migration DBs must not lose vehicle data the C1
  backfill will later read. Flat columns re-typed as `@deprecated` in
  `types/database.ts` so readers get flagged but writers compile.
- **Pre-migration tolerance** (hard rail): `vehicle_id` writes moved OUT of
  inserts into best-effort post-insert updates (the column only exists once the
  founder applies the migration; pre-migration the id is always null so the
  update never fires). Vehicle audience filters fall back to the flat columns
  when the `vehicles` table is missing (marked PRE-MIGRATION FALLBACK in
  `agent-audience.ts`). Vehicle displays (crm-health, owner-agent candidates,
  audience grounding) fall back to flat-column composition.
- Accessor names differ from the queue's suggestion (`getPrimaryVehicle` added
  as suggested; the writer is `upsertCustomerVehicle`, plus
  `vehiclesByCustomerIds`, `customerIdsWithVehicle`, `describeVehicle`).

Gate: 301 passing (282 baseline + 17 pricing + 2 recovery-vehicle), lint clean, tsc clean.

## Queue item 2 — pricing resolution ✅

Landed earlier today; verified against the queue item this run:

- **Deviation from the queue (deliberate):** the module is
  `src/lib/service-pricing.ts`, NOT `src/lib/pricing.ts` — `pricing.ts` is
  already Gradia's credits/markup metering module (gradia-metering-billing
  rules). The spec allowed "`lib/pricing.ts` or similar"; keeping the two
  price domains in separate files prevents shop-menu prices and credit
  pricing from ever cross-contaminating.
- `resolvePriceCents(service, sizeClass?)` → `base_price_by_size[size]` else
  `price_cents`; `resolveDurationMinutes` same shape; `applyConditionMultipliers`
  (skips malformed entries, rounds once); `priceSpread`/`describePrice` for
  unknown-size quoting. Malformed owner-edited jsonb degrades, never throws.
- Readers: vapi-tools `quote_service`, vapi-prompt menu composition (persona),
  Whisper drafting grounding (`drafting-context.ts`), and the draft verifier's
  menu context. All price strings come from one formatter.
- Tests: `eval/service-pricing.test.ts` — 17 cases over config fixtures
  (flat / full map / partial map / malformed / multipliers), including the
  queue's identity eval: the synthesized voice prompt's menu numbers are
  asserted equal to the module's resolution (`describePrice`/`resolvePriceCents`),
  so voice answers and CRM quotes read the same numbers by construction.
  Fixtures live in the test; a pricing-config change does not require a test
  change (config change ≠ test change).
## Queue item 3 — seeds + lifecycle ✅

- `scripts/seed-smoke.mjs` (extended earlier with vehicles + a sent quote) now
  seeds **three jobs across statuses**: `confirmed` (tomorrow, shop, quoted at
  the truck_suv price), `in_progress` (mobile, address + travel fee, deposit),
  and `paid` (last week, sedan price). All tagged `[smoke-seed]`, cleaned on
  re-run. Note: the seed requires the C1 migration (it writes vehicles/quotes/
  job columns) — founder runs it post-migration.
- **Nightly lifecycle derivation** — `src/lib/lifecycle.ts`, code not LLM:
  pure `deriveLifecycle` (latest of last_service_at/last_visit_at/
  last_transaction_at; <180d = active · 180–365d = at_risk · >365d = lapsed)
  with documented carve-outs: no evidence → unchanged, `maintenance` never
  overridden, `won_back` preserved while fresh (<180d) for C8 attribution.
  Cron-safe `runLifecycleDerivation` (paged, batched-by-target UPDATEs,
  idempotent, no-ops with a reason on pre-C1 DBs). **NOT wired into
  vercel.json** per the rail — founder decides the cron slot (see actions).
- Tests: `eval/lifecycle.test.ts` (9 cases: rule boundaries + carve-outs).

Gate: 310 passing, lint clean, tsc clean.
## Queue item 4 — C7 structured-CSV import wizard ✅

Built as a new **source type on the P8 pipeline** — same `import_jobs`/
`import_messages` staging, same review queue, same approve gate. No second
queue anywhere.

- **Migration (founder applies):**
  `supabase/migrations/20260708150000_structured_csv_source.sql` — one
  `ALTER TYPE import_source_type ADD VALUE 'structured_csv'`. Pre-migration,
  starting a structured-CSV import errors cleanly at job creation; nothing
  else changes.
- **Mapping core** (`src/lib/recovery/structured-csv.ts`, pure):
  header-row detection (title rows handled) → auto-mapping by header AND by
  content (opaque "F2"/"Cell 2" columns sniffed via E.164/email/year/date/
  vehicle-string shares) → per-column remap → `applyMapping`. Unmapped
  columns become notes — never dropped silently. Deterministic cleanup in
  code: phone normalization, SHOUTED/lowercased name casing, first+last
  join, ISO/US date parsing. Value mapping for stage ("Estimate Given" →
  quote_sent) and source columns.
- **Deterministic extraction at ingest:** a mapped row IS the owner's list,
  so extraction jsonb is written at staging time with confidence 1 — zero
  LLM spend and no stored bodies (PII win). Vehicles come from part columns
  (owner truth, no regex whitelist) merged over the combined-string parse.
- **LLM only where the spec allows:** rows whose combined vehicle string
  defeats the regex are flagged `vehicle_needs_llm`; the estimate prices
  ONLY those rows (usually a handful); `csv-cleanup.ts` drains them through
  a single-turn Haiku parser (`vehicle-llm.ts`) with the exact P8 metering
  pattern (pre-check at estimating→extracting, fail closed, chunked,
  `outreach_draft` SKU), then `runExtraction` runs the shared finale.
- **Duplicates:** the P8 phone/email/fuzzy-name dedupe classifies as before;
  the approve action now takes the three C7 strategies — update (fill empty
  fields, default) / skip / create — with ambiguous rows still individually
  reviewed. Vehicle dedupe rides `upsertCustomerVehicle` (year+make+model).
- **Stage cards:** an approved row with a LIVE stage (new/needs_quote/
  quote_sent/follow_up) becomes a pipeline card (lead) with stage + source
  linked best-effort post-insert (pre-migration tolerant); booked/lost rows
  are history and stay card-less.
- **Undo via provenance:** every approve writes an undo pre-image into the
  timeline interaction metadata (created customer / merge fill pre-image /
  created lead id); import-created vehicle rows carry `import_job_id`.
  `undoRecoveryImport(jobId)` deletes creations, reverts merge fills,
  removes the import's own timeline entries — exact pre-import state,
  idempotent. Plus `getRecoveryErrorReport` (downloadable CSV of dropped
  rows + reasons) and `listRecoveryImports` (import history).
- **Wizard UI** (`recovery-flow.tsx`): new "Spreadsheet (.csv)" source →
  client-side parse + auto-map (the mapper is pure code) → mapping step with
  per-column dropdowns and sample values → estimate (plain-English zero-
  credit copy when everything mapped) → existing review queue, now with a
  duplicate-strategy selector, stage chips, and the error-report download.
- **Tests:** `eval/recovery-structured-csv.test.ts` — 21 cases over three
  fixture CSVs (Google Contacts export, Jobber-shaped export, messy
  15-column sheet with title row). The P8 acceptance suite is untouched and
  green.

Gate: 331 passing (was 282 at baseline), lint clean, tsc clean, `next build` clean.
## Final state

- **Suite: 331 passing / 4 skipped** (baseline was 282; +49 all new — pricing
  17, lifecycle 9, structured-CSV 21, recovery-vehicle 2), zero existing
  tests broken. Lint clean, `tsc --noEmit` clean, `next build` clean.
- Money/calendar HITL untouched; the locking tests were not weakened. No
  new send paths; the only new metered surface (CSV vehicle cleanup) uses
  the P8 pre-check/fail-closed pattern and the existing SKU.
- Not done / out of scope per rails: no vercel.json cron added (lifecycle
  runner exported only); no C2/C3 UI; live `seed:smoke` not run (writes to
  production Supabase); migrations not applied (founder-only).

## Founder actions needed
- Apply `supabase/migrations/20260708120000_crm_foundation_c1.sql` (already
  validated on embedded Postgres). Until then the code runs in write-through /
  fallback mode; `vehicles`/`quotes`/job-status features stay dormant.
- Apply `supabase/migrations/20260708150000_structured_csv_source.sql`
  (one-line enum add) to enable the C7 spreadsheet import.
- **C7 acceptance caveat:** the wizard is tested against three synthetic
  fixture exports; the spec says "test with real exports before calling this
  done" — run a real Urable/Jobber/GHL export through it before marking C7
  accepted. Migration templates for those formats remain P9.5.
- Run `npm run seed:smoke -- --shop <id>` AFTER the migration to verify the C1
  seed extension against live Supabase (the script now writes vehicles, a
  size-priced service, a sent quote, and three jobs — it needs the C1 schema).
- Decide the nightly cron slot for `runLifecycleDerivation`
  (`src/lib/lifecycle.ts`) — exported and tested, deliberately not added to
  vercel.json (new cron needs your sign-off).

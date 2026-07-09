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

---

# Run report — 2026-07-09 (CRM C3 service menu + quotes, then C2 pipeline)

_Queue: `RUN_2026-07-09_CRM_C3_C2.md`. Branch `redesign/glass-box`. Baseline going in: 331 passing / lint / tsc clean._

## Item 1 — C3a service menu editor ✅

- Settings gains a **Service menu** section (the page's old "coming soon"
  bullet, now real): per-service base price + duration, price AND duration
  per size class (all 8), condition bumps (label × factor), add-on /
  mobile / active flags, quick-add row, and a one-tap detailer template.
- **Spec discrepancy, resolved pragmatically:** §C3 says "prefill from the
  onboarding wizard's template menu — reuse it", but the wizard never
  shipped a template (owners type services by hand). The template now
  lives in `src/lib/service-menu.ts` (`DETAILER_TEMPLATE_MENU`, 7 services
  with size-class pricing) — the wizard can reuse it later.
- Saves split core columns (always safe) from C1 size-class columns
  (best-effort, pre-migration tolerant) and call `markVoiceStale` so the
  receptionist re-syncs — a price edit here changes the phone answer, CRM
  quotes, and Whisper grounding in one move, through `service-pricing.ts`.
- Tests: `eval/service-menu.test.ts` (8) — fixture-driven proof that menu
  edits change `resolvePrice` output, template validity, multiplier hygiene.

## Item 2 — C3b quotes ✅

- **Builder** (`/customers/quotes/new`, linked from customer profiles and
  pipeline cards): customer picker, vehicle picker with inline create
  ("2021 Tesla Model Y, white" → vehicles table), service tiles priced live
  for the vehicle's size class, condition chips, add-ons, discount, note —
  Save draft / Send by text / Send by email. Client preview and server
  write both price through `service-pricing.ts`, so they cannot disagree.
- **Send path reuse (no new send path):** the owner's click stages the
  exact `send_sms`/`send_email` pending action every outbound uses, then
  executes it via `executeApproval` in the same breath — A2P gate, quiet
  hours, opt-out, and consent all apply. A held send stays visible in
  /approvals instead of silently dropping, and the UI says so.
- **Public page `/q/[token]`:** line items, total, validity, shop identity,
  no vendor names, noindex. First open stamps `viewed_at` + timeline.
  Accept/decline update status + pipeline stage + timeline. **Book Now
  inherits the shop's existing booking rule (resolved decision #3):**
  calendar-link shops link out; propose-booking shops get an optional
  time picker whose accept stages the same `book_appointment` pending
  action the voice agent uses — calendar writes stay HITL.
- **Agent staging:** new `propose_quote` voice tool (8th receptionist tool)
  stages a `create_quote` pending action. `create_quote` is in
  **ALWAYS_HITL** (locking tests extended, incl. a source-level check that
  the executor pins `status: "draft"`); even approval only creates a DRAFT
  priced at approve time. Approvals UI renders the new type.
- Tests: `eval/quotes.test.ts` (7, incl. the voice/CRM price-identity
  assertion), guardrails + voice-builder locks extended.

## Item 3 — C2 pipeline UI + hub ✅

- **/customers is now the hub** (resolved 5-page IA): Pipeline (default) ·
  Customers · Quotes tabs. Old flows intact: customer table + cleanup card
  under the Customers tab (search preserves the tab), recovery import
  unchanged, `/leads` still redirects (a lead IS a pipeline card now).
- **Board:** 6 columns per spec, headers = stage dot + label + count + $
  total (`.font-data`); card face = name · vehicle · interest chip ·
  quote $ · amber/red stage-age vs `next_action_at` · source icon · ⚡ when
  a pending approval touches that person. HTML5 drag on desktop; mobile =
  stage-grouped list with a Stage select. Table-view toggle. New Lead
  modal = 3 fields. Right slide-over = contact header, vehicle chip, quote
  link (or "Quote this"), timeline from `interactions`, next action, note box.
- **Lost requires a reason** — enforced in the ACTION (code), not just UI.
- **Auto-moves are code on real events:** agent/owner lead creation → `new`
  (approvals + owner-agent hooks), quote sent → `quote_sent`, quote
  declined → `lost`, booking approved → `booked` + customer lifecycle
  flip to active. Timer sweep `advanceQuoteFollowUps` (quote_sent past
  `next_action_at` → follow_up) is exported cron-safe but NOT wired into
  vercel.json — founder picks the slot (same posture as lifecycle.ts).
  Stage moves flow through ONE helper (`lib/pipeline.ts` `moveLeadToStage`)
  with history, timers, and legacy-status write-through; everything is
  pre-C1-migration tolerant.
- Tests: `eval/pipeline.test.ts` (5) — stage set, timer defaults, legacy
  fallback, history semantics.

## Final state

- **353 passing / 4 skipped** (331 → +8 menu, +7 quotes, +5 pipeline, +2
  extended locks), lint clean, tsc clean, `next build` clean after every item.
- Locked principles held: pricing only through service-pricing (identity
  eval still passing); money/calendar HITL extended (create_quote), never
  weakened; no new send path; no C4–C8 work.

## Founder actions needed
- Apply the two pending migrations (C1 foundation + structured_csv enum) —
  quotes/pipeline/vehicles run in tolerant fallback until then.
- Visual review of the three new surfaces: Settings → Service menu,
  /customers (Pipeline + Quotes tabs) and the builder, /q/[token] public page.
- Smoke a real quote send on the test shop (SMS with A2P-approved number;
  email fallback otherwise) and an accept from the public page.
- Pick cron slots for `advanceQuoteFollowUps` (pipeline timers) and
  `runLifecycleDerivation` (nightly lifecycle) — both exported, neither wired.

---

# Run report — 2026-07-09 (CRM C4 jobs + calendar, C5 automation catalog)

_Queue: `RUN_2026-07-09_CRM_C4_C5.md`. Branch `redesign/glass-box`. Baseline in: 353 passing / all gates clean._

## Item 1 — C4a job status machine ✅

- `lib/jobs.ts`: the 8-status flow with an explicit transition map (every
  status reachable from booked, money tail one-way, on_hold pauses live work
  and resumes, no skipping to completed). Every transition = one owner tap
  writing the customer timeline with machine-readable refs — the C5 sweeps
  key off those events. `completed` arms the vehicle's maintenance clock
  from service-category intervals (code defaults: protection 12mo, detail/
  interior 6mo, wash 1mo; owner-editable later). `closeOldPaidJobs` sweeps
  paid → closed after 48h (rides the new automations cron).
- Job card slide-over (`job-card-sheet.tsx`): status taps + hold-reason
  picker, manual unpaid/deposit/paid toggle (no new payment features),
  mobile fields only for mobile jobs (maps link, travel fee, water/power,
  weather flag — manual, no API), shop fields otherwise (bay, key tag).
  checked_in prompts walk-around photos, completed prompts after-photos —
  camera capture into a new PRIVATE `job-photos` bucket (migration
  `20260709120000_job_photos_bucket.sql`, founder applies; signed URLs).
- 10 tests: reachability, one-way money tail, hold semantics, maintenance
  clock arithmetic + idempotent re-arm.

## Item 2 — C4b Calendar page ✅

- **Calendar is the 5th nav destination** (sidebar, after Customers); the
  old `/schedule` (Aurinko events list) redirects, layer-2-shell pattern.
- Desktop: week grid, jobs as status-dot-colored blocks positioned by time
  (status is never color alone), bay chips on shop jobs, weather-risk icon,
  HTML5 drag-to-reschedule — the MOVE is the owner's own action (calendar
  event follows best-effort), the customer HEADS-UP stages a send_sms
  approval per the rail. Block-time support (appointment-shaped, dashed).
  Capacity warning when a day's booked minutes exceed working hours — code
  default 8h/day, tunable via `shops.settings.calendar.working_hours_per_day`
  (no structured booking-rules hours exist yet; the wizard only stores free
  text — flagged as a spec-vs-reality note).
- Mobile: drive-order day list (time order; optimization deliberately out
  of scope) — one-tap next-status button, maps link, the job card for
  photos. The solo mobile detailer's day, phone-only.

## Item 3 — C5 automation catalog ✅

- **Toggles, not a builder** (`lib/automations.ts`): the 8 catalog entries
  as plain-English sentences; Settings → Automations shows toggle + mode +
  editable template ({tokens} fill from code, never a model) + run history
  ("N sent · N waiting · recovered N bookings" — computed from
  automation_runs joined to booked leads, in SQL/code, no estimates).
- **Send discipline:** every automation stages the standard send_sms
  pending action. approval → waits in /approvals. autopilot → executes via
  `executeApproval` — the SAME A2P/quiet-hours/opt-out/metering gate as
  every outbound, with a credit pre-check (fail closed → degrades to
  staged) and a Package-2 entitlement gate (Core shops stay approve-first;
  autopilot degrades to staging, never silence, preserving the packaging).
  Source-lock test: neither the runner nor the sweeps can touch a raw
  sender.
- **Hard floor:** `AUTOPILOT_BARRED_AUTOMATIONS` lives in autonomy.ts next
  to ALWAYS_HITL; barred entries can't be saved OR run as autopilot, and
  stale DB rows degrade on read. Locked by tests that force the catalog's
  touchesMoneyOrCalendar flags and the barred set to agree both ways.
  (None of the launch 8 are barred — the floor exists so a future entry
  can't quietly cross it.)
- **Wiring, in code:** #1 new-lead (5-min no-contact) and #2 missed-call
  (ended-reason keywords or <10s calls, no text since) sweeps; #3 quote
  follow-up wires `advanceQuoteFollowUps` through the catalog with 2d/5d/
  12d escalating copy (3 touches max, idempotent per touch); #4 revival
  (21d silent, must have engaged); #7 job-completed and #8 review-request
  (4h default, tunable; skips entirely without a review link) key off the
  C4 timeline events. All idempotent via automation_runs trigger_ref.
- **#5/#6 ZERO BEHAVIOR CHANGE:** the existing confirm/reminder crons keep
  their exact machinery (same staging, same idempotency stamps, same
  drafted/built-in copy) and now consult the catalog: defaults are
  enabled + approval — i.e., today's behavior byte-for-byte; an owner can
  disable, re-copy, or opt into autopilot. Source-scan tests lock the
  machinery AND the consult. Note: the spec table lists #5/#6 as default
  autopilot — the zero-behavior-change rail wins; flagged for the founder.

## ⚠ New cron entry (flagged for founder review pre-merge)

- `vercel.json` adds `/api/cron/automations` every **5 minutes** (its own
  commit). The cadence exists for #1 new_lead_instant, where a 5-minute SLA
  is the point; everything it runs is idempotent (trigger_ref dedupe),
  stages through pending_actions, and sends only through the gated path —
  a fast cadence cannot double-send. It also hosts the C4 close sweep.
  #5/#6 stay on their existing hourly crons.

## Final state

- **375 passing / 4 skipped** (353 → +10 jobs, +12 automations), lint, tsc,
  `next build` clean after every item.
- Rails held: money/calendar HITL (reschedule notifications stage; floor
  extended + locked), one send path, pre-migration tolerance everywhere,
  no team roles / weather API / route optimization / payment features.

## Founder actions needed
- Apply migration `20260709120000_job_photos_bucket.sql` (plus the two
  still-pending C1/C7 migrations if not yet applied).
- **Review the new 5-minute cron** (`/api/cron/automations`) before merge.
- Visual pass: Calendar (desktop week + mobile day list) and Settings →
  Automations.
- Smoke on the test shop: one autopilot automation (flip new_lead_instant
  on for a Package-2 shop) and one approval automation (quote_followup) —
  and confirm #5/#6 behavior is unchanged with the catalog untouched.

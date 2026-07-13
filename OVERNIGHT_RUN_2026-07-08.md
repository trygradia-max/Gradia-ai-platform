# Overnight run — 2026-07-08 (CRM C1 code phase + C7 import wizard)

_Work queue for Claude Code, unattended. Same rules as OVERNIGHT_RUN_2026-06-11: work top to bottom, one item at a time, full suite + lint + tsc green after EVERY item, update OVERNIGHT_REPORT.md as you go, STOP when the queue is empty. Do not start new work beyond this queue._

## Hard rails (do not cross)
- Branch: `redesign/glass-box` only. **No merges, no pushes to `main`, no PR actions.**
- **No production/database actions** — migrations are applied by the founder. Code must tolerate the C1 migration being applied or not where feasible; tests run against fixtures/mocks per existing patterns.
- No gated work: no Gmail/Outlook OAuth, no Own-Vapi, no team roles, no ServiceTitan, no HCP `TODO(verify)` guessing.
- All locked principles in root `CLAUDE.md` apply. Money/calendar writes stay HITL; extend locking tests, never weaken.
- Spec of record: `_docs/GRADIA_CRM_FOUNDATION_SPEC.md` (read the STATUS line first — C1 schema migration already landed: `supabase/migrations/20260708120000_crm_foundation_c1.sql`).
- Open decisions #2–#4 in the spec are UNANSWERED → **do not start C2/C3 UI work.** Queue below only.
- Baseline to preserve: 282 tests passing, lint clean, `tsc --noEmit` clean (verified 2026-07-08).

## Queue

### 1. C1 code phase — vehicles
- [ ] Grep all readers/writers of `customers.vehicle_make/model/year/color` and `leads.vehicle_*` (incl. `vehicle_color` migration consumers, structured segments, recovery extraction mapping) → repoint to the `vehicles` table via a small accessor module (`src/lib/vehicles.ts`: getPrimaryVehicle, upsertVehicleForCustomer). Legacy columns become write-through-deprecated (keep writing both until a follow-up migration drops them; note this in the module header).
- [ ] Lead→customer conversion path (booking approved) creates/links the vehicle record.

### 2. C1 code phase — pricing resolution
- [ ] `src/lib/pricing.ts`: resolvePrice(service, sizeClass?) → `base_price_by_size[size]` else `price_cents`; resolveDuration same shape; condition-multiplier application. Unit tests with config fixtures (config change ≠ test change).
- [ ] Repoint vapi-tools/persona quoting composition to read through this module. Voice answers and future CRM quotes must produce identical numbers — add an eval asserting it.

### 3. C1 code phase — seeds + lifecycle
- [ ] Extend `scripts/seed-smoke.mjs` with vehicles, a quote, and a job across statuses.
- [ ] Nightly lifecycle derivation job (code, not LLM): active/at_risk/lapsed rules per spec §C1.3, wired as a cron-safe function with tests (no new vercel.json cron without founder sign-off — export the function and note it in the report).

### 4. C7 — structured-CSV import wizard (spec §C7)
- [ ] New `structured_csv` source type on `import_jobs` + mapping step (header AND content-based auto-mapping; per-column remap; unmapped → notes).
- [ ] Vehicle parsing (separate cols or combined "2019 Honda Civic" strings) → `vehicles` rows.
- [ ] Value-mapping for stage/source columns; duplicates: phone/email/fuzzy-name, three strategies + ambiguous review; vehicle dedupe.
- [ ] Deterministic cleanup in code (E.164, casing, name split); LLM only for vehicle strings regex misses (Haiku, metered, pre-check — P8 pattern).
- [ ] Undo via `import_job_id` provenance; error report; import history entry. Reuse the P8 review queue — building a second queue is a spec violation.
- [ ] Tests against fixture CSVs: Google Contacts export, a Jobber-shaped export, a messy 15-column sheet. P8 acceptance suite stays untouched and green.

### 5. Wrap
- [ ] Full suite + lint + tsc. Update `OVERNIGHT_REPORT.md`: what shipped, what's blocked, exact founder actions needed. Commit to `redesign/glass-box` with clear messages (no push if push fails auth — leave committed).
- [ ] STOP.

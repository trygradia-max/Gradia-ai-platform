# E03 — CRM and Import Completion

_Created 2026-07-25 by the Organizer. Phase: **P3**. Status: planned._

## Objective

Finish the CRM as a standalone product (D-002: works fully with AI off): direct customer create/edit/export, vehicle completion (VIN/trim/history), the single-source-of-truth data pass, a structured CRM import wizard meeting D-022's staging/mapping/preview/validation/rollback bar, and finally wiring `lifecycle.ts` so win-back has fuel.

## User outcome

A detailer migrating from Jobber, Housecall Pro, or a spreadsheet imports their whole book of business with a preview and an undo, adds a walk-in customer directly, sees each vehicle's full service history, and exports their data any time. Their "at risk" and "lapsed" customers are actually computed.

## Business reason

D-006 lets trial users import real data — import quality *is* the first-run trust moment. Audit doc 03: no direct "Add customer" form, no export, VIN NOT_FOUND, win-back "has no fuel" because lifecycle derivation is deliberately unwired. Dual sources of truth (`leads.status` vs `stage`, flat vehicle columns) are live divergence risks (audit doc 05 §weaknesses 3).

## Current foundation

- Identity spine: `customers.ts` find-or-create, channel partial-uniques, 3-layer dedupe, merge, consent ledger.
- Recovery import pipeline (`src/lib/recovery/*`, 2,440 lines): staging tables (`import_jobs`/`import_messages`), review queue, approve-with-undo, retention cron — the D-022 pattern already exists for mbox/CSV/vCard.
- `vehicles` table (C1) with size_class, condition columns, coating/PPF/tint jsonb; `lifecycle.ts` finished and deliberately unwired; `lifetime_value_cents`.
- CRM seam (`crm-provider.ts`, Jobber direct, HCP `TODO(verify)`).

## Missing work

1. Direct customer create/edit forms + server actions (fix the orphan-lead edge in `quickCreateLead`, audit doc 04-A).
2. Customer CSV export (and per-customer file export groundwork for E10's GDPR flow).
3. Vehicles: VIN + trim columns, structured entry (replace regex-only text parse as sole path), edit UI, per-vehicle service-history view; retire flat vehicle columns on customers/leads.
4. Single-truth pass: retire `leads.status` (keep `stage`), consolidate the three "last activity" timestamps and three lifecycle vocabularies, break the circular `quotes.lead_id` ↔ `leads.quote_id` (pick one direction).
5. Structured CRM import wizard: source picker (Jobber/HCP export, generic CSV) → field mapping → staged preview with validation + error report → approve → rollback window. Reuses recovery staging machinery (extends `import_jobs`/`import_messages` — never a third pipeline, per `03-domain-model.md` §10); meets D-022 clause-by-clause. **Source roadmap (added 2026-07-27):** E03 ships CSV + Excel + Jobber export (+ HCP per Q-19 outcome); staged later sources, each behind the same wizard: **Google Contacts** (E03 fast-follow), **future appointments / calendar import** (post-E02, native calendar required), **quotes** (post-E05 model), **Square/Stripe customer & payment history** (post-E05, where supported), **memberships and fleet accounts** (post-E06 models exist). Each source lands only when its target domain exists — importing into a domain that isn't built yet is scope error, not ambition.
6. Wire `lifecycle.ts` to the automations cron — **after** founder signs off thresholds (decision queue Q-02; audit open question 2).
7. DB type codegen (`supabase gen types`) replacing hand-written `database.ts` (audit doc 09 risk 6).
8. Customer tags UI (column exists, no surface).

## Domain entities

Modified: `customers`, `leads` (status retirement), `vehicles` (VIN/trim), `quotes` (link direction). New: import wizard staging rows (extend `import_jobs` kinds) — no new core entities.

## Backend services

`customers.ts`, `vehicles.ts`, `lifecycle.ts` (cron wiring), import wizard modules extending `src/lib/recovery/`, export module, codegen pipeline in CI.

## UI surfaces

Customers: Add/Edit customer, tags, export button; vehicle profile page with history; import wizard flow (`ui/flows/crm-import.md`); lifecycle chips on customer file.

## Integrations

Jobber/HCP as *export sources* for the wizard (file-based first; API-pull later). HCP live verification (audit open question 12) must happen before advertising HCP import. Vendor posture (D-030): Jobber is **optional** — a migration/temporary-sync source, never a core dependency (Q-20); Housecall Pro is **quarantined** — this epic includes ticket **P3-001** (HCP dependency review), whose report feeds decision Q-19 (import-only vs removal) before any HCP import work is advertised or built.

## Security implications

Import files are bulk PII: same private-bucket + retention-purge discipline as recovery imports; export endpoints owner/admin-role-gated (E01 roles); validation rejects formula-injection in CSV round-trips.

## Tenant implications

All import staging rows shop-scoped; wizard runs under the session client (RLS) wherever possible, `forShop()` elsewhere. E01 must be done: no new tables before members lands (D-018).

## Migration implications

The single-truth pass is the riskiest migration set in the program so far: column retirements need dual-write → backfill-verify → cut-read → drop sequencing across several releases. Codegen types land first so drift is visible.

## Product analytics

Lights up: `Import started`, `Import completed`, `First customer created`. Improves integrity of `First lead received` (single stage truth).

## Dependencies

E01 (roles for export/import permissions; D-018 ordering). P0-009 (quote linkage fixed before touching the circular link). Decisions: D-022 (approved), lifecycle thresholds (Q-02, founder), direct-create confirmation (Q-03 — audit open question 4; this epic assumes "omission, build it").

## Risks

- Retiring `leads.status` touches every pipeline read — characterization tests + staged read-cutover.
- Import mapping errors at trial time are trust-fatal (D-006): the preview/validation/error-report steps are not optional polish, they're the product.
- Codegen may reveal drift between `database.ts` and real schema — budget reconciliation time.

## Non-goals

No campaign features (E07/E09), no two-way CRM *sync* (push seam stays one-way), no promotions entity, no per-customer preference center beyond consent (exists).

## Feature flags

`FEATURES.crmImportWizard`; single-truth cutover behind short-lived migration flags per slice.

## Testing requirements

Migration tests per retirement slice (backfill equivalence proofs); import wizard: golden-file tests per source format, malformed-file failure paths, rollback restores exact prior state; export round-trip test (export → import → identical); lifecycle derivation unit tests against threshold spec; RLS/permission tests on new actions.

## Rollout plan

Codegen + direct create/export first (small, independent). Wizard behind flag on internal shop with a real Jobber export; pilots next. Single-truth slices one at a time, each with its own verify window. Lifecycle cron last, after Q-02 sign-off, with win-back audience counts monitored the first week.

## Acceptance criteria

1. Create → edit → export a customer with AI features disabled entirely (D-002 demo).
2. A real Jobber CSV export imports through staging/mapping/preview/validation/error-report and can be rolled back to zero residue (D-022).
3. `leads.status` no longer read anywhere (grep-test); one lifecycle vocabulary; one activity timestamp.
4. A vehicle shows VIN, trim, and a service-history list traced to real rows.
5. `at_risk`/`lapsed` populate on the seeded aging fixture and feed the win-back audience gate.
6. `database.ts` is generated, not hand-written; CI fails on schema/type drift.

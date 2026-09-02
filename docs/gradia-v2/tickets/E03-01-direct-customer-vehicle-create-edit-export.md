# E03-01 — Direct customer and vehicle create/edit, customer export, tags UI (D-040)

_Cut 2026-09-01 by the Organizer for autorun Batch 3 (`../program/autorun.md`). Specification only._

## Ticket ID
E03-01

## Epic
E03 — CRM and import completion (phase P3)

## Status
**draft — batch-gated.** Autorun Batch 3, queue item 10 (first ticket on `auto/batch-3`). Enters only after Batch 2 is merged. Risk class **database-sensitive** (additive columns + DB type codegen). Founder acceptance **no**. Decisions binding: **D-040** (build direct create/edit), D-002 (works without AI), D-048 (export/import permissions), D-049 (Sales/Customers IA unchanged — no new destination), D-036 (import/migration first-run). No open decision.

## Priority
P3 — High. There is **no way to add a customer directly** (verified: `src/app/actions/customers.ts` exports only `setCustomerDoNotContact/listMergeCandidates/mergeCustomers`; the only CTA is "Import customers"); vehicles have no CRUD UI; there is no customer export (`grep text/csv` → only the import error report). D-002's "CRM usable with AI off" demo (E03 acceptance criterion 1) is impossible today.

## Objective
Add customer and vehicle create/edit forms and server actions (AI-free path), a customer CSV export, a tags UI on the customer file, and replace the hand-written `database.ts` with Supabase-generated types so the C1 columns stop being reached by casts — with permission gating from E01 roles.

## User outcome
A walk-in customer is added in 20 seconds with their vehicle; the owner edits a phone number or VIN in place; tags mark VIP/fleet/ceramic customers; an admin exports the customer list to CSV any time.

## Current code references
- Customers: `src/lib/customers.ts` (5 exports: `normalizePhone` `:18`, `normalizeEmail` `:27`, `findCustomerByChannel` `:58`, `findOrCreateCustomer` `:92`; the only inserts `:153-162` and `src/app/actions/recovery.ts:125-129`). Mutating action today: `updateCustomerDetails` `src/app/actions/crm-cleanup.ts:126` (schema `:116-122`: phone/email/flat vehicle cols only — no name). Merge: `actions/customers.ts:134`. Quick-create lead creates a customer `src/app/actions/pipeline.ts:69-92` (orphan-lead edge, audit 04-A).
- Customer pages: `src/app/(dashboard)/customers/page.tsx` (3-tab hub `:20-24`; CTA `:64-72`), `customers-table.tsx:222-227`, `customers/[id]/page.tsx` (renders legacy `status` `:42-52`), data `src/lib/data/customers.ts:23,126`; components `customer-summary-card.tsx`, `customer-merge-dialog.tsx`, `do-not-contact-toggle.tsx`, `interaction-timeline.tsx`.
- Columns: `customers` base `20260508140000_customers.sql:5-15` (+ channel partial uniques `:24-38`), recovery cols `20260616120000_customer_recovery.sql:9-12`, flat vehicle cols `20260615130000_structured_segments.sql:12-14` + `20260615160000_vehicle_color.sql:7`, C1 `20260708120000_crm_foundation_c1.sql:128-147` (`lifecycle, lifetime_value_cents, jobs_count, last_service_at, next_recommended_*, tags`); `CustomerRow` `src/lib/types/database.ts:237-268` **lacks the C1 columns** (reached by casts `lifecycle.ts:77-80`, `pipeline.ts:95`).
- Vehicles: `vehicles` `…c1.sql:74-121` (year/make/model/trim/color/size_class/plate/**vin**/photos/conditions/coating/ppf/tint/maintenance_schedule/notes/import_job_id); writes only via `upsertCustomerVehicle` `src/lib/vehicles.ts:123` (write-through to flat cols `:136-152`) and `addCustomerVehicleFromText` `src/app/actions/quotes.ts:341` (regex text parse). No VIN decode; `trim` exists (E03 epic says "VIN + trim columns" — columns exist; entry/edit UI does not).
- Export: `buildErrorReportCsv` `src/lib/recovery/review.ts:197` (only CSV builder; no `Content-Disposition` anywhere).
- Types/codegen: no generated types; no `db:types` script; `supabase` CLI not a devDependency; CI integration job already boots the CLI (`ci-integration.yml:36-46`).
- Analytics: `First customer created` (14).
- Permissions (E01-03): `requireMember('admin')` pattern; export = owner/admin (E03 epic security).

## Exact scope
1. **DB type codegen first:** `supabase gen types typescript --local` → `src/lib/types/supabase.generated.ts`; `database.ts` row types re-exported from the generated file (keep hand-written *domain* enums/helpers that are not schema); `npm run db:types` script; CI integration job diffs generated output against the committed file and fails on drift (E03 acceptance criterion 6). Reconcile any drift found (budgeted; recorded).
2. **Customer create/edit:** `createCustomer`/`updateCustomer` server actions (zod: name required; phone/email normalized via `customers.ts`; consent fields untouched; `source='manual'`), duplicate guard using `findCustomerByChannel` → written "looks like an existing customer — open or merge" state (never silent merge); Add-customer dialog from the Customers tab CTA row (secondary to the existing primary per screen rule — Builder places one primary), Edit on the customer file (name/phone/email/notes/do-not-contact stays its own toggle); orphan-lead edge (`quickCreateLead`) fixed so a lead created from the board always links its customer.
3. **Vehicle create/edit:** `createVehicle`/`updateVehicle` (year/make/model/trim/color/size_class/plate/VIN with format check — no decode vendor), vehicle list + edit sheet on the customer file; per-vehicle service-history list traced to real `appointments`/`quotes` rows (E03 acceptance criterion 4: "a vehicle shows VIN, trim, and a service-history list traced to real rows"); text-parse path (`addCustomerVehicleFromText`) remains for quotes but is no longer the sole path.
4. **Tags:** chips editor on the customer file (existing `tags text[]` column), filter by tag in the table; written empty state.
5. **Export:** `exportCustomersCsv` (owner/admin) — streamed CSV via a route handler with `Content-Disposition`, shop-scoped, RFC-4180 quoting, **formula-injection guard** (prefix `=+-@` cells), includes vehicles as repeated rows or a vehicles column set (Builder picks; document), respects nothing about consent (export is the owner's own data); rate-limited (existing bucket); analytics `Export completed` (candidate — record in 14 as candidate, do not extend the canonical set silently).
6. **Permissions:** create/edit/tags = admin+ (tech read-only until E04-04); export = owner/admin; permission tests.
7. Docs: `04-capability-map.md` (customer CRUD live, export live), `ui/flows/*` if a customer-file flow references it, `03-domain-model.md` §2 status, `14-product-analytics.md` (`First customer created` lights up; `Export completed` candidate), `program/capability-status.md`.

## Explicit non-goals
- No import wizard (E03-02), no lifecycle wiring (E03-03), no `leads.status` retirement or flat-column drops (E03-04).
- No VIN decode vendor, no photo upload changes, no vehicle warranty records (E06-era).
- No campaigns, no per-customer preference center, no global search (design choice deferred per `06` §Global search).
- No new sidebar destination (Sales → E03 IA promotion is a separate BUILD_REFERENCE amendment via D-049 — not in this ticket).

## Dependencies
- Batch 2 merged (E01-01 RLS, E01-03 `requireMember`). P0-009 done (quote linkage).
- Decisions: D-040, D-002, D-048, D-049 — Approved.

## Expected modules affected
New: `src/lib/types/supabase.generated.ts`, `src/app/actions/customers.ts` (extended), `src/app/actions/vehicles.ts`, `src/app/api/customers/export/route.ts`, components `add-customer-dialog.tsx`, `customer-edit-form.tsx`, `vehicle-sheet.tsx`, `tags-editor.tsx`, `eval/customers-crud.test.ts`, `eval/export.test.ts`. Modified: `database.ts` (re-exports), `package.json` (`db:types`), `ci-integration.yml` (drift check), `customers/page.tsx`, `customers-table.tsx`, `customers/[id]/page.tsx`, `src/lib/vehicles.ts`, `src/app/actions/pipeline.ts` (orphan fix), `strings.ts`, docs.

## Database impact
Possibly none; if `source='manual'` is not an allowed value or `vehicles.vin` lacks a format CHECK, one additive migration. Codegen reads the schema (no change).

## Migration impact
Zero or one additive migration; **occupies the DB-sensitive slot** while in progress (codegen drift reconciliation may also require it).

## API impact
Server actions + one authenticated export route (session, owner/admin).

## UI impact
Add-customer dialog, edit form, vehicle sheet, tags chips, export button (admin+) with pending/success/error states; skeletons; written empties.

## Permission impact
As scope 6; tech sees read-only customer file until E04-04.

## Tenant-isolation impact
Session client + `.eq("shop_id")`; export route builds from `requireMember` shop only; tenant-isolation test for export (shop A export never contains shop B rows).

## Security impact
CSV formula-injection guard; export rate-limited and logged (who exported when — audit line); PII handled as existing.

## Idempotency requirements
Create with an existing channel → duplicate guard (no silent double); export is read-only.

## Observability requirements
`[customers]` logs for create/edit/export with actor member id.

## Analytics requirements
`First customer created` emitted (D-045 table if present); `Export completed` recorded as a candidate in 14.

## Feature flag
None — core CRUD (D-002); export behind `requireMember('admin')` only.

## Automated tests
- Unit: zod schemas, normalization, duplicate guard, VIN format, CSV quoting + injection guard.
- Integration: create/edit/export round trip; vehicle history traced to seeded appointment/quote rows; codegen drift check fails on a schema change without regenerated types.
- Permission matrix per action per role; tenant-isolation for export.
- Regression: merge/do-not-contact/recovery suites unchanged.

## Manual acceptance procedure
1. Builder (AI features off via flags): add a customer + vehicle → edit phone → add tag → export CSV → open in a spreadsheet: correct rows, no formula execution on a seeded `=1+1` name.
2. Builder: attempt to add a customer with an existing phone → guard state → open existing.
3. Builder: as a tech member → forms hidden/refused; as admin → allowed; as owner → export allowed.
4. Reviewer (Cursor): confirm `database.ts` types come from the generated file and CI drift check runs.

## Failure cases
- Codegen reveals drift (e.g. `structured_csv` enum value applied only in prod) → reconcile with an additive migration or a documented local-only difference; never hand-edit generated output.
- Export of a huge shop → streamed; if > N rows, paginate the stream (no memory blowup) — test with 10k rows.

## Rollback strategy
Revert the commit; generated types file can be regenerated; any additive migration stays dormant.

## Definition of done
`../12-definition-of-done.md` plus: codegen in CI (drift check green), E03 acceptance criteria 1, 4 (VIN/trim/history) and 6 evidenced in the close record; capability/analytics/domain docs updated in the same change.

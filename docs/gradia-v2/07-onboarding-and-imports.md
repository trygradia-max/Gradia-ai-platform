# 07 — Onboarding and Imports

_Created 2026-07-25 by the Organizer. Governs first-run onboarding, trial start, and every data-import path. Binding standard: D-022 (staging → mapping → preview → validation → error reporting → rollback) and D-005/D-006 (full operational trial; real CRM + calendar data may be imported during setup/trial). Flow specs: `ui/flows/onboarding.md`, `ui/flows/crm-import.md`, `ui/flows/calendar-connection.md`, `ui/flows/trial-to-paid.md`._

## 1. Onboarding — current state (audited, trace K)

Supabase signup → any dashboard route → `requireShop()` → no shop → redirect `/onboarding` → 5-step wizard:

1. **Shop** (identity, timezone) — required
2. **Service menu** — skippable (Continue is unconditional; a warning shows when zero services — verified in `onboarding-wizard.tsx` `ServicesStep`); starter template is an explicit tap (`applyDetailerTemplate`), never auto-seeded
3. **Inbox** (email connect) — skippable
4. **Number** (Twilio provisioning / BYO / A2P) — skippable
5. **Receptionist** (voice builder) — skippable

(Steps 2–5 are all skippable; only step 1 is required. `ui/flows/onboarding.md` agrees with this list as of 2026-07-27.)

Properties to preserve: **zero founder-touch** (every step self-serve — principle 9, audit-verified), no seeded fake data (D-025), multi-shop via `?new=1`, plan defaults to `free` with downstream gating (not a dashboard wall).

## 2. Onboarding — target (P3, E03; trial per D-005)

Additions, in order of user value:

1. **Trial start** — signup opens a full operational trial (D-005): all features on, variable-cost allowances metered and fail-closed (allowance numbers: decision queue Q-13). The existing credit machinery is the enforcement mechanism; no new gate system. Trial state and remaining allowance surface in Numbers & Billing and the topbar pill.
2. **Import step in the wizard** — after Shop, offer "Bring your customers in" (D-006): CRM import (Jobber / Housecall Pro / CSV) and calendar connection. Skippable; resumable from Customers later. Import quality is a first-run trust moment — a bad first import loses the customer, hence the D-022 bar below.
3. **Business profile completeness** — the wizard records which steps were skipped and Home surfaces the next setup action (SetupProgressPill exists); analytics events per `14-product-analytics.md` (`Business profile completed`, `Import started/completed`, `Calendar connected`, `Service menu configured`).

## 2b. Target onboarding — full build-out (founder master definition, 2026-07-27)

The founder's target onboarding is a 12-step flow. It is recorded here as the **destination**, phase-tagged — several steps depend on domains that do not exist yet (E01 teams, E05 payments); the §1 wizard is the live subset, and §2 is the P3 increment. No step may be marked live before its phase ships.

| # | Step | Today | Phase |
|---|---|---|---|
| 1 | Business profile | Live (wizard step 1) | — |
| 2 | **Workflow template** — choose one of **five**: *Mobile detailer · Detail shop · Ceramic & PPF shop · Tint & wrap shop · Fleet operator*. Today only one generic detailer starter template exists (`applyDetailerTemplate`); the five templates configure service menu, scheduling model (mobile/shop/hybrid), and default workflows | Missing | E03 (menu/CRM templates) + E02 (scheduling model) |
| 3 | Customer and CRM import | P3 target (§2) | E03 |
| 4 | Service-menu setup | Live (wizard step 2) | — |
| 5 | Calendar connection | Live (wizard step 3) | — (native: E02) |
| 6 | Team and resource setup | Missing (Settings → Team lands with E01; bays/resources E04) | E01/E04 |
| 7 | Communication setup | Partial (number/A2P = wizard step 4) | E07 completes |
| 8 | Payments setup | Missing | E05 |
| 9 | Gradia knowledge and approval setup | Partial (voice builder = wizard step 5; no approval-defaults step) | E09 (approval defaults with autonomy UX) |
| 10 | **Simulated workflow validation** — run the core loop against test data before live traffic; today only the receptionist test call exists | Missing | E03+ (grows per phase) |
| 11 | Trial activation — **D-032: the trial starts at meaningful setup/activation, not email signup**; gate definition open in Q-13 | Missing (trial itself unbuilt) | E03/billing |
| 12 | Guided first-value checklist | Partial (SetupProgressPill + next-recommended-action) | E03 formalizes |

**Readiness gate (binding once the flow exists):** an account is not marked **ready** until the core workflow has been tested end-to-end: **Lead → Quote → Acceptance → Appointment → Job → Payment → Follow-up**. Until E05 ships the payment leg (and E04 the job leg), the gate covers the live subset — **Lead → Quote → Acceptance → Appointment → Follow-up** — and must be explicitly extended at E04/E05; a doc or claim that an account is "ready" without the tested loop violates D-025/D-028.

## 3. The import standard (D-022 — binding on every importer)

Grounded in what already works: the recovery pipeline (`import_jobs`/`import_messages` staging tables, review queue with ready/possible-dup/needs-a-look grouping, approve-with-undo, retention cron purging raw bodies, TCPA win-back gate) and the structured-CSV wizard from `_docs/GRADIA_CRM_FOUNDATION_SPEC.md`. Every importer MUST implement all six stages:

| Stage | Requirement | Existing foundation |
|---|---|---|
| **Staging** | Rows land in staging tables (`import_jobs` + child rows), never directly in live tables. Raw source files in the private `recovery-imports` bucket (or successor), size-capped, MIME-validated. | `import_jobs`/`import_messages`, 60MB cap |
| **Mapping** | Column/field mapping shown and editable before anything is parsed into candidates; per-source presets (Jobber export, HCP export, generic CSV, vCard). Unmapped required fields block progression with a named reason. | structured-CSV wizard (C7) |
| **Preview** | Candidate review queue: counts, dedupe verdicts (conservative 3-layer matcher), sample records, credit estimate before any LLM extraction. Nothing is written live from preview. | recovery review queue, "~N credits" estimate |
| **Validation** | Per-row validation (E.164 phone normalization — audit 05 notes DB does not normalize; email shape; date sanity; duplicate detection against live customers). Invalid rows are quarantined, not silently dropped. | `findOrCreateCustomer` normalization |
| **Error reporting** | Row-level error report, downloadable (CSV), with reason per rejected row. Import summary states imported / merged / skipped / failed counts — real counts, not estimates (D-025). | recovery error-report CSV |
| **Rollback** | A completed import is reversible **as a unit**: undo removes/unmerges what the import created (customers tagged `source=import` + import-job linkage). Merge-into-existing rows must record enough to unwind fills. Retention: raw bodies purged post-extraction (cron exists). | approve-with-undo, retention cron |

Additional binding rules:

- **No outbound side effects.** An import never stages or sends a message (FR-048). Imported contacts reach win-back audiences only through lifecycle + TCPA + consent gates.
- **Consent conservatism.** Imported contacts get NO implied marketing consent; `marketing_consent_at` stays null unless the source proves it. TCPA 18-month EBR gate applies to SMS win-back.
- **Tenant scoping.** Import routes run service-role today — every stage explicitly shop-scoped; covered by the P0-011 review.
- **Idempotent re-upload.** Re-uploading the same file must not duplicate candidates (content hash per import job).
- **Credits.** LLM extraction is estimated up front and fail-closed at the cap; structured (non-LLM) imports cost 0 credits (plumbing rule from the pricing doc).

## 4. Importers — current vs target

| Importer | Today (audit) | Target (phase) |
|---|---|---|
| mbox / contacts CSV / vCard (recovery) | OPERATIONAL code, flag **off**, never live-smoked end-to-end (GO_LIVE_CHECKLIST §NEXT-3) | Live-smoke then flag on (P0 acceptance run; founder action) |
| Structured CSV (customers/vehicles/jobs) | Built per CRM spec C7; real-export test outstanding | P3: real-export tests against actual Jobber/HCP export files |
| Jobber direct import | Not built (Jobber is push-only today, `jobber-push.ts`) | P3: pull import via existing OAuth + seam; maps to staging like CSV |
| Housecall Pro direct import | Not built; client endpoints carry `TODO(verify)` | P3: only after live-account verification (FR-068) |
| Calendar import (existing events → Gradia appointments) | Not built; Aurinko connect syncs forward only | P2/E02: import existing busy events during calendar connection so availability is correct from day one |
| Export (customers CSV) | NOT_FOUND | P3 (FR-016) |

## 5. What P3 / E03 must add (summary for the epic)

1. Wizard import step + resumable import center in Customers.
2. Mapping UI with per-source presets; validation + quarantine + downloadable error report.
3. Unit-undo for structured imports (recovery already has it; structured CSV must match).
4. Jobber pull-importer; HCP pull-importer behind live verification; calendar backfill import (with E02).
5. Trial wiring (D-005): allowance grant at signup, fail-closed metering, trial-to-paid conversion flow (`ui/flows/trial-to-paid.md`), events in `14-product-analytics.md`.
6. Import analytics: `Import started`, `Import completed` (with counts), first-customer/first-lead downstream events.

## 6. Failure cases that must be designed, not discovered

- Upload interrupted mid-file → job resumable or cleanly restartable; no half-staged candidates visible as real.
- Extraction/LLM outage mid-job → job pauses with progress preserved; no silent recipient/row drops (`.catch(() => null)` pattern is banned here).
- Credit cap hit mid-extraction → fail closed, job pausable/resumable after top-up; owner notified in-app.
- Duplicate-heavy file (customer re-imports their whole CRM twice) → dedupe verdicts + idempotent re-upload keep live data clean.
- Import into a shop with existing data → merge preview shows what fills vs what conflicts; conflicts default to keep-existing.
- Undo after downstream activity (imported customer already quoted) → undo blocks with a named reason for affected rows, removes the rest; partial-undo report generated.

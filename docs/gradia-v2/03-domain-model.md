# 03 — Domain Model

_Created 2026-07-25 by the Organizer; domain coverage extended 2026-07-27 (§12–§16). Current entities per audit doc 05 (28 tables, 54 migrations); target model per the decision log and epics E01–E07. Planning-level only — actual schema changes arrive as ticket-scoped migrations with their own specs. Migration notes here are implications, not designs._

## Reading this doc

Each domain lists **current** (what the schema does today, audited) → **target** (where it goes, with authority) → **migration implications** (planning level). Dual-truth defects flagged `⚠` come from audit 05 §Schema weaknesses and are consolidation work (mostly E03), not new modeling.

## 1. Organization & identity

**Current:** `shops` is the tenant root and a god-table (~60 cols: identity, plan/billing, feature state, seven vendors' credentials). `shops.owner_id → auth.users` is the entire access model — no members, roles, invitations, or locations (audit 04-L). RLS on all 28 tables keys on owner.

**Target (E01/P1, D-018):** `organizations` ← `members` (user, role: owner/manager/tech at minimum) ← `invitations`. RLS via membership indirection. `locations` and `resources` (bays, mobile units, techs-as-bookable-resources) modeled thin at E01, consumed by E02 availability and E04 assignments. Credentials split to `shop_connections` (audit 09 refactor direction).

**Migration implications:** every RLS policy is touched; `requireShop` → `requireMember(role)`; backfill = one owner-member row per shop. Highest-blast-radius change on the roadmap — hence P1, before new tables accrete (D-018).

## 2. Customers, companies & vehicles

**Current:** `customers` — unified identity spine, per-channel partial uniques (phone/email), consent ledger (`marketing_consent_at/_source`, `sms_opted_out_at`, `do_not_contact`), lifecycle + LTV columns (lifecycle never computed — unwired). `vehicles` — first-class (C1), size_class, condition CHECKs, coating/PPF/tint jsonb; no VIN/trim anywhere. ⚠ flat vehicle columns on customers/leads still writable alongside `vehicles`; ⚠ three "last activity" timestamps; ⚠ three lifecycle vocabularies; no direct "add customer" form (audit 04-A); no companies entity.

**Target (E03/P3):** direct create/edit/export; VIN + trim + per-vehicle service history view; single lifecycle vocabulary computed on a cron (fuel for win-back); **companies** as a light entity for B2B customers — required by fleets (E06), designed at E03 so fleets don't retrofit it. Retire flat columns and duplicate timestamps.

**Migration implications:** additive (VIN/trim/companies) + a deprecation pass (flat columns → views or drops after code stops writing).

## 3. Leads & pipeline

**Current:** `leads` with 6-stage `crm_stage`, stage_history, next_action timers, drag board; HITL creation paths. ⚠ legacy `status` enum still written alongside `stage` — dual truth, nothing reconciles (audit 09). ⚠ circular `quotes.lead_id` ↔ `leads.quote_id`.

**Target (E03):** single truth (`stage`); one direction of quote↔lead linkage; funnel analytics on stage_history (E08). Quote-accept defect (duplicate lead fork, `approvals.ts:747`) fixed earlier at P0-009.

## 4. Quotes & deposits

**Current:** `quotes` — jsonb line items, cents totals, unique `public_token`, public accept page. Defects: expiry display-only (`quote-response.ts:82`), status never passes `accepted`, accept→book forks a duplicate lead. No deposits, no discounts.

**Target:** P0-009 repairs acceptance/linkage/expiry on the current model. E05/P5 adds **deposits** via Stripe Connect (D-019): deposit requirement on quote, payment record on acceptance, immutable (D-024). Discounts modeled with deposits, not before.

## 5. Calendar, availability & appointments

**Current:** `appointments` (heavily grown: reminders, confirm, CRM mirror ids, C1 job fields) — but **Aurinko/Google is the de-facto source of truth**: booking hard-requires a connected calendar (`approvals.ts:686`) and no path checks conflicts (audit 04-D).

**Target (E02/P2, D-013..D-016):** `appointments` + availability engine (working hours, blocks, resources, buffers) become authoritative; external Google/Microsoft calendars are synchronized mirrors (sync-state columns, two-way reconcile behind a calendar-sync seam). Conflicts: hard-block on automatic paths, documented override on human approval. P0-003/004 add conflict enforcement against the current model first.

**Migration implications:** sync bookkeeping columns; busy-time cache or query; `aurinko_event_id` becomes mirror metadata, not identity.

## 6. Jobs & work orders

**Current:** jobs live *on* `appointments` (status machine booked→…→closed, photos, payment_status placeholder). Single-operator; no assignments or checklists (audit 03).

**Target (E04/P4, needs E01):** work-order layer — assignments (member/resource), checklists, materials notes, time tracking lite. Whether jobs stay appointment-rows or split into a `jobs` table is an E04 ADR — **amended 2026-07-27: this ADR is a prerequisite decision made *before* E04 ticket cutting, not a mid-epic choice** (the master-spec work-order surface — assignments, checklists, materials, time, profitability, warranty — bears directly on the split, and starting E04 tickets on appointment-rows would prejudge it). Planning assumption: split when assignments land.

## 7. Invoices & payments

**Current:** platform billing only (`payments` mirrors Gradia's own Stripe invoices; `usage_events` ledger). **No customer-facing invoicing** (Connect flagged off). ⚠ ledgers owner-writable via FOR ALL RLS (audit 05 §4, vs D-024).

**Target (E05/P5, D-019):** `invoices` + `invoice_payments` on Stripe Connect; immutable, replay-safe (provider-ref uniques), SELECT-only owner RLS (copy the `credit_grants` pattern). Ledger RLS tightening can ride earlier hardening work.

## 8. Recurring jobs, memberships, fleets — three separate domains (D-017)

**Current:** none exist. `maintenance_schedule` jsonb is armed on job completion and never consumed (audit 03).

**Target (E06/P6, after E02 + E05):**
- **Recurring jobs:** schedule template → generated future appointments against real availability.
- **Memberships:** plan entity + member subscription + entitlements/usage + Stripe recurring billing.
- **Fleets:** company accounts (E03 companies) + multi-vehicle rosters + batch visits + consolidated invoicing.
They share infrastructure (calendar, payments) but are modeled independently — no unified "repeat work" abstraction (D-017).

## 9. Communications

**Current:** `interactions` is the shared memory — every channel writes it, pgvector-embedded; `call_records` idempotent per call. Inbox is voice+SMS, read-mostly; no email in threads; no outbound email threading; ⚠ inbound events carry no provider-event uniqueness (`MessageSid`, `aurinko_message_id` — audit 04-F/G).

**Target:** P0-005/006/007 add provider-event idempotency (D-023). E07/P7 adds email to conversations, in-thread reply, threading, delivery tracking, template library. `interactions` remains the one spine — no per-channel silo tables. Note (2026-07-27): **connected-mailbox conversations, application-generated transactional email, and campaign email are related but distinct systems** — this domain models the first; the other two are provider-evaluation and agent-engine concerns respectively (see `vendors/planned-evaluations/transactional-email.md`, E07 §Integrations).

## 10. Imports & exports

**Current:** recovery import staging (`import_jobs`/`import_messages`, private bucket, retention cron, review/undo) — the pattern that already meets most of D-022. Structured CSV import exists (C7); no exports beyond an error CSV.

**Target (E03, D-022/D-006):** every import (CRM, calendar, CSV) goes staging → mapping → preview → validation → error report → rollback; customer/full-data export. **The E03 import wizard extends the existing `import_jobs`/`import_messages` staging substrate — a third parallel import pipeline is an architecture regression** (amended 2026-07-27). Imports must additionally be **resumable** (a failed run continues from staging, never restarts against production rows), **idempotent** (re-running a commit produces no duplicates), and **preserve source identifiers** (the originating system's record IDs stored on imported rows for traceability and re-import matching). Detail: `07-onboarding-and-imports.md`.

## 11. AI action & audit spine (stable — extend, don't reshape)

`pending_actions` (11-type enum, atomic claim) · `action_decisions` ("because" rows) · `custom_agents`/`custom_agent_runs` · `usage_events` (append-only meter) · `shop_knowledge`. Target: zod-typed payloads per action type, FK/CHECK tightening for the dangling pointers and free-text `resolution` (audit 05 §7/§9) — ride-along hardening, not remodeling. The approval engine's shape is a preserved invariant (D-011).

## 12. Services & pricing (added 2026-07-27)

**Current:** `services` (per-shop menu: name, price, duration, description — the "Business Brain" input) and `pricing_config` (platform credit/SKU pricing, changed via config never code). Vehicle-size pricing via `vehicles.size_class`.

**Target:** E03 keeps services first-class for the AI-off CRM path (D-002); E05 line items reference services; E06 fleet pricing overrides layer on top. Add-ons, condition adjustments, and per-size price rules extend `services` at E03/E05 — modeled as pricing rules on the service, not free text. Platform pricing (`pricing_config`) and shop service pricing remain separate concerns, never one table.

## 13. Automations (added 2026-07-27)

**Current (code-verified):** `automations` + `automation_runs` — an owner-configured catalog (`automations.ts`); each automation fires in `approval` or `autopilot` mode. **Boundary with the approval engine (verified in `automations.ts`): every automation stages its side effect as a `pending_actions` row; autopilot is auto-*execution* of the staged action via the same `executeApproval` executor — never a second execution path.** Fail-closed: credit shortfall or a disallowed autopilot degrades to waiting in `/approvals`. ⚠ `(automation_id, trigger_ref)` dedupe is code-side only, race-prone — unique index rides P0-005 (see `08` §3).

**Target:** the boundary above is a preserved invariant (D-011): new automations extend the catalog and stage through `pending_actions`; nothing routes around the executor. E01 membership brings per-role visibility of automation controls.

## 14. Integrations & provider connections (added 2026-07-27)

**Current:** provider credentials and sync state live as columns on the `shops` god-table (seven vendors' credentials, `*_enc` blobs visible to owner sessions — audit 05/09).

**Target (E01 direction, D-029/D-030):** a `shop_connections` structure with per-integration rows: provider id, **encrypted credentials** (AES-256-GCM pattern), **provider account identifiers**, **synchronization state and cursors** (e.g. calendar sync tokens, mailbox cursors), **health state** (connected/degraded/expired), **last success / last failure timestamps** — the fields ConnectionTiles and reconnect alerts read. Provider event payloads/IDs stay in adapter-owned records (D-029); core entities never key on them. Split executes as E01 touches `shops` (02 §refactor directions).

## 15. Knowledge (added 2026-07-27)

**Current:** `shop_knowledge` (owner-curated facts feeding voice + drafters), `interactions` pgvector embeddings, KB shared by both engines (one-brain rule).

**Target:** stable — extend, don't reshape. E09 adds memory correction (edit/forget with tombstones + re-embed). Embedding vendor/dimension migration is P10 (see 02 §AI gateway exclusions).

## 16. Reporting (added 2026-07-27)

**Current:** `shop_metrics` snapshots + `home-analytics.ts` (row-traced figures, the receipt discipline); no report entities.

**Target (E08):** funnel/campaign analytics computed from `stage_history`, `custom_agent_runs`, `payments` — **one shared computation layer extending the `home-analytics` pattern; parallel math is a regression.** Report snapshots/exports are derived artifacts, never writable truth. Job-dependent reports (profitability, productivity, utilization) wait on E04 (roadmap rule 8).

## Cross-cutting rule: provider identifiers are mirrors, never identity (D-029)

Provider identifiers — `aurinko_event_id`, Stripe refs, Twilio SIDs, Vapi call ids, Jobber/HCP mirror ids — are sync/mirror fields per D-029/ADR-002, never the identity of a domain entity. Core entities are keyed by Gradia-owned UUIDs; provider state lives in integration records and adapters wherever practical.

## Cross-cutting schema debts (tracked once, here)

From audit 05, in priority order: service-role scoping mechanism (P0-011 → E01) · cascade-delete of ledgers + no soft-delete (P10) · owner-writable ledgers (D-024) · missing idempotency uniques (P0-005/006/007) · jsonb-without-schema load-bearing fields · `updated_at` has no trigger · phone normalization assumed, not enforced · hand-written types → codegen (E03).

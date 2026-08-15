# 04 — Capability Map

_Created 2026-07-25 by the Organizer. The machine-readable product map: 28 capabilities, each graded against the 2026-07-20 audit (`platform/docs/audit/`, docs 03/04/11), the decision log (`11-decision-log.md`), and the roadmap (`10-roadmap.md`)._

## How to read this file

Each capability records:

- **Current audit status** — what the audit actually found (OPERATIONAL / PARTIAL / NOT_FOUND / BROKEN, with caveats). Layer-1 truth.
- **Existing foundation** — real modules/tables to build on, not rebuild.
- **Target state** — where the roadmap takes it.
- **Missing work** — the delta.
- **Dependencies** — capabilities, decisions (D-###), tickets (P0-###).
- **Priority phase** — P0–P10.
- **Risks** — what goes wrong if built badly or skipped.
- **Feature flag** — existing `features.ts` flag, the flag new work must introduce, or "none — always on".
- **Acceptance evidence required** — the proof that marks it done. A table or page existing is NEVER acceptance evidence (D-025 discipline).
- **Status** — exactly one of: **not planned · planned · designed · building · internal · pilot · public · deprecated.**
  - *planned* = on the roadmap, no design yet · *designed* = spec/epic exists · *building* = in active implementation · *internal* = works, not exposed/claimable to customers · *pilot* = usable by alpha/pilot shops · *public* = generally claimable. Nothing is *public* before the 2026-08-07 alpha ships and its claim is cleared in `WHAT_GRADIA_DOES.md`.

---

## 1. Platform foundation

- **Current audit status:** OPERATIONAL core (auth SSR+PKCE, feature flags, 8 authenticated crons, 54 idempotent migrations, Sentry) with PARTIAL edges: no queue/retry/dead-letter, no health endpoint, no structured logger, CI runs tests only (audit 03 §Infrastructure, §Testing).
- **Existing foundation:** `proxy.ts`, `shop.ts`, `features.ts`, `env.ts`, `crypto.ts`, `rate-limit.ts`, `monitoring.ts`, Vercel crons, Supabase Auth/Postgres/Storage.
- **Target state:** CI that can stop a broken build (typecheck/lint/build/integration), alert delivery that pages a human, health endpoint, structured logging; later outbox/queue.
- **Missing work:** P0-002 (CI), P0-010 (env/error surfaces), P0-012 (alerts); P10 queue/logging/tracing.
- **Dependencies:** none (this unblocks everything else).
- **Priority phase:** P0 (hardening), P10 (scale).
- **Risks:** main = production with CI that cannot fail; silent-degradation culture means failures go unnoticed (audit 09).
- **Feature flag:** none — always on.
- **Acceptance evidence:** a deliberate type error fails CI; a simulated cron failure produces a delivered alert; `/api/health` returns real dependency checks.
- **Status:** **pilot**

## 2. Organizations

- **Current audit status:** OPERATIONAL as single-owner shops; multi-shop per owner via cookie switcher; `shops` is a ~60-column god-table holding seven vendors' credentials (audit 03, 05).
- **Existing foundation:** `shops` table + RLS on `owner_id`, `requireShop()`, onboarding wizard (`saveShop`), zero-founder-touch shop creation (audit 04-K).
- **Target state:** organization as a first-class entity separable from the owner login; credentials split out (`shop_connections` direction); org settings survive the members model.
- **Missing work:** god-table split; org-level settings audit; rename shop→organization only if product requires.
- **Dependencies:** capability 3 (members) lands first or together; P0-011 (service-role scoping) reduces risk of the split.
- **Priority phase:** P1.
- **Risks:** every module reads shop rows — the split is wide; cascade-delete `auth.users → shops → everything` destroys ledgers (audit 05 §2).
- **Feature flag:** none — structural.
- **Acceptance evidence:** credentials no longer readable via owner-session `SELECT *` on shops; migration tests prove no data loss; all 430+ tests green.
- **Status:** **pilot**

## 3. Members, roles and permissions

- **Current audit status:** NOT_FOUND — no members table, no roles, no invitations; one owner login per shop (audit 03, 04-L).
- **Existing foundation:** resolution telemetry already records who decided; RLS pattern is uniform (easy to re-point at membership); Supabase Auth supports multiple users.
- **Target state:** `members` + role column + policy indirection (`shop_id IN (select via membership)`); invitation flow; permission checks in `requireShop`-successor; role-aware approvals and audit trail. Added 2026-07-27: staff profiles (name/photo/skills for assignment surfaces) join the E01 target.
- **Missing work:** everything — schema, RLS rewrite across all 28+ tables, invitation UX, role gates on actions/pages.
- **Dependencies:** D-018 (must precede major schema expansion); P0-002 (CI) and P0-011 (scoping helper) first; blocks capabilities 4, 10 (team), 26.
- **Priority phase:** P1.
- **Risks:** highest-blast-radius change in the codebase (touches every policy — audit 09 §rewrite risks #1); doing it late multiplies cost.
- **Feature flag:** `multiUser` (new).
- **Acceptance evidence:** tenant-isolation tests: invited member sees only their org; role-restricted action rejected at server and UI; owner-only surfaces enforced; RLS test suite added and green.
- **Status:** **planned**

## 4. Locations and resources

- **Current audit status:** NOT_FOUND — single implicit location; only `location_type/address/travel_fee` on jobs, `mobile_eligible` on services (audit 03).
- **Existing foundation:** job-level address fields; working-hours/capacity math (`working-hours.ts`).
- **Target state:** locations (bays, mobile units) and bookable resources feeding availability (capability 9) and team scheduling (capability 10).
- **Missing work:** domain model, schema, availability integration, UI.
- **Dependencies:** capability 3 (roles), capability 9 (availability engine); D-018 sequencing.
- **Priority phase:** P4.
- **Risks:** premature modeling before real multi-location demand; keep single-location default zero-config.
- **Feature flag:** `locations` (new).
- **Acceptance evidence:** two resources can hold overlapping appointments without conflict flags; single-location shops see no new required setup.
- **Status:** **planned**

## 5. Customers and companies

- **Current audit status:** Customers OPERATIONAL — identity spine, merge, consent ledger, timeline; but **no direct "Add customer" form** (implicit creation only), no export, `tags` column with no UI (audit 03, 04-A). Companies (B2B orgs): NOT_FOUND.
- **Existing foundation:** `customers.ts` find-or-create, channel partial-uniques, dedupe (3 layers), `customer-context.ts`, DNC/consent enforcement.
- **Target state:** direct create/edit/export; tag system; preference surfaces; `companies` entity for B2B (feeds fleets, capability 14). Added 2026-07-27 (founder master definition parity): custom fields and a communication-preference center (consent + channel preferences in one surface) join the E03 target.
- **Missing work:** create form + server action, CSV export, tags UI, companies domain; retire flat vehicle columns (single-truth pass).
- **Dependencies:** decision queue Q-03 (direct create deliberate-or-omission — recommend build); companies blocked on capability 3 per D-018.
- **Priority phase:** P3 (companies with P6 fleets).
- **Risks:** orphan-lead edge (`quickCreateLead` proceeds with `customer_id: null` — audit 04-A); dedupe assumptions if direct create bypasses `findOrCreateCustomer`.
- **Feature flag:** none for CRM basics (D-002 — must work without AI); `companies` (new).
- **Acceptance evidence:** create→edit→export round-trip on a seeded shop; export CSV re-imports cleanly through the import wizard; dedupe tests still green.
- **Status:** **pilot** (customers) / companies: **planned**

## 6. Vehicles and service history

- **Current audit status:** Vehicles OPERATIONAL (C1 table, dedupe, size-class) but **no VIN anywhere**, no trim, regex text-parse entry only, no standalone edit UI; service history PARTIAL (derivable, no per-vehicle view); condition columns exist with no UI (audit 03, 04-B).
- **Existing foundation:** `vehicles` table (coating/PPF/tint jsonb, condition CHECKs, photos[]), `vehicle.ts` parser, `maintenance_schedule` armed on job completion.
- **Target state:** VIN/trim fields, structured entry + edit UI, per-vehicle service-history view, condition capture; history feeds Opportunity Engine (19) and recurring jobs (12).
- **Missing work:** schema additions (VIN, trim), edit surface, history view, cross-tenant guard on `addCustomerVehicleFromText` (audit 04-B tenant nit).
- **Dependencies:** capability 5; single-truth pass (flat columns retired).
- **Priority phase:** P3.
- **Risks:** dual-truth flat columns diverge until retired (audit 05 §3).
- **Feature flag:** none — always on.
- **Acceptance evidence:** vehicle with VIN survives import→edit→quote→job round-trip; per-vehicle history view shows real appointment/interaction rows; tenant-guard test added.
- **Status:** **pilot** (with gaps)

## 7. Leads and pipeline

- **Current audit status:** OPERATIONAL — 6-stage `crm_stage` board, code-only moves, stage history, next-action timers, quick-create, HITL intake. Caveat: legacy `status` enum still live alongside `stage` (dual truth); pre-approval work nearly invisible on the board (audit 03, 04-E).
- **Existing foundation:** `leads` table, `pipeline.ts`, timers via 5-min cron, drag board, `source` column.
- **Target state:** single source of truth (`stage`), funnel analytics, source attribution surfaced.
- **Missing work:** retire `status` enum (migration + code pass); funnel reporting (capability 17).
- **Dependencies:** P0-002 (CI) before the retirement migration; P0-009 fixes the quote-accept lead fork that pollutes the pipeline.
- **Priority phase:** P3 (single-truth), P8 (analytics).
- **Risks:** divergence between the two enums is silent — nothing reconciles them (audit 09).
- **Feature flag:** none — always on.
- **Acceptance evidence:** grep shows zero `leads.status` readers; migration test proves stage backfill; board counts match SQL counts on seeded data.
- **Status:** **pilot**

## 8. Quotes and deposits

- **Current audit status:** Quotes OPERATIONAL with real defects: accept→book forks a duplicate lead, status never passes `accepted`, **expired quotes still acceptable server-side (BROKEN)**, spoofable public-URL base when env unset (audit 03, 04-C). Deposits: NOT_FOUND (Stripe Connect flag off). Discounts: NOT_FOUND.
- **Existing foundation:** `quotes` table + pure pricing (`quotes.ts`, `service-pricing.ts` shared with voice/drafts), public `/q/[token]` accept page, day-2/5/12 follow-up sweeps.
- **Target state:** defect-free quote lifecycle (P0-009); then deposits via Stripe Connect (D-019) with immutable payment records (D-024); quote expiry UX per decision Q-04. Added 2026-07-27 (founder master definition parity): quote versions, lost reasons, taxes & fees, discounts (P3/P5), and customer signature where needed (P5) join the target state.
- **Missing work:** P0-009 (lead linkage, status closure, expiry enforcement, token hardening per audit L-3); E05 deposit flow (`ui/flows/quote-to-deposit.md`).
- **Dependencies:** deposits ⇐ capability 11 + D-019; expiry UX ⇐ decision queue Q-04.
- **Priority phase:** P0 (fixes), P5 (deposits).
- **Risks:** money-path correctness — a customer can accept a stale price today; duplicate pipeline cards erode trust in the board.
- **Feature flag:** deposits behind `payments` (existing flag, currently false).
- **Acceptance evidence:** replaying an accept on an expired quote is rejected server-side with a designed page; accepting a quote advances the ORIGINAL lead to booked (no duplicate row, integration-tested); deposit collected in Stripe test mode with immutable `payments` row.
- **Status:** **pilot** (quotes) / deposits: **planned**

## 9. Calendar and availability

- **Current audit status:** Calendar OPERATIONAL (week view, Aurinko CRUD, working hours, block time, reschedule). Availability/conflict checking: **NOT_FOUND on every booking path** — voice, quote accept, drag, block-time; booking **hard-requires Aurinko** (audit 03, 04-D — top operational risk).
- **Existing foundation:** `appointments` table with times, `working-hours.ts` capacity math, `listCalendarEvents` written but unused, reminder + no-show ladder crons.
- **Target state:** Gradia DB is the appointment source of truth (D-013); central conflict service consulted by every path (P0-003/004): hard-block automation (D-015), warn-and-override HITL (D-016); Google AND Microsoft as synchronized mirrors (D-014); booking works with no external calendar.
- **Missing work:** P0-003 (conflict service), P0-004 (enforcement across paths); E02: native availability model, bidirectional sync, Microsoft support, dependency softening.
- **Dependencies:** none for P0 tickets; E02 after P1 per WIP limits (calendar = high-risk class).
- **Priority phase:** P0 (conflicts), P2 (native calendar).
- **Risks:** double-booking inverts the core product promise (audit 00); sync conflicts once two writers exist — the source-of-truth rule (D-013) must be enforced in code, not convention.
- **Feature flag:** `nativeCalendar` (new, for E02); conflict checks always on.
- **Provider posture (2026-07-27):** Aurinko is **transitional** behind `CalendarProvider` (D-029/D-030) — core calendar records never depend on Aurinko-specific identifiers; direct Google/Microsoft integrations are a post-E02 evaluation (Q-21, `vendors/planned-evaluations/`).
- **Acceptance evidence:** locked test — two overlapping bookings cannot both confirm without a recorded override; voice booking into a busy slot offers alternatives; a shop with no Google account completes a booking end-to-end (E02).
- **Status:** **building** (conflicts P0) / native calendar: **designed**

## 10. Jobs and work orders

- **Current audit status:** OPERATIONAL single-operator — status machine (booked→…→closed), before/after photos (private bucket, signed URLs), 48h close sweep, timeline. Assignments/checklists/team scheduling: NOT_FOUND (audit 03).
- **Existing foundation:** `appointments` as job object (C1 fields), `jobs.ts`, job-photos bucket, maintenance-schedule arming on completion.
- **Target state:** work orders with assignments, checklists, and per-member schedules for 2–5-person shops.
- **Missing work:** E04 — assignment model, checklist templates, team calendar views, mobile job flow (`ui/flows/job-completion.md`).
- **Dependencies:** capability 3 (members/roles) — hard prerequisite; capability 9 (availability) for per-member scheduling; MIME validation on photo upload (audit 06 nit) rides with P0-010 follow-ups.
- **Priority phase:** P4.
- **Risks:** building team features on the single-owner model wastes the work (D-018 exists to prevent this).
- **Feature flag:** `teamOps` (new).
- **Acceptance evidence:** a job assigned to member B is invisible to member C where role dictates; checklist completion recorded per member; job close still fires maintenance-schedule arming.
- **Status:** **pilot** (single-op) / work orders for teams: **planned**

## 11. Invoices and payments

- **Current audit status:** NOT_FOUND for customer-facing payments — Stripe **Connect** flow exists but flag-gated off; no invoices, no deposits, no discounts. (Platform's own subscription billing is separate — capability 23.) `payments` table today is a mirror of the shop's Gradia invoices, RLS FOR ALL (owner-writable — audit 05 §4).
- **Existing foundation:** dormant Stripe Connect code, `payments` mirror table, `pricing_config`, immutability patterns proven in `credit_grants`.
- **Target state:** Stripe Connect first (D-019): deposits on quotes, invoices on jobs, refund records; financial events immutable and replay-safe (D-024); always-HITL money actions (D-021).
- **Missing work:** E05 — invoice domain, Connect onboarding flow, webhooks (idempotent per D-023), ledger RLS tightened to SELECT-only, receipt surfaces.
- **Dependencies:** capability 3 (roles decide who can invoice); P0-005 (webhook idempotency foundation); D-019/D-024; WIP rule: payments = high-risk class.
- **Priority phase:** P5.
- **Risks:** double-billing (runbook exists: `runbooks/double-billing.md`); owner-writable ledgers; Connect account states (restricted/pending) leaking as broken UX.
- **Feature flag:** `payments` (existing, off).
- **Acceptance evidence:** replaying every Stripe webhook twice produces zero duplicate financial rows (idempotency replay tests); an owner session cannot mutate a `payments` row (RLS test); test-mode deposit and invoice collected end-to-end.
- **Status:** **planned**

## 12. Recurring jobs

- **Current audit status:** PARTIAL — `maintenance_schedule` armed on job completion but **consumed by nothing**; no recurring booking (audit 03).
- **Existing foundation:** maintenance schedules on vehicles, reminder cron machinery, automation catalog.
- **Target state:** first-class recurring-job domain (D-017 — separate from memberships/fleets): cadence, next-occurrence generation against native availability, reminder + rebook flow.
- **Missing work:** E06 — recurrence model, generation job, owner UI (`ui/flows/recurring-job-setup.md`), conflict-aware scheduling.
- **Dependencies:** capability 9 (P2 availability) hard; capability 11 for auto-billing variants; D-015/D-016 for how generated bookings confirm.
- **Priority phase:** P6.
- **Risks:** silent generation drift (missed occurrences with no catch-up — same failure class as weekly crons, audit 02).
- **Feature flag:** `recurringJobs` (new).
- **Acceptance evidence:** a 6-week cadence generates the right next dates across DST; a conflicting occurrence is rescheduled per D-015/D-016 rules; missed-generation catch-up test.
- **Status:** **planned**

## 13. Memberships

- **Current audit status:** NOT_FOUND (audit 03 — no promotions/memberships entity anywhere).
- **Existing foundation:** Stripe subscription machinery (platform-side) as a pattern; credit-ledger discipline.
- **Target state:** shop-sold membership plans (e.g. monthly wash club): enrollment, entitlements, billing via Connect, usage tracking (D-017 — its own domain).
- **Missing work:** E06 — membership model, Connect recurring billing, enrollment flow (`ui/flows/membership-enrollment.md`), entitlement checks at booking.
- **Dependencies:** capability 11 (P5) hard; capability 12 shares scheduling pieces but stays a separate domain.
- **Priority phase:** P6.
- **Risks:** proration/cancellation edge cases; membership revenue must land in immutable ledgers (D-024).
- **Feature flag:** `memberships` (new).
- **Acceptance evidence:** enroll→bill→use→cancel lifecycle in Stripe test mode; entitlement correctly gates a discounted booking; failed-payment dunning path tested.
- **Status:** **planned**

## 14. Fleet accounts and service

- **Current audit status:** NOT_FOUND.
- **Existing foundation:** vehicles-per-customer model generalizes; companies entity (capability 5) is the anchor.
- **Target state:** fleet accounts (company + vehicle roster + billing terms), scheduled fleet visits, per-visit work orders, consolidated invoicing (D-017 — separate domain).
- **Missing work:** E06 — company/fleet model, visit planner (`ui/flows/fleet-visit.md`), invoice rollup.
- **Dependencies:** capabilities 5 (companies), 10 (work orders), 11 (invoicing); P4+P5 complete.
- **Priority phase:** P6.
- **Risks:** B2B terms (net-30) stress the payments model; fleet double-books mobile resources without capability 4.
- **Feature flag:** `fleets` (new).
- **Acceptance evidence:** a 10-vehicle fleet visit books, executes, and invoices as one consolidated flow on seeded data.
- **Status:** **planned**

## 15. Communications

- **Current audit status:** SMS in/out OPERATIONAL (one send path, policy at boundary) but **no inbound idempotency** and **delivery status BROKEN for Gradia-provisioned numbers** (status route resolves wrong creds). Email OPERATIONAL-with-pilot-caveats: no outbound threading, classifier failure polarity inverted, no idempotency. Unified inbox PARTIAL: voice+SMS only, **no reply composer**. Operator quick-reply skips send-policy (audit 03, 04-F/G).
- **Existing foundation:** `interactions` shared memory, signature-verified webhooks (all four), consent ledger + STOP/START, A2P pipeline, templates via automation overrides.
- **Target state:** P0: idempotent inbound (P0-005/006), status-callback fix (P0-008). P7: email in Conversations, in-thread reply composer, outbound threading, delivery tracking, template library; operator-send policy decision (Q-05).
- **Missing work:** as above + email consent/quiet-hours model.
- **Dependencies:** P0-005 foundation precedes P0-006/007; Q-05 (operator STOP behavior).
- **Priority phase:** P0 (integrity), P7 (parity).
- **Risks:** duplicate messaging under normal provider retries (runbook exists); TCPA-adjacent operator-send gap; email outage turning newsletters into approval-card floods.
- **Feature flag:** none for fixes; `emailInbox` (new) for P7 surfaces.
- **Acceptance evidence:** replaying a captured Twilio/Aurinko webhook produces exactly one interaction/card (replay tests); delivery status recorded for a subaccount-signed callback (fixture test); an email reply lands in the original thread (live smoke).
- **Status:** **pilot** (SMS/voice) / email parity: **planned**

## 16. Imports and exports

- **Current audit status:** Recovery import OPERATIONAL in code (mbox/CSV/vCard/structured-CSV → LLM extract → dedupe → review → approve with undo → TCPA gating) but **flag OFF and never run end-to-end live** (GO_LIVE_CHECKLIST §NEXT-3). Customer export NOT_FOUND (audit 03).
- **Existing foundation:** `src/lib/recovery/*` (2,440 lines), `import_jobs`/`import_messages` staging, retention cron, storage bucket.
- **Target state:** D-022 fully honored for CRM/calendar imports: staging, mapping, preview, validation, error reporting, rollback; real-data import during trial (D-006); exports for customers/jobs/quotes.
- **Missing work:** live end-to-end smoke (go-live §4 NEXT-3); structured CRM import wizard completion (`ui/flows/crm-import.md`); calendar import; CSV exports; rollback beyond approve-undo.
- **Dependencies:** D-006/D-022; capability 9 for calendar import mapping.
- **Priority phase:** P3.
- **Risks:** import is the first-run trust moment — a bad import loses the trial (D-006 rationale); PII retention in the bucket if aborted (runbook: broken-import).
- **Feature flag:** `customerRecovery` (existing, off) + `structuredImport` (new).
- **Acceptance evidence:** a real Jobber/HCP export imports with preview counts matching landed rows, an intentionally corrupt file produces a per-row error report, and rollback removes every landed row (integration-tested); retention purge verified.
- **Status:** **internal**

## 17. Reporting

- **Current audit status:** Home analytics OPERATIONAL on the WIP branch (exemplary discipline — figures traced to rows, no fabricated deltas); revenue reporting OPERATIONAL; funnel/campaign analytics NOT_FOUND; daily brief NOT_FOUND (weekly ROI receipt exists) (audit 03).
- **Existing foundation:** `home-analytics.ts`, `payments` mirror, ROI-receipt cron machinery, `shop_metrics`.
- **Target state:** funnel analytics, campaign analytics (with capability 18), daily brief, exportable reports — all inheriting the receipt's sacred rule (every figure traces to a real row).
- **Missing work:** funnel model over stage_history; daily-brief cron + card; report exports; finish home-redesign Phase 5 verify.
- **Dependencies:** capability 7 single-truth pass (funnels need one stage vocabulary); merge of home-redesign branch.
- **Priority phase:** P8 (daily brief may pull into P9 with Opportunity Engine).
- **Risks:** fabricated deltas/thin-data percentages violate the design system and D-025.
- **Feature flag:** none — always on.
- **Acceptance evidence:** every report figure spot-checks to underlying rows on seeded data; delta chips refuse to render without prior-period rows (existing locked pattern extended).
- **Status:** **building**

## 18. Gradia Agent

- **Current audit status:** OPERATIONAL — the strongest workflow in the product (audit 04-I): owner-agent loop (Sonnet, max 8 turns, no send tool by design), planner→deterministic runtime, freeform outreach with caps/cooldowns/consent, 4-layer audit trail, Whisper routing through the same engine. Caveats: `stageSingle` paths skip the decision log; `.catch(() => null)` silently drops recipients; no LLM seam/retries on most calls (audit 07).
- **Existing foundation:** `owner-agent.ts`, `agent-planner.ts`, `agent-runtime.ts`, `pending_actions` + one executor, `custom_agent_runs`, dry-run previews, AgentHomeBar (branch).
- **Target state:** same architecture (D-009/D-010/D-011), operationally hardened: LLM seam + retries/timeouts, decision-log completeness, campaign object + analytics, prompt-injection hardening.
- **Missing work:** P1 LLM seam; decision-log gap closure; P9 injection hardening + campaign analytics.
- **Dependencies:** D-009..D-012; eval gating (capability 25 / P0-002 scope decision Q-06).
- **Priority phase:** P1 (seam), P9 (differentiation).
- **Risks:** a drafter prompt regression ships on green CI today (live evals ungated — audit 07 weakness #1).
- **Feature flag:** `freeformPlanner`, `agenticMode` (existing, on).
- **Acceptance evidence:** simulated 429 retries instead of dropping a recipient (test); every staged card has a "because" row; injection eval suite green.
- **Status:** **pilot**

## 19. Opportunity Engine

- **Current audit status:** PARTIAL — whisper-suggestion sweep + revival candidates exist; **lifecycle derivation (at_risk/lapsed) deliberately unwired** so win-back has no fuel; maintenance schedules armed but unconsumed (audit 03, 11).
- **Existing foundation:** `lifecycle.ts` (finished, awaiting founder threshold sign-off Q-02), TCPA-gated win-back eligibility, whisper suggestion queue, decision-log explanations, trust telemetry.
- **Target state:** one ranked "money on the table" surface on Home unifying revival candidates, maintenance-due, stale quotes, at-risk customers — each with a traceable "because". Added 2026-07-27: every surfaced opportunity also carries an estimated value **only when responsibly calculable from real rows** (D-025), its approval requirement (what happens on "act"), and result tracking (what came of it).
- **Missing work:** wire `lifecycle.ts` to a cron (after Q-02 sign-off); unify the sweeps; ranked surface + actions.
- **Dependencies:** decision Q-02 (thresholds) — founder; capability 17/18; D-025 (no fabricated opportunities).
- **Priority phase:** P9 (lifecycle wiring itself is small and can ride earlier once Q-02 resolves).
- **Risks:** an "opportunity" that isn't traceable to rows destroys the trust story.
- **Feature flag:** `opportunityEngine` (new).
- **Acceptance evidence:** every surfaced opportunity deep-links to the rows that justify it; win-back audience is non-empty on seeded lapsed data; TCPA gate test still green.
- **Status:** **designed**

## 20. Voice receptionist

- **Current audit status:** OPERATIONAL in code / CANNOT_VERIFY live (audit 03, 04-H): self-serve builder, synthesized prompt, 8 HITL tools, transcripts to shared memory, budget fail-closed. Known defects (as audited): end-of-call report not idempotent (**double-meters minutes on retry**) — **closed 2026-08-14 by P0-007 (PR #21)**; `VAPI_DEFAULT_SHOP_ID` footgun — **code-side prod guard closed by P0-007** (fails closed for unmatched assistants; operational env verification stays P0-010); A2P TrustHub SIDs unverified live; subaccount status-callback bug (SMS side, P0-008). New recorded follow-up: synchronous tool-call/function-call events are not replay-deduped (backlog Band 2).
- **Existing foundation:** `vapi.ts`/`voice-provider.ts` seam, `vapi-prompt.ts`, `call_records` idempotent upsert, per-call glass-box view, voice-sync cron.
- **Target state:** replay-safe metering (P0-007 — **done 2026-08-14**), verified A2P + live acceptance run, then claimable per WHAT_GRADIA_DOES; later post-call quote verifier (P9).
- **Missing work:** P0-008 (P0-006 done 2026-08-14, P0-007 done 2026-08-14); founder live-acceptance run (FOUNDER_OPS_RUNBOOK); voice quote verifier; tool-call replay dedupe follow-up.
- **Dependencies:** P0-005 foundation; founder actions (accounts).
- **Priority phase:** P0 (integrity), P9 (verifier).
- **Risks:** double-billed minutes = customer-visible billing error; marketing before acceptance run violates claims discipline (D-028).
- **Feature flag:** Package-2 entitlement gates it per shop.
- **Acceptance evidence:** replayed end-of-call webhook meters exactly once (replay test); the 10-minute telephony acceptance run passes live; WHAT_GRADIA_DOES claim flipped by the founder.
- **Status:** **internal** (until the live acceptance run passes)

## 21. Earned autonomy

- **Current audit status:** OPERATIONAL core — `trust.ts` resolution telemetry, evidence-based autonomy recommendations, Package-2 gating, ALWAYS_HITL floor locked by tests; graduation UX PARTIAL (recommendations computed, thinly surfaced) (audit 03, 07).
- **Existing foundation:** `autonomy.ts`, `trust.ts`, `send-policy.ts`, resolution telemetry, per-agent mode controls, `<AgentAction mode=…>` design model.
- **Target state:** visible graduation flows (offer → accept/decline → auditable mode change), per-automation trust display; floor never moves (D-012, D-021).
- **Missing work:** graduation UX (P9 item 22 in audit 12); mode-change audit surface.
- **Dependencies:** D-012/D-021; capability 18.
- **Priority phase:** P9.
- **Risks:** weakening the floor via UX shortcuts — locked tests must extend, never relax.
- **Feature flag:** Package-2 entitlement (existing).
- **Acceptance evidence:** autonomy floor tests remain green; a graduation offer renders only with real resolution-telemetry evidence; mode changes appear in the audit trail.
- **Status:** **internal**

## 22. Integrations

- **Current audit status:** Twilio/Aurinko/Vapi/Stripe clients real, encrypted, signature-verified, reconciled (OPERATIONAL). Jobber push OPERATIONAL one-way. **Housecall Pro endpoint shapes admittedly unverified** (`TODO(verify)`). No Microsoft calendar. Token refresh exists; no owner-facing reconnect alerts (audit 03, 10).
- **Existing foundation:** provider seams (`voice-provider.ts`, `telephony-provider.ts`, `crm-provider.ts`), OAuth flows with CSRF protection, AES-256-GCM credential storage, ConnectionTile UX.
- **Target state:** all connectors verified live; Microsoft calendar (D-014); reconnect alerts; missing **LLM seam** added (the one unseamed vendor class).
- **Missing work:** HCP live verification (founder-adjacent); LLM seam (P1); Microsoft sync (P2/E02); reconnect alerting.
- **Provider classification (D-030, 2026-07-27):** core = Supabase/Vercel/Stripe/Twilio/Sentry; strategic-replaceable = Anthropic/OpenAI/Vapi (behind the D-029 boundaries); transitional = Aurinko; **Jobber = optional** (customer-demand driven, never a core dependency — Q-20); **Housecall Pro = quarantined** (unmarketed, flag disabled, no new investment; import-only-vs-removal review = P3-001, Q-19). Full facts: `vendors/registry.md`.
- **Dependencies:** vendors/* docs; P0-012 (alert delivery) for reconnect alerts.
- **Priority phase:** P1–P3.
- **Risks:** two integrations could fail on first real use (audit 10); provider drift with no contract tests.
- **Feature flag:** per-integration connection state (existing pattern).
- **Acceptance evidence:** provider contract tests per connector; HCP verified against a live account (TODO(verify) markers removed with evidence); a revoked token produces an owner-visible reconnect prompt.
- **Status:** **pilot** (Twilio/Aurinko/Vapi/Stripe/Jobber) / HCP + Microsoft: **internal / planned**

## 23. Trial and subscription billing

- **Current audit status:** Subscription billing OPERATIONAL — $20 Core + $29 voice add-on, Stripe checkout + webhook lifecycle, ledger-derived credits, fail-closed gates, rollover grants, margin report, nightly reconciliation (audit 00). Gaps: no idempotency key on `usage_events` (double-meter risk — P0-005/007), approval-time send skips cap re-check; 5 Stripe env vars undocumented. **Trial per D-005: not built** (today `free` = explore-only).
- **Existing foundation:** `stripe.ts`, `credits.ts`, `entitlements.ts`, `pricing.ts`, `margin-report.ts`, `reconciliation.ts`, `pricing_config`.
- **Target state:** full operational trial with controlled variable-cost allowances (D-005, starting at activation per D-032), fail-closed; full public pricing (D-004); no founding discounts (D-003); tier re-base per D-031/Q-22 (C-14).
- **Missing work:** trial entitlement model + allowances (needs Q-13 numbers); env documentation (P0-010); metering idempotency (P0-005/007); ledger RLS tightening.
- **Dependencies:** decision Q-13 (trial allowances); D-003/004/005; `15-cost-and-margin-model.md` margin floors.
- **Priority phase:** P0 (integrity) / P1 (trial model).
- **Risks:** trial cost blowout without allowances; double-metering is a billing-trust killer.
- **Feature flag:** `paywall` (existing); trial variant rides the plan state machine.
- **Acceptance evidence:** trial shop hits its allowance and fails closed with the designed message; margin report shows trial COGS within the Q-13 cap; replay tests on all metering paths.
- **Status:** **pilot** (billing) / trial model: **planned**

## 24. Security and privacy

- **Current audit status:** Architecture strong (uniform RLS, signature-verified webhooks, encrypted credentials, CSRF-protected OAuth, no text-to-SQL) but **score capped at 4/10 by C-1: live DB superuser credential committed to pushed git history**. C-2 cross-tenant Slack approval path (dormant). Service-role tenant scoping = pure discipline across ~30 files. No data deletion/export flow; EIN plaintext; MIME validation missing (audit 06, 10).
- **Existing foundation:** RLS on all 28 tables, `crypto.ts` AES-256-GCM, webhook forgery test suite, rate limiting, consent ledger.
- **Target state:** credential rotated + history decision recorded (Q-01); scoping as mechanism (P0-011 helper); ledgers SELECT-only; GDPR-shaped deletion/export (P10); Slack path locked (D-026).
- **Missing work:** P0-001 (NOW), P0-011; M-1 auth gate + quote-token hardening (P0-010 adjacencies); soft delete + data export/deletion (P10); EIN encryption.
- **Dependencies:** P0-001 precedes everything; runbooks exposed-credential + tenant-data-leak.
- **Priority phase:** P0, P10.
- **Risks:** until C-1 rotates, assume full cross-tenant compromise is possible (audit 00).
- **Feature flag:** none — structural.
- **Acceptance evidence:** old credential fails to connect (verified); tenant-isolation + RLS test suite green; a missed `.eq("shop_id")` in a service-role path is caught by the helper/lint mechanism, demonstrated by test.
- **Status:** **building**

## 25. Reliability and observability

- **Current audit status:** Reliability 5/10, observability 4/10 (audit 10): approval rollback sound, webhooks fail closed — but no queue/retry/dead-letter, non-idempotent inbound webhooks, weekly crons with no catch-up, silent-degradation culture, **anomaly alerts go to console only**, no structured logs, no health endpoint, Sentry errors-only.
- **Existing foundation:** `monitoring.ts` anomaly detection, Sentry wiring, reconciliation cron, fail-closed credit machinery.
- **Target state:** alerts that page a human (P0-012); idempotent inbound everywhere (P0-005/006/007); later outbox/queue, structured logging, health, tracing (P10); SEV-0..3 runbooks live (`runbooks/`).
- **Missing work:** P0-005..008, P0-012; P10 hardening list.
- **Dependencies:** decision Q-08 (alert destination); vendor monitoring sections.
- **Priority phase:** P0, P10.
- **Risks:** "failures are silent by design and nobody is paged" (audit 00 weakness #5).
- **Feature flag:** none — always on.
- **Acceptance evidence:** a simulated reconciliation drift and a cron failure each produce a delivered alert within minutes; duplicate-webhook replay suite green; incident runbook walked once (game day).
- **Status:** **building**

## 26. Support operations

- **Current audit status:** NOT_FOUND as a system — no support tooling, no impersonation/read-only support view, no status page, no in-app help beyond docs; `operator-playbook.md` exists for owners.
- **Existing foundation:** glass-box audit trails (excellent support raw material), demo-data seed/clear, Shadow Mode.
- **Target state:** founder-scale support kit first (runbooks, seeded-repro shop, audit-trail queries), then in-product help + status page as shop count grows.
- **Missing work:** support runbook set (this directory's `runbooks/` starts it), support-safe read-only access model (needs capability 3 roles), status page.
- **Dependencies:** capability 3 (roles) for any support-access model; D-018.
- **Priority phase:** P10 (tooling); runbooks immediately (this session).
- **Risks:** founder-does-support doesn't scale; ad-hoc prod DB access for support recreates the C-1 risk class.
- **Feature flag:** `supportAccess` (new, far future).
- **Acceptance evidence:** a simulated customer issue resolved using only runbooks + audit surfaces (no direct DB access).
- **Status:** **planned**

## 27. Responsive PWA

- **Current audit status:** Responsive behavior exists in the design system (mobile rules, bottom composer) and the mobile loop was a go-live smoke item; **no PWA manifest, no installability, no offline strategy** — not audited as a capability because it doesn't exist yet.
- **Existing foundation:** mobile-first design rules (BUILD_REFERENCE, `ui/responsive-rules.md`), server-first architecture (low client-state burden).
- **Target state:** installable PWA: manifest, icons, sensible offline/degraded states, push-notification decision; owner runs the day from a phone (D-020 — precedes any native app).
- **Missing work:** E08 — manifest + install flow, mobile audit of every core flow, notification strategy.
- **Dependencies:** D-020; capabilities 9/10/15 flows must be mobile-complete first.
- **Priority phase:** P8.
- **Risks:** PWA claim without offline honesty violates D-025 (no dead controls); iOS PWA limitations for notifications.
- **Feature flag:** none — progressive enhancement.
- **Acceptance evidence:** lead capture → approval → booking completed on a phone (installed PWA) in under 60s on seeded data; Lighthouse PWA checks pass; degraded-offline state is a written state, not a blank screen.
- **Status:** **planned**

## 28. Marketing website

- **Current audit status:** Waitlist/landing site exists in `marketing/` (separate Next.js app, waitlist-era copy); not covered by the platform audit. Claims discipline governed by WHAT_GRADIA_DOES.
- **Existing foundation:** `marketing/` app, positioning docs, pricing doc, claim list.
- **Target state:** full public pricing displayed (D-004), no founding-discount framing (D-003), claims split live/beta/planned (D-028), voice marketed only after acceptance run.
- **Missing work:** pricing page against GRADIA_PRICING; copy sweep for retired framings ("front office", 7-agent cast); launch alignment to 2026-08-07; see `marketing-site/`.
- **Dependencies:** D-003/004/028; WHAT_GRADIA_DOES claim flips; D-033 adopted the OS category + headline 2026-07-27 (C-01 updated) — per-feature claims still gate on WHAT_GRADIA_DOES; pricing page blocked on Q-22 (C-14).
- **Priority phase:** P0-adjacent (must be truthful at alpha), iterated through P8.
- **Risks:** claim drift — marketing a capability whose status here isn't `pilot`/`public`; manual deploy step forgotten (site does not auto-deploy).
- **Feature flag:** n/a.
- **Acceptance evidence:** every site claim maps to a capability with status pilot/public in this file; pricing page matches GRADIA_PRICING SKUs exactly.
- **Status:** **building**

---

## Summary table

| # | Capability | Phase | Status |
|---|---|---|---|
| 1 | Platform foundation | P0 / P10 | pilot |
| 2 | Organizations | P1 | pilot |
| 3 | Members, roles, permissions | P1 | planned |
| 4 | Locations and resources | P4 | planned |
| 5 | Customers and companies | P3 | pilot / planned |
| 6 | Vehicles and service history | P3 | pilot |
| 7 | Leads and pipeline | P3 / P8 | pilot |
| 8 | Quotes and deposits | P0 / P5 | pilot / planned |
| 9 | Calendar and availability | P0 / P2 | building / designed |
| 10 | Jobs and work orders | P4 | pilot / planned |
| 11 | Invoices and payments | P5 | planned |
| 12 | Recurring jobs | P6 | planned |
| 13 | Memberships | P6 | planned |
| 14 | Fleet accounts and service | P6 | planned |
| 15 | Communications | P0 / P7 | pilot / planned |
| 16 | Imports and exports | P3 | internal |
| 17 | Reporting | P8 | building |
| 18 | Gradia Agent | P1 / P9 | pilot |
| 19 | Opportunity Engine | P9 | designed |
| 20 | Voice receptionist | P0 / P9 | internal |
| 21 | Earned autonomy | P9 | internal |
| 22 | Integrations | P1–P3 | pilot (mixed) |
| 23 | Trial & subscription billing | P0 / P1 | pilot / planned |
| 24 | Security and privacy | P0 / P10 | building |
| 25 | Reliability and observability | P0 / P10 | building |
| 26 | Support operations | P10 | planned |
| 27 | Responsive PWA | P8 | planned |
| 28 | Marketing website | P0–P8 | building |

_No capability is `public` yet — alpha is 2026-08-07 and claims flip only via `WHAT_GRADIA_DOES.md`. Nothing here is `deprecated`; retired scope (IG/FB DMs, Slack approvals, 7-agent cast) is recorded in `16-document-source-map.md`, not carried as capabilities._

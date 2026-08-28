# 05 — Feature Requirements

_Created 2026-07-25 by the Organizer. Testable requirement statements per capability area (numbering FR-###, grouped to match the 28 areas in `04-capability-map.md`). Each requirement carries its roadmap phase (`10-roadmap.md` P0–P10) and its source (decision D-###, audit doc, or spec). "Preserve" = the behavior exists and is audited working — a regression is a defect, not a scope question._

Requirement verbs: **MUST** (binding), **MUST NOT** (binding prohibition). Anything softer belongs in an epic's non-goals or the decision queue, not here.

## 1. Platform foundation

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-001 | Every tenant table MUST carry `shop_id` with RLS enabled and the standard tenant policy; new tables inherit this at creation. | Preserve/all | audit 05 |
| FR-002 | Service-role code paths MUST apply explicit tenant scoping through a shared, reviewable mechanism (scoping helper or session-variable pattern) — not per-call discipline. | P0 (review) → P1 (mechanism) | P0-011, audit 06 |
| FR-003 | Incomplete or high-risk functionality MUST ship behind a feature flag; flags are flipped only after their smoke test passes. | Preserve | D-027, GO_LIVE_CHECKLIST |
| FR-004 | CI MUST run typecheck, lint, production build, deterministic tests, and the DB integration tier, and MUST block merge to `main` on any failure. | P0 | P0-002, audit 03/12 |
| FR-005 | The product MUST NOT contain fake data, fake metrics, dead controls, or simulated integrations; env-gated fallbacks MUST name the missing configuration. | Preserve/all | D-025, audit 08 |
| FR-006 | Every UI figure MUST trace to real database rows; deltas render only when the prior period has real rows. | Preserve/all | BUILD_REFERENCE §3, HOME_REDESIGN_PLAN |
| FR-096 | The product MUST provide global search (customers, vehicles, leads, quotes, jobs, conversations) reachable from every dashboard surface; the ⌘K composer is a command surface, not a substitute for search. | P3 (CRM entities) → P4+ (jobs) | Founder master definition parity, added 2026-07-27; `06-ui-information-architecture.md` |

## 2. Organizations

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-007 | Shop creation MUST remain zero-founder-touch: every per-shop setup step is automated or self-serve. | Preserve | Principle 9, audit trace K |
| FR-008 | Multi-shop-per-owner (cookie-pinned active shop, re-verified server-side) MUST be preserved through the tenancy rework. | P1 | audit 02/06 |

## 3. Members, roles and permissions

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-009 | A shop owner MUST be able to invite a second user with a defined role; the invited user MUST NOT share the owner's login. | P1 | D-018, audit trace L |
| FR-010 | The members/roles model MUST land before E04+ schema expansion creates further single-owner tables. | P1 | D-018 |
| FR-011 | Every role-gated action MUST have a permission test (allowed role passes, denied role fails). | P1+ | Builder contract, `09-testing-strategy.md` |

## 4. Locations and resources

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-012 | New scheduling/job schema designed from P2 onward MUST NOT hard-code single-location/single-operator assumptions (location and resource FKs nullable-single today, extensible later). | P2+ | audit 03 (Locations NOT_FOUND) |

## 5. Customers and companies

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-013 | The full CRM (customers, vehicles, quotes, jobs, calendar) MUST be usable with every AI feature disabled. | P3 exit | D-002 |
| FR-014 | A direct "Add customer" form MUST exist (today customers are created only implicitly). | P3 | audit trace A |
| FR-015 | The identity spine MUST be preserved: find-or-create by normalized channel, oldest-row-wins, conservative dedupe, manual merge. | Preserve | audit 03/04 |
| FR-016 | Customer data MUST be exportable (CSV at minimum). | P3 | audit 03 (export NOT_FOUND) |
| FR-017 | Consent state (`marketing_consent_at`, `sms_opted_out_at`, `do_not_contact`) MUST be enforced at both audience-resolution time and send time, fail-closed. | Preserve | audit 06, MVP plan §6 |

## 6. Vehicles and service history

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-018 | Vehicles MUST support VIN and trim, with a standalone edit UI and a per-vehicle service-history view. | P3 | audit 03/11 |
| FR-019 | Vehicle writes that accept a `customerId` MUST verify the customer belongs to the acting shop before insert. | P0–P1 | audit trace B (tenant gap) |

## 7. Leads and pipeline

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-020 | The legacy `leads.status` enum MUST be retired so `stage` is the single truth; nothing may write both. | P3 | audit 05 §weakness 3 |
| FR-021 | Pipeline stage moves MUST remain code-event-driven (quote sent, timer, booked, lost) — no free-form stage edits from AI. | Preserve | audit trace E |
| FR-022 | Lead creation MUST NOT silently proceed when identity creation fails (no orphan leads with `customer_id: null`). | P3 | audit trace A failure point |

## 8. Quotes and deposits

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-023 | Accepting a quote MUST resolve the quote's existing lead — never fork a duplicate pipeline card — and MUST advance quote status through `accepted` to booked/won linkage. | P0 | P0-009, audit trace C — **met 2026-08-26** (PR #25; lead reused, quote → `booked` only after durable appointment persistence; integration-tested + founder acceptance) |
| FR-024 | An expired quote (`valid_until` past) MUST be rejected server-side; the expired-quote visitor experience follows the founder decision (queue Q-04). | P0 | P0-009, audit 03 (BROKEN) — **met 2026-08-26** (PR #25; accept AND decline refused past `valid_until`, replay refused; minimal honest expired state live — Q-04 richer CTA still open, non-blocking) |
| FR-025 | The public quote token MUST be CSPRNG-generated with expiry and a rate-limited guess surface. | P1 | audit 06 L-3 |
| FR-026 | Quote deposits MUST be collected via Stripe Connect and recorded as immutable payment events. | P5 | D-019, D-024 |
| FR-094 | Quotes MUST support versions (revisions preserved, one active), lost reasons on decline/close, taxes & fees, and discounts; customer signature capture where the shop requires it. | P3 (versions/lost reasons) · P5 (taxes/fees/discounts/signature) | Founder master definition parity, added 2026-07-27 |

## 9. Calendar and availability

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-027 | One central conflict service MUST answer "is this slot free" for ALL booking paths (voice, quote accept, drag, block-time, reschedule); no path may bypass it. | P0 | P0-003/004, audit trace D |
| FR-028 | Automatic (autonomous/voice/self-serve) scheduling MUST hard-block conflicting slots. | P0 | D-015 |
| FR-029 | Human-approved scheduling MAY override a conflict only with the conflict shown on the approval card and the override recorded (who/when/what conflict). | P0 | D-016 |
| FR-030 | Gradia's database MUST become the appointment source of truth; booking MUST work with no external calendar connected. | P2 | D-013, audit trace D (hard Aurinko gate today) |
| FR-031 | Google and Microsoft calendars MUST be synchronized mirrors — subordinate to Gradia's appointment records. | P2 | D-013/D-014 |

## 10. Jobs and work orders

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-032 | The validated job status machine (booked→…→closed) MUST be preserved as the single job-state authority. | Preserve | audit 03 |
| FR-033 | Job assignment and checklists MUST ride on the P1 members model (no parallel assignee concept). | P4 | E04, D-018 |

## 11. Invoices and payments

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-034 | Financial ledgers (`usage_events`, `payments`, grants, future invoices) MUST be append-only, immutable, and NOT owner-writable via RLS (SELECT-only pattern like `credit_grants`). | P0–P1 | D-024, audit 05 §weakness 4 |
| FR-035 | Customer-facing payments MUST build on Stripe Connect before any other processor. | P5 | D-019 |
| FR-036 | Payment/refund records MUST be keyed by provider identifiers and replay-safe (retrying a provider event never duplicates a financial row). | P5 | D-023/D-024, existing `payments` unique pattern |
| FR-095 | Standalone invoices (no job/quote anchor) MUST be supported — phased within E05 after anchored invoices land; the anchored-first ordering is sequencing, not permanent scope. | P5 | Founder master definition parity, added 2026-07-27; E05 |

## 12–14. Recurring jobs · Memberships · Fleet accounts

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-037 | Recurring jobs, memberships, and fleets MUST be modeled as three separate domains — not flavors of one "repeat work" entity. | P6 | D-017 |
| FR-038 | Each of the three domains MUST book through the central availability engine (FR-027/30) and bill through E05 payment primitives. | P6 | E06 dependencies |
| FR-039 | `maintenance_schedule` data armed on job completion MUST be consumed by a reminder/recurrence path before recurring jobs is declared live. | P6 | audit 03 (armed, unconsumed) |

## 15. Communications

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-040 | A provider-retried inbound webhook (Twilio `MessageSid`, Aurinko `aurinko_message_id`, Vapi end-of-call) MUST NOT create a duplicate interaction, approval card, classification spend, or meter row — enforced by database uniques, not check-then-insert. | P0 | D-023, P0-005/006/007 |
| FR-041 | Delivery status MUST record correctly for Gradia-provisioned (subaccount) numbers. | P0 | P0-008 — **met 2026-08-25** (PR #23; subaccount → BYO → env-master resolution restored on the status route; audit trace F bug closed) |
| FR-042 | All outbound SMS/email MUST flow through the single approval executor with send-policy (quiet hours, STOP, consent) evaluated at send time regardless of trigger. | Preserve | audit 07 |
| FR-043 | An email-classifier failure MUST NOT default to "is a lead" (no outage-driven card flood); failure polarity matches SMS (skip + log). | P7 | audit trace G |
| FR-044 | Outbound email replies MUST thread into the original conversation. | P7 | audit trace G, roadmap item 16 |
| FR-045 | Conversations MUST include email alongside voice + SMS with an in-thread reply composer. | P7 | audit 03 (unified inbox PARTIAL) |
| FR-046 | Owner quick-reply's relationship to STOP/send-policy follows the founder decision (queue Q-05); until decided, the current unrestricted behavior is documented, not extended. | P7 | audit Q6 |

## 16. Imports and exports

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-047 | Every import MUST pass through staging → mapping → preview → validation → error reporting → rollback; no import writes directly to live tables. | P3 | D-022, `07-onboarding-and-imports.md` |
| FR-048 | Imports MUST NOT trigger any outbound message; recovered/imported contacts enter win-back audiences only through the TCPA/consent gates. | Preserve | audit 00, recovery spec |
| FR-049 | Import errors MUST produce a row-level downloadable error report; a completed import MUST be reversible as a unit (undo by import job). | P3 | D-022, existing recovery undo |

## 17. Reporting

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-050 | Revenue figures MUST net refunds and split upcoming revenue as "$X booked · $Y quotes out" — never blended, never double-counting a booked lead's quote. | Preserve | HOME_REDESIGN_PLAN locked decisions |
| FR-051 | Funnel and campaign analytics MUST attribute outcomes to real runs (`custom_agent_runs`) — no modeled/estimated attribution presented as measured. | P8 | audit 03, D-025 |

## 18. Gradia Agent

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-052 | Every customer-facing agent action MUST stage into `pending_actions` and execute only through the single approval executor. | Preserve | D-011, audit 07 |
| FR-053 | No agent loop may hold a send tool (source-scan test stays locked). | Preserve | audit 07, eval/guardrails |
| FR-054 | Freeform outreach MUST keep: audience cap (default 50, max 200), per-channel cooldowns, STOP/consent screening, credit pre-check, dry-run preview with audience count + sample drafts. | Preserve | MVP plan §6, audit trace J |
| FR-055 | Every staged action MUST get a decision-log "because" row — including the `stageSingle` paths that skip it today. | P1 | audit 07 caveat |

## 19. Opportunity Engine

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-056 | Lifecycle derivation (`at_risk`/`lapsed`) MUST run on a cron only after founder sign-off of thresholds (queue Q-02); win-back audiences remain empty until then. | P3 | audit Q2, lifecycle.ts deliberately unwired |
| FR-057 | Opportunity suggestions MUST each carry a traceable "because" (decision-log row) and rank by real data (revival candidates, maintenance schedules, whisper suggestions). | P9 | E09, audit item 20 |

## 20. Voice receptionist

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-058 | Every voice tool write MUST stage HITL; booking/quote remain inside the ALWAYS_HITL floor. | Preserve | audit trace H |
| FR-059 | Budget exhaustion MUST NOT cut a live call — state flips at the next call (take-a-message fallback). | Preserve | GRADIA_PRICING §paywall |
| FR-060 | Vapi tool parameters MUST be zod-validated like every other tool boundary. | P1 | audit 07/11 |
| FR-061 | Voice-minute metering MUST be idempotent per call (vendor_ref uniqueness). | P0 | P0-007 — **met 2026-08-14** (PR #21; P0-005 unique + provider_events claim) |
| FR-062 | `VAPI_DEFAULT_SHOP_ID` MUST be unset in production. | P0 | P0-010, audit Q18 — code-side guard shipped in P0-007 (prod fallback fails closed); **met 2026-08-28**: founder manually confirmed the var ABSENT from Vercel Production at the P0-010 acceptance |

## 21. Earned autonomy

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-063 | Money, calendar, and (per D-021) high-ticket actions MUST require approval in every mode; no flag, mode, or refactor bypasses `isAutonomyAllowed()` floors. Threshold for "high-ticket": queue Q-11. | Preserve + P5 | D-021, locked principle 4 |
| FR-064 | Autonomy requires Package 2 entitlement; dropping the entitlement MUST degrade every agent to suggest-first. | Preserve | GRADIA_PRICING, audit 07 |
| FR-065 | Mode switches MUST be auditable (who, when, which agent); confidence stays qualitative, never a percentage. | Preserve | BUILD_REFERENCE §5 |

## 22. Integrations

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-066 | All vendor calls go through provider seams; no vendor types leak past seam modules. An LLM seam (one client module: model registry, timeouts, retries, error taxonomy) MUST close the one missing seam. | P1 | Principle 8, audit 07/09 |
| FR-067 | A transient LLM failure MUST retry, not silently drop a campaign recipient (`.catch(() => null)` pattern eliminated at the seam). | P1 | audit 07 weakness 4 |
| FR-068 | Housecall Pro endpoints and A2P TrustHub SIDs MUST be verified against live accounts before the capabilities they serve are marketed. | P0–P1 | audit Q11/Q12, D-028 |

## 23. Trial and subscription billing

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-069 | Pricing is fully public; no founding pricing or lifetime discounts anywhere in product or marketing. | All | D-003/D-004 |
| FR-070 | The trial MUST be the full operational product with controlled variable-cost allowances, fail-closed at the cap (numbers: queue Q-13). | P3 | D-005 |
| FR-097 | The trial clock MUST start at meaningful setup/activation, not email signup (gate definition: queue Q-13); an account is not marked onboarding-complete until the core workflow (lead → quote → acceptance → appointment → job → payment → follow-up) has been exercised on the account — simulated where the phase's real capability doesn't exist yet. | P1 (trial gate) → P5 (full workflow test) | D-032, founder master definition parity, added 2026-07-27; `07-onboarding-and-imports.md` |
| FR-071 | Credit and minute meters MUST never cross; caps fail closed; warnings at 80% with pre-run cost estimates. | Preserve | GRADIA_PRICING |
| FR-072 | Usage pricing MUST hold the ~70% margin floor; per-shop margin verified from `usage_events` (wholesale + retail per row). | Preserve | GRADIA_PRICING §margin |

## 24. Security and privacy

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-073 | No credential may exist in source, git history, logs, or docs; the leaked `SUPABASE_DB_URL` is rotated and treated as compromised. | P0 | P0-001, audit C-1 |
| FR-074 | All webhooks remain signature-verified, timing-safe, fail-closed, and test-locked. | Preserve | audit 06 |
| FR-075 | Slack approvals remain disabled until claims are shop-bound (tenant authorization rebuilt); re-enabling requires an ADR. | Standing | D-026, audit C-2 |
| FR-076 | `a2p_registrations.business` (EIN/legal identity) MUST be encrypted at rest like other per-shop credentials. | P1 | audit 05/06 |
| FR-077 | Unauthenticated LLM-invoking endpoints MUST NOT exist (`processRawLeadNote` gets auth + metering + rate limit). | P0 | P0-010, audit M-1 — **met 2026-08-28** (PR #27; session auth, fail-closed gates, `ai_lead` rate bucket, credits=0 metering; unauthenticated replay refused at acceptance) |
| FR-078 | Customer data deletion and export flows MUST exist before scale sales; cascade-delete of ledgers/consent history is removed (soft-delete/archival). | P10 | audit 05 §weakness 2, roadmap item 29 |

## 25. Reliability and observability

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-079 | Monitoring anomalies, reconciliation drift, and cron failures MUST alert a human (not console-only). | P0 | P0-012, audit 00 weakness 5 |
| FR-080 | The dashboard MUST have `error.tsx` boundaries and `loading.tsx` on every section; a thrown server error never renders the framework default screen. | P0 | P0-010, audit 08 — **met 2026-08-28** (PR #27; root boundaries pre-existed, `(dashboard)`-level `error.tsx`/`not-found.tsx` added, all four missing `loading.tsx` routes covered; boundary + Sentry capture verified at acceptance) |
| FR-081 | New code MUST NOT add silent failure paths; failures carry structured, actionable information. | All | Builder contract, audit 09 |
| FR-082 | A health endpoint, structured logging, and trace sampling MUST exist before P10 exit. | P10 | audit 03/12 item 31 |

## 26. Support operations

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-083 | Every SEV-classified incident type has a runbook (`runbooks/`); severity scale SEV-0..3 as defined in `runbooks/incident-severity.md`. | P0 | this program |

## 27. Responsive PWA

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-084 | The responsive PWA (installable, mobile-complete flows) MUST precede any native mobile app work. | P8 | D-020 |
| FR-085 | Every user-facing flow MUST define its mobile behavior (see `ui/flows/`); the ⌘K composer maps to the mobile bottom composer with tap-to-talk. | All | BUILD_REFERENCE §2 |

## 28. Marketing website

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-086 | Every marketing claim MUST match `_docs/WHAT_GRADIA_DOES.md` and distinguish live, beta, and planned functionality. | All | D-028 |
| FR-087 | All plan prices appear together everywhere (wording predates D-031 re-pricing — re-derive tier copy under Q-22); allowances shown in human units; voice is a feature, never the headline. | All | GRADIA_PRICING §copy, WHAT_GRADIA_DOES §5, C-14 |

## Provider boundaries (D-029/D-030 — added 2026-07-27)

| ID | Requirement | Phase | Source |
|---|---|---|---|
| FR-088 | Application modules MUST NOT hardcode model IDs; every LLM call routes through the AI gateway (`ModelProvider`). | P1 | D-029, ADR-002, audit 07 |
| FR-089 | The AI gateway MUST record provider retries, timeouts, costs, latency and failures. | P1 | D-029 |
| FR-090 | Core calendar records MUST NOT carry Aurinko-specific identifiers as primary references — provider IDs are sync/mirror fields inside integration records and adapters. | P2 | D-029, D-013 |
| FR-091 | Core Gradia workflows MUST function with Jobber and Housecall Pro disconnected (true today — becomes a locked invariant with a source-scan/integration test). | P0 | D-030 |
| FR-092 | No new provider is adopted without the 17-point adoption gate in `vendors/README.md`, including founder approval and a Gradia-owned abstraction boundary. | All | D-030 |
| FR-093 | Housecall Pro remains unmarketed and feature-flag-disabled pending decision Q-19 (ticket P3-001). | P0 | D-030, Q-19 |

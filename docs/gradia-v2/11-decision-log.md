# 11 — Decision Log

_Approved decisions. Precedence layer 2 — beaten only by audited current behavior (what the code actually does today); wins over ADRs, principles, MVP plan, specs, and all historical docs. Open (undecided) items live in `program/decision-queue.md`, never here._

Format: `D-###` · status · date · statement · notes (supersessions, implications, source of truth affected).

Statuses: **Approved** · Superseded (by D-###) · Reversed.

## Batch 1 — Founder-approved 2026-07-25 (Gradia v2 program creation)

### Product identity & commercial

| ID | Decision | Notes |
|---|---|---|
| D-001 | **Gradia is the operating system for detailing and automotive appearance shops** (detailing, coating, PPF, tint). | Extends the 2026-07-16 "CRM that works itself" positioning (WHAT_GRADIA_DOES.md) from tagline to product scope. Marketing copy discipline in WHAT_GRADIA_DOES.md still governs *claims*; this governs *build direction*. Recorded contradiction: see `16-document-source-map.md` §Contradictions C-01. |
| D-002 | **Standard business operations must work without AI.** CRM, calendar, quotes, jobs, invoices are first-class and fully usable with every AI feature off. | AI is the differentiator, not a dependency. Affects capability acceptance criteria (04) and DoD (12). |
| D-003 | **No founding pricing, no lifetime discounts.** | Kills any "founder's deal" framing in launch/GTM docs. |
| D-004 | **Full public pricing.** Prices published on the marketing site; no "contact us". | `_docs/GRADIA_PRICING.md` remains the SKU/margin source of truth unless amended here. |
| D-005 | **Full operational trial with controlled variable-cost allowances.** Trial users get the real product; variable costs (SMS, voice minutes, LLM) are capped by allowances, fail-closed. | Supersedes the implicit "free = explore only, cannot run agents or send" model in GRADIA_PRICING.md §Paywall for the trial period. Trial allowance numbers: open — see decision queue Q-13. |
| D-006 | **Users may import real CRM and calendar data during setup/trial.** | Import quality is therefore a first-run trust moment; see D-024 and `07-onboarding-and-imports.md`. |
| D-028 | **Product claims must distinguish live, beta and planned functionality.** | Continues WHAT_GRADIA_DOES.md truth discipline; capability statuses in `04-capability-map.md` are the machine-readable form. |

### Architecture (preserve — do not "improve" away)

| ID | Decision | Notes |
|---|---|---|
| D-007 | **Preserve the modular monolith.** | Confirmed by audit doc 02: single deployable, disciplined lib/domain layer. |
| D-008 | **Do not migrate to microservices without measured need.** | "Measured" = a documented scaling/reliability metric the monolith cannot meet. |
| D-009 | **Preserve the planner→deterministic-runtime AI architecture.** LLM plans once; code executes. | Continues locked principle #3 (CLAUDE.md / SHARPENING_BRIEF). |
| D-010 | **Do not migrate to LangGraph** (or any agent framework) **without a specific unsolved workflow requirement.** | Continues locked principle #5. `@langchain/anthropic` stays a structured-output convenience only. |
| D-011 | **Preserve the universal approval engine** (`pending_actions` + one executor) as the sole path for AI-initiated side effects. | Audit doc 00 names it the strongest subsystem. New action types extend it; nothing bypasses it. |
| D-012 | **Preserve code-enforced business and compliance rules** (autonomy floors, send policy, TCPA/FTC gates) — in code, locked by tests, never in prompts. | Continues locked principle #2/#4/#6. Extend the locking tests, never weaken them. |

### Scheduling & calendar

| ID | Decision | Notes |
|---|---|---|
| D-013 | **Gradia's database becomes the appointment source of truth.** | Reverses today's audited behavior where booking hard-requires Aurinko/Google (`approvals.ts:686`) and the external calendar is authoritative. External calendars become subordinate mirrors. Epic E02; softening the hard dependency is part of P2 (P0-003/004 only add conflict enforcement on the current model). |
| D-014 | **Google and Microsoft calendars are synchronized integrations**, not the system of record. | Microsoft/Outlook sync is net-new work (Aurinko supports it; unbuilt). |
| D-015 | **Automatic scheduling hard-blocks conflicts.** Any autonomous/voice/self-serve booking path refuses a conflicting slot. | Resolves audit open question #3 for the autonomous half. |
| D-016 | **Human-approved scheduling may allow a documented override.** The approval card shows the conflict; an owner override is recorded (who/when/what conflict). | Resolves audit open question #3 for the HITL half. Implemented via P0-003/P0-004. |

### Domain scope

| ID | Decision | Notes |
|---|---|---|
| D-017 | **Recurring jobs, memberships, and fleets are separate domains** — modeled independently, not as flavors of one "repeat work" entity. | Epic E06. Nothing today implements any of the three (audit: maintenance_schedule is armed but unconsumed). |
| D-018 | **Multi-user tenancy and roles must precede major schema expansion.** The members/roles model lands before the E04+ domain build-out accretes more single-owner tables. | Aligns with audit doc 09 ("introduce members before more tables accrete"). Epic E01, phase P1 — pulled earlier than the audit's P3 suggestion by this decision. |
| D-019 | **Payments use Stripe Connect first.** Customer-facing payments (deposits, invoices) build on the existing flagged-off Stripe Connect foundation before any other processor. | Supersedes WHAT_GRADIA_DOES.md §3 "no invoicing/payment collection" as *permanent* scope — that line remains true as a current-claim statement until E05 ships. |
| D-020 | **Responsive PWA precedes native mobile applications.** | No React Native/Swift work before the PWA is complete (E08). |

### Safety, integrity & operations

| ID | Decision | Notes |
|---|---|---|
| D-021 | **High-risk financial, scheduling and high-ticket actions require approval** regardless of autonomy mode. | Restates and extends the ALWAYS_HITL floor (money + calendar) to include high-ticket thresholds; threshold value: decision queue Q-11. |
| D-022 | **Imports require staging, mapping, preview, validation, error reporting and rollback.** | The recovery-import pipeline (staging/review/undo) is the pattern; structured CRM imports must meet the same bar. Governs `07-onboarding-and-imports.md`. |
| D-023 | **External provider events must be idempotent** — provider event identifiers enforced unique at the database level. | Audit found inbound SMS/email/voice-metering non-idempotent. Tickets P0-005/006/007. |
| D-024 | **Financial events must be immutable and replay-safe.** Ledgers (`usage_events`, `payments`, grants) are append-only, never owner-writable, keyed by provider refs. | Audit doc 05 found owner-writable FOR ALL RLS on ledgers; fix rides with P0-005/P0-011 follow-ups. |
| D-025 | **No fake data, fake metrics, dead controls or simulated integrations.** | Audit doc 08 confirms this is already the culture; now it is binding policy. |
| D-026 | **Slack approvals remain disabled unless tenant authorization is rebuilt.** | Locks the mitigation for audit finding C-2 (cross-tenant approval execution). Flag stays `false`; re-enabling requires an ADR + shop-bound claims. |
| D-027 | **Feature flags gate incomplete or high-risk functionality** (existing `features.ts` discipline continues; per-ticket flags named in each ticket spec). | Carried from MVP plan §7. |

## Batch 2 — Founder-approved 2026-07-27 (vendor-architecture amendment)

| ID | Decision | Notes |
|---|---|---|
| D-029 | **Gradia domains depend on Gradia-owned interfaces, not vendor-specific behavior.** Required boundaries: Calendar→`CalendarProvider` (Aurinko/Google/Microsoft Graph), AI gateway→`ModelProvider` (Anthropic/OpenAI), Voice→`VoiceProvider` (Vapi/future), Telephony→`TelephonyProvider` (Twilio/future), Payments→`PaymentsProvider` (Stripe/future), Customer integration→`CRMConnector` (Jobber/HCP/future). Provider IDs/cursors/payloads/sync state stay in integration records and adapters wherever practical; core business entities use Gradia-owned identifiers. | Mechanism detail: `adr/ADR-002-provider-boundaries.md`. AI specifics: centralized AI gateway, no hardcoded model IDs in app modules, retries/timeouts/costs/latency/failures recorded, no core logic tied to one model provider. Extends locked principle #8 to the LLM layer (the missing seam — audit 07/09; built in E01). |
| D-030 | **Vendor classification model + adoption gate.** Providers are classified core (Supabase, Vercel, Stripe, Twilio, Sentry) / AI-strategic-replaceable (Anthropic, OpenAI, Vapi) / transitional (Aurinko) / optional customer integration (Jobber — optional; Housecall Pro — **quarantined**). No new provider is adopted without the 17-point checklist in `vendors/README.md`, founder approval included. | Jobber: customer-demand driven, flagged, never a core dependency (Q-20). Housecall Pro: not marketed, flag disabled, no new investment, import-only-vs-removal review = ticket P3-001 (Q-19). Aurinko: kept through stabilization, must remain replaceable, core calendar records never depend on Aurinko-specific identifiers (with D-013). Registry: `vendors/registry.md`. |

## Batch 3 — Founder master product definition (2026-07-27 verification session)

_Recorded from the founder's master product definition supplied in writing to the 2026-07-27 architecture/planning verification session. Each statement below is founder-stated in that definition; genuinely open implementation details are queued (Q-22/Q-13), never assumed. Founder confirmation of this batch at next review closes the loop._

| ID | Decision | Notes |
|---|---|---|
| D-031 | **Public pricing re-bases to three tiers: Core $99/mo · Pro $149/mo · Operator $249/mo.** No founding rate, no lifetime discounts, no fake crossed-out pricing (reaffirms D-003). Pricing remains centrally configured (`pricing_config`), never duplicated across application and marketing files. | Supersedes the Core $20 / +$29 packaging imported under "Prior locked decisions" **as forward direction only** — live billing and the deployed Stripe products still charge $20/$29 today (same asymmetry as D-013: layer 1 describes what is true; this decision sets what becomes true). `_docs/GRADIA_PRICING.md` needs a founder-approved rewrite (outside gradia-v2 — flagged, not performed). Tier feature split, credit/minute allowances per tier, re-derived margin floors, adoption timing, and existing-shop migration: open in **Q-22**. Contradiction recorded as **C-14** in `16-document-source-map.md`. |
| D-032 | **The trial begins after meaningful setup or activation, not merely after email signup.** The full operational trial model (D-005) is unchanged; this fixes *when* it starts. | Exact activation gate (which onboarding steps count as "meaningful setup") plus duration/allowances remain open in **Q-13** (amended). Affects `ui/flows/trial-to-paid.md`, `07-onboarding-and-imports.md`, `15-cost-and-margin-model.md` §5. |
| D-033 | **Marketing category adopts "The operating system for detailing and automotive appearance shops."** Primary headline: "Run your shop. Capture every lead. Recover more revenue." The site must show standard operations working independently of AI, explain approval controls, switching/imports, and the trial, show real product UI, distinguish live/beta/planned functionality (D-028), avoid fake testimonials/logos/metrics and unsupported security claims, and use centralized pricing + feature-status configuration. Required routes: Home, Product, Receptionist, Industries (Detailing · Ceramic coating · PPF/tint/wrap · Mobile detailing · Fleet), Pricing, Security, Demo, Login. | Resolves Q-14 (category-language timing) in favor of OS language. C-01 updated in `16-document-source-map.md`. Per-feature *claims* remain governed by D-028 + WHAT_GRADIA_DOES truth discipline — category positioning may lead the product's build-out; individual feature claims may not. `_docs/WHAT_GRADIA_DOES.md` headline/claim list needs a founder update (outside gradia-v2 — flagged, not performed). |

## Batch 4 — Pricing implementation & trial (2026-08-28 founder session)

_Approved by the founder in writing 2026-08-28 (Cowork planning session), resolving Q-22 and Q-13. Recorded by Claude acting as Organizer. (Restored 2026-08-28 after an uncommitted-work wipe; now committed.)_

| ID | Decision | Notes |
|---|---|---|
| D-034 | **Three-tier contents + allowances (resolves Q-22).** Core $99: full CRM + Gradia Agent + Whisper + Ask Gradia + approvals + imports, 7,000 credits/mo, suggest-first only, no voice. Pro $149: adds voice receptionist + business number + earned autonomy; 6,000 credits + 100 voice minutes/mo. Operator $249: adds team seats/multi-user + priority support; 10,000 credits + 180 minutes/mo. Margin rules carried forward (~3.3x wholesale, included retail value ~70% of price; worst-case floors ~76-77%). Packs ($10/950 credits, $10/40 min), 25% rollover, never-crossing meters, credit menu: all unchanged. Money + calendar always ask, every tier. | Implements D-031. `_docs/GRADIA_PRICING.md` rewritten 2026-08-28 (old version archived at `_docs/.archive-2026-08-28/`). Adoption = when P0-013 ships; live billing stays $20/$29 until then (C-14 narrows to implementation lag). Existing pilot-shop migration decided at P0-013. Allowances re-checked against real `usage_events` margin data post-launch. |
| D-035 | **Trial model (resolves Q-13).** 14-day clock starting at activation, not signup (per D-032); activation gate = import committed OR (service menu saved + calendar connected). Card optional to start, **required to convert**, with clear pre-conversion reminders. Trial allowance: 500 credits + 15 voice minutes; business number provisioned only after card on file. Enforced by existing fail-closed machinery; worst-case trial COGS ~$5/shop. | Amends GRADIA_PRICING (done in the 2026-08-28 rewrite). Unblocks trial build in E01/billing and `ui/flows/trial-to-paid.md` final states. Marketing may say "14-day guided trial - starts after your setup - trial usage limits apply." |

## Batch 5 — Founder-approved 2026-09-01 (autorun prep)

_Recorded by the Organizer from `program/autorun.md` §"Founder decisions recorded for autorun" and §"Stack decision" (founder's Cowork session, 2026-09-01). D-036/D-037 are founder-stated; D-038…D-049 record the founder's one-line batch acceptance of the Organizer recommendations for Q-01(a), Q-02, Q-03, Q-05, Q-08, Q-09, Q-11, Q-12, Q-15(a), Q-16, Q-17, Q-23(a) — statements below are the accepted recommendations verbatim in substance; D-050 is the stack decision pinned by number in autorun.md. **Numbering note:** autorun.md allots D-038…D-049 (12 numbers) to a 13-item list that also includes Q-25(a), and pins D-050 to the Aurinko replacement — so Q-25(a) is recorded as **D-051**, and the same-day stack decision to delete Housecall Pro + Slack approvals (which autorun.md states resolves Q-07/Q-19 and which CLEANUP-001 needs in this log per autorun rule 5) is recorded as **D-052**. Q-18/Q-19→D-052, Q-20/Q-24 remain open per the founder line; Q-21 is resolved by D-050._

### Product, market & build mode

| ID | Decision | Notes |
|---|---|---|
| D-036 | **Primary ICP moves from solo/mobile detailers to established automotive-appearance shops** — multi-bay, 2+ staff, detailing/ceramic/PPF/tint. | Consequences (founder-stated): multi-user (E01) and jobs/team ops (E04) are **launch requirements**, not later phases; the Operator tier (D-034) is real; migration/import from existing tools (E03) is a **first-run requirement**. The private-beta bar under D-036 is "an established shop can run on Gradia" = autorun Batch 5 complete; reps sell design-partner trials before that only with the Batch-1 product and clear "team features arriving" language. `_docs/WHAT_GRADIA_DOES.md` §1 and the marketing ICP need a matching founder update (outside gradia-v2 — flagged, not performed). Contradiction recorded as **C-16** in `16-document-source-map.md`. Amends the E04 business-reason framing ("single-operator is an alpha constraint") from aspiration to requirement. |
| D-037 | **Batch autonomous building is approved** under the rules in `program/autorun.md` (ordered queue, one commit per ticket, full validation before every commit, hard-stop conditions, append-only log). Lanes A/D/E/G stay founder-only. | Process layer only: the lane model (Builder/Reviewer/Organizer/Founder) is batched, not replaced; when autorun.md and a ticket disagree, the ticket wins on scope and autorun.md wins on process. Founder acceptance gates per ticket are listed in the queue tables; the Reviewer (Cursor) runs one review per batch branch. Same-day stack decision: the stack stays as is (Next.js/React/TypeScript · Supabase · Vercel · Stripe · Twilio · Vapi (+OpenAI inside Vapi) · Anthropic); no other vendor change without the 17-point checklist in `vendors/README.md`. Vendor deltas are D-050 and D-052. |

### Accepted Organizer recommendations (decision-queue batch, founder one-line approval)

| ID | Decision | Notes |
|---|---|---|
| D-038 | **Leaked database credential: rotate, no git-history scrub** (Q-01 option a). The credential is documented as compromised-and-rotated; history is not rewritten. | Closes the P0-001 history-scrub sub-step as "not performed by decision" — P0-001's remaining acceptance steps are unchanged. Removes the Q-01 row from `program/blocked.md` at the next board update. |
| D-039 | **Lifecycle thresholds approved as implemented:** active <180 days, at_risk 180–365, lapsed >365 (Q-02). Per-shop configurability only if pilots ask. | Unblocks wiring `lifecycle.ts` to the automations cron — ticket **E03-03**. Win-back audiences draw only from lifecycle + TCPA + consent gates (07 §3). |
| D-040 | **Direct customer creation was an omission — build direct create/edit in E03** (Q-03). D-002 (works without AI) requires it. | Ticket **E03-01** (with vehicle create/edit and customer export). |
| D-041 | **Operator quick-reply to an opted-out customer: warn-but-allow** (Q-05). A human owner replying is not automated marketing; the TCPA-adjacent risk gets a visible, written warning before send. | Implemented in the E07 composer (Batch 6+); `sendOperatorSms` behavior unchanged until then. Automated/agent sends keep the hard STOP block — this decision narrows to the owner's manual reply only. |
| D-042 | **Alert destination: founder Slack ops channel for every alert + SMS for SEV-0/1** (Q-08; taxonomy `runbooks/incident-severity.md`). | Completes P0-012 step 6. The delivery seam is destination-agnostic and ships even if the Slack webhook is not yet configured (autorun Batch 1 #3). This is an **outbound ops webhook**, not the Slack *approvals* surface — it must not depend on `lib/slack.ts`, which D-052 deletes. Removes the Q-08 row from `program/blocked.md` at the next board update. |
| D-043 | **Microsoft calendar: Google-first, Microsoft fast-follow within E02** (Q-09). E02's exit criterion holds for Google parity; Microsoft ships behind its own flag after Google parity holds. | With D-050 the Microsoft path is a **direct Microsoft Graph adapter** (ticket **E02-04**), not Aurinko-mediated; the "Aurinko supports Microsoft — verify" note in E02/Q-09 is moot. |
| D-044 | **High-ticket approval threshold = $500 default, owner-configurable upward only** (never below the floor), enforced in `isAutonomyAllowed()` and locked by tests like the existing floors (Q-11; completes D-021). | Implementation rides the first ticket that expands autonomous execution on money-adjacent actions (E05-era); until then the value is recorded here as the binding floor. Any config surface is owner/admin-only (D-048). |
| D-045 | **Product analytics: own-database events table first** — RLS-scoped, zero new vendors (Q-12). A hosted vendor is a later, separate evaluation. | Canonical event set stays `14-product-analytics.md`. Instrumentation tickets are cut per epic as their events light up (E01: member events; E03: import events). |
| D-046 | **Calendar is ratified as the seventh sidebar destination** (Q-15 option a). | Resolves contradiction **C-15**: the shipped seven-destination sidebar is now the documented IA. `platform/docs/BUILD_REFERENCE.md` §2 ("Sidebar exactly … six") needs the matching amendment (flagged; performed at the next docs closeout that touches BUILD_REFERENCE). The stale "exactly these six" comment in `app-sidebar.tsx` is cosmetic backlog. |
| D-047 | **Reports live under Numbers & Billing** (Q-16) — no eighth destination until real usage outgrows it. | E08 IA only. Consistent with D-049 (Reports as a top-level item is a *target*, promoted only by a later BUILD_REFERENCE amendment). |
| D-048 | **Member roles are owner / admin / tech** (Q-17). Custom roles deferred. | Binds E01 schema + permission matrix (**E01-01**), role-aware nav (**E01-03**), E04 tech-scoped views (**E04-04**), E07 composer role checks. Floor: money/billing/autonomy-mode changes = owner/admin only; techs see assigned jobs + needed customer context only. |
| D-049 | **Navigation IA: keep the shipped IA through alpha; the founder's 9-item model (Home · Inbox · Calendar · Customers · Sales · Jobs · Gradia · Reports · Settings) is the recorded target, converged per phase** (Q-23 option a): Sales → E03, Jobs → E04, Reports → E08 (with D-047), Gradia → E09, Inbox consolidation → its own queue item when its domains exist. Each promotion is a BUILD_REFERENCE §2 amendment, never a silent addition. | `06-ui-information-architecture.md` already records the target; this makes it binding direction. No empty destinations: a nav item ships only with its domain (written-empty-state + no-dead-controls rules). |

### Stack (founder, 2026-09-01)

| ID | Decision | Notes |
|---|---|---|
| D-050 | **Aurinko is replaced by direct Google (Calendar + Gmail) and Microsoft Graph (Outlook calendar + mail) adapters behind the Gradia-owned `CalendarProvider` and email seams, in Batch 4 (E02).** Aurinko is retired at the end of Batch 4. | Resolves **Q-21** early (pulled forward from "post-E02" to *inside* E02) — the founder stack decision in `program/autorun.md`. Tickets **E02-03** (Google direct), **E02-04** (Microsoft Graph), **E02-06** (cutover + Aurinko retirement). D-029/ADR-002 boundary rule unchanged: provider ids stay in sync/integration records. Existing Aurinko-connected shops reconnect via the owner's ConnectionTile (zero founder touch). Platform-level one-time setup (Google Cloud OAuth client + restricted-scope verification for Gmail; Azure app registration) is a founder precondition recorded in those tickets. `vendors/transitional/aurinko.md`, `vendors/registry.md`, and the two `planned-evaluations/` docs need status updates at the Batch-4 docs closeout (not performed here). Microsoft priority within the batch follows D-043. |
| D-051 | **Alpha date follows the P0 exit gate; no new alpha date is set** (Q-25 option a). The gate is not split and WIP limits are not raised. | `10-roadmap.md` rule 7 and `program/release-calendar.md` read "date follows the gate"; the 2026-08-07 date in root `CLAUDE.md` is historical. Under D-036 the private-beta bar is autorun Batch 5 complete (see D-036 notes). |
| D-052 | **Housecall Pro connector and the Slack approvals surface are deleted entirely in Batch 1** (ticket **CLEANUP-001**): code, flags, tests, routes, env documentation; vendor docs marked removed. Resolves **Q-07** and **Q-19** as "delete". | Amends **D-026** (the surface is removed rather than kept dormant — any future Slack approvals would be a new decision + ADR with shop-bound claims, exactly as D-026 required) and **D-030** (Housecall Pro classification → removed; Jobber unchanged — still optional, Q-20 open). No migration unless a table is HCP/Slack-only; columns left dormant per the additive rule, drops only in a rollback-able file. P3-001 (HCP dependency review) is superseded — its inventory scope executes inside CLEANUP-001. Founder-outbound Slack *ops alerts* (D-042) are unaffected: a webhook URL, not `lib/slack.ts`. |

## Prior locked decisions (imported by reference — still in force)

These pre-date gradia-v2 and remain binding where not superseded above:

- **Pricing & packaging** — Core $20 / Package 2 +$29, credit menu, margin floors (~70%), rollover, fail-closed caps: `_docs/GRADIA_PRICING.md` (locked 2026-06-11, reframed 06-15). Amended by D-003/D-004/D-005 (trial model); **superseded as forward direction by D-031 (2026-07-27, three-tier $99/$149/$249)** — the $20/$29 model remains the accurate description of live billing until Q-22 resolves and the migration ships (contradiction C-14).
- **Agentic principles 1–9** — root `CLAUDE.md` / `_docs/GRADIA_AGENT_SHARPENING_BRIEF.md` (incl. **zero founder-touch per signup**).
- **Design system & IA** — `platform/docs/BUILD_REFERENCE.md` (glass-box redesign, 2026-07-02) + `HOME_REDESIGN_PLAN.md` amendment (2026-07-16).
- **Launch date** — alpha 2026-08-07 (root CLAUDE.md, set 2026-07-08).
- **Positioning/claims discipline** — `_docs/WHAT_GRADIA_DOES.md` (2026-07-16), subject to D-001/D-019/D-028 notes above.

## How to add a decision

1. Open items go to `program/decision-queue.md` with context + options + recommendation.
2. Founder approves (explicitly, in writing) → Organizer records it here with the next D-###.
3. If it is an architecture mechanism (how, not what), record an ADR in `adr/` and link it.
4. If it contradicts an existing doc, add the conflict to `16-document-source-map.md` §Contradictions.

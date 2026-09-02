# Tickets — Index

_Bounded implementation ticket specifications. A Builder implements exactly one ticket at a time, exactly as specced. Scope changes go back to the Organizer, never into the diff. Created 2026-07-25._

## P0 ticket index (epic E00 — Stabilization)

| ID | Title | Epic | Status | Priority | Depends on | High-risk class | File |
|---|---|---|---|---|---|---|---|
| P0-001 | Exposed database credential remediation | E00 | **ready — Sprint 1** | Critical | none | security | `P0-001-exposed-database-credential-remediation.md` |
| P0-002 | CI typecheck, lint, build and integration enforcement | E00 | **done** (2026-07-30, PR #9) | Critical | none | none | `P0-002-ci-enforcement.md` |
| P0-003 | Central appointment conflict service | E00 | **done** (2026-08-06, PR #10, Cursor APPROVE; service inert until P0-004) | High | P0-002 (done) | calendar | `P0-003-central-appointment-conflict-service.md` |
| P0-004 | Conflict enforcement across booking and scheduling paths | E00 | **done** (2026-08-11, PR #12 `3b6d044`; CI green; independent Cursor final review: **merge APPROVE · production enablement NOT READY** — verdict supplied to the Founder outside the PR trail; enforcement dormant behind `NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT`, flag flip gated on founder manual acceptance + P0-004A; merge/review record in the ticket file) | High | P0-003 (done) | calendar | `P0-004-conflict-enforcement-booking-paths.md` |
| P0-004A | Appointment booking atomicity and concurrency | E00 | **done** (2026-08-11, PR #15 `2103943`; CI + real-Postgres concurrency tests green; independent Cursor verdict APPROVE — one BLOCKER found and fixed pre-merge (`p_enforce_conflicts` gating); advisory locking + `pending_action_id` idempotency active regardless of the flag; production conflict enforcement remains OFF; completion record in the ticket file) | High | P0-004 (done) | calendar + database-sensitive | `P0-004A-appointment-booking-atomicity-concurrency.md` (cut at close from issue #13) |
| P0-005 | Webhook event idempotency foundation | E00 | **done** (2026-08-13, PR #17 `e1dedfb`; Cursor APPROVE — no BLOCKER/HIGH; ADR-001 C1/C2/C7 satisfied incl. zero-row founder production duplicate audit; staging manual acceptance still gates full rollout acceptance of the migrations; close record in the ticket file) | High | P0-002 (done) · P0-004A (done) | database-sensitive | `P0-005-webhook-idempotency-foundation.md` |
| P0-005A | provider_events retention and pruning | E00 | **ready — autorun Batch 1, queue item 2** (filed 2026-08-13 per ADR-001 C2; slotted by `../program/autorun.md` 2026-09-01) | Medium | P0-005 (done) | none expected (confirm at slotting) | `P0-005A-provider-events-retention-pruning.md` |
| P0-006 | Twilio inbound replay protection | E00 | **done** (2026-08-14, PR #19 `76847e4`; pre-squash `afb542b` Builder → `89af55c` metering retry-safety fix; CI green — `ci / checks` + `ci-integration / integration` + Vercel/Preview; independent Cursor verdict **APPROVE / safe to merge**, no BLOCKER/HIGH, no review-fix commit; founder real-Twilio staging acceptance completed pre-merge; ADR-001 C3 satisfied for this route; no new migration; close record in the ticket file) | High | P0-005 (done) · P0-005A filed · closeout merge (done) | none | `P0-006-twilio-inbound-replay-protection.md` |
| P0-007 | Vapi transcript and usage replay protection | E00 | **done** (2026-08-14, PR #21 `8a4d4d1`; independent Cursor verdict **APPROVE**, no BLOCKER/HIGH, no review-fix commit; founder acceptance PASSED on isolated local staging incl. post-restart durability replay + production-fallback-guard refusal; ADR-001 C3 + C5 satisfied for the Vapi route; no new migration; close record in the ticket file) | High | P0-005 (done) · P0-006 (done) · closeout merge (done, `def97ab`) | payment (metering) | `P0-007-vapi-transcript-usage-replay-protection.md` |
| P0-008 | Twilio subaccount status callback repair | E00 | **done** (2026-08-25 — merged to `main` in PR #23 `1ea198f`, pre-squash `ffd6e01`; Cursor APPROVE, no BLOCKER/HIGH; founder acceptance PASSED on isolated local staging, both credential classes + full negative-path matrix; the folded-in P0-006-deferred findings dispositioned item-by-item; close record in the ticket file) | Medium | P0-002 (done) · closeout merge (satisfied) | none | `P0-008-twilio-subaccount-status-callback-repair.md` |
| P0-009 | Quote acceptance, lead linkage and expiration repair | E00 | **done** (2026-08-26 — merged to `main` in PR #25 `d3c0e4d`; Builder `829ddfd` → Cursor review-fix `aba1068`; Cursor APPROVE, no BLOCKER, one HIGH found and fixed pre-merge; founder acceptance PASS on the exact reviewed commit `aba1068`; one additive migration (`quote_status = booked`); Q-04 stays open non-blocking; token regeneration stays deferred; close record in the ticket file) | High | P0-002 (done) · closeout merge (satisfied, `eae12a5`) | none declared at spec; shipped one additive migration (recorded at close) | `P0-009-quote-acceptance-lead-linkage-expiration.md` |
| P0-010 | Production environment and error-surface cleanup | E00 | **done** (2026-08-28 — merged to `main` in PR #27 `5d82fa3`; reviewed/accepted tree `618cf41` = Builder `aea2d41` → Cursor review-fix `618cf41`; Cursor **APPROVE**, one HIGH (AI-lead 1-credit metering) fixed pre-merge; founder acceptance **PASS** on the exact reviewed commit incl. the recorded production billing exception — `STRIPE_PRICE_*` intentionally absent from Production, checkout fail-closed until P0-013; close record in the ticket file) | Medium | P0-002 (done) · closeout merge (satisfied, `e70b287`) | none | `P0-010-production-env-error-surface-cleanup.md` |
| P0-011 | Service-role tenant-scoping review and helper design | E00 | **done** (2026-09-01 — merged to `main` in PR #29, squash `e02c81a`; Builder `34c83fa` → Cursor review-fix accepted tree `3446fe2`; Cursor **APPROVE AFTER LOCAL FIX** — two HIGH found and fixed pre-merge (forShop update re-tenanting; Connect events on the platform billing path); founder acceptance **PASS** on the exact accepted SHA; C-2/L-1/M-2 closed, L-2 verified P0-009-fixed; full 31-file sweep table + **ADR-003 founder-APPROVED** in the close record; no migration; TS-1…TS-6 remain future work) | High | P0-002 (done) | tenancy | `P0-011-service-role-tenant-scoping-review.md` |
| P0-012 | Monitoring alert delivery and incident hooks | E00 | **ready — autorun Batch 1, queue item 3** (promoted 2026-09-01 at the P0-011 close per backlog order; **Q-08 resolved 2026-09-01 → D-042: founder Slack ops channel + SMS for SEV-0/1** — the seam ships even if the webhook is not yet configured, and the destination is an outbound webhook independent of `lib/slack.ts`, which CLEANUP-001 deletes; new consumers waiting on it: `TENANT_SCOPE_VIOLATION` signals (P0-011) + the P0-008 M1 credential observability follow-up. Enters in-progress when the Organizer slots it and a Builder is recorded on the WIP board) | Medium | P0-002 (done); decision Q-08 (alert destination — config only) | none | `P0-012-monitoring-alert-delivery-incident-hooks.md` |
| P0-013 | Production billing model alignment (D-031 three-tier implementation) | E00 | **draft → ready at slotting — autorun Batch 1, queue item 4 (FULL ticket; founder + Cursor acceptance before merge; Stripe live prices created by the founder only).** Q-22 resolved 2026-08-28 (D-034 tier contents + D-035 trial). The ticket file's status line still reads decision-gated: the Organizer reconciles it against D-034/D-035 and the autorun row (tier column, per-tier PLAN, entitlements, webhook tier mapping, three-tier UI, test locks, Stripe `trial_period_days=14` interim, existing pilot shops grandfathered as `core`) before Batch 1 reaches item 4. **Launch-blocking before live paid billing activation** — `STRIPE_PRICE_*` stays unset in Production until implemented, reviewed, accepted, ready | High | D-034/D-035 (recorded) · P0-010 (done) · Batch 1 items 1–3d committed on `auto/batch-1` | payments + database-sensitive | `P0-013-production-billing-model-alignment.md` |

## Future-phase tickets (specced early)

| ID | Title | Epic | Status | Priority | Depends on | High-risk class | File |
|---|---|---|---|---|---|---|---|
| P3-001 | Housecall Pro dependency review | E03 | **superseded 2026-09-01 by D-052 / CLEANUP-001** (Q-19 resolved as "delete"; the review's inventory scope 1–7 executes inside CLEANUP-001 step 1; autorun Batch 3 item 14 closes as a one-line docs tombstone in the ticket file at the Batch-3 closeout — no build work) | — | — | none | `P3-001-housecallpro-dependency-review.md` |

## Autorun batch tickets (cut 2026-09-01 by the Organizer — `../program/autorun.md` Batches 1–5)

_Queue order is binding (autorun never skips or reorders). Every ticket below uses the full 19-section template. "Founder acceptance" follows the autorun tables. Statuses: **ready** = may start when its batch opens; **draft — batch-gated** = complete spec, enters only when its batch opens and the prior item is committed; **draft — decision-gated** = a founder decision is still missing (Builder HARD STOPs per autorun rule 5). Decisions D-036…D-052 are recorded in `../11-decision-log.md` Batch 5._

### Batch 1 — finish P0 · `auto/batch-1` (order: 1 PROD-CONFIG-AUDIT · 2 P0-005A · 3 P0-012 · 3b CLEANUP-001 · 3c UX-001 · 3d PERF-001 · 4 P0-013)

| ID | Title | Epic | Status | Priority | Depends on | High-risk class | Founder acceptance | File |
|---|---|---|---|---|---|---|---|---|
| PROD-CONFIG-AUDIT | Production configuration audit (docs-only output; incl. the D-036 ICP amendment to `ui/design-north-star.md` + `ui/navigation-model.md`) | E00 | **ready** — item 1 | Medium | none | none | no | `PROD-CONFIG-AUDIT-production-config-audit.md` |
| CLEANUP-001 | Remove the Housecall Pro connector and the Slack approvals surface (D-052; supersedes P3-001; closes ADR-003 TS-6 by removal) | E00 | **ready** — item 3b | Medium | P0-012 (alert seam carries payment notices + reconciliation drift) · D-052 | standard | no | `CLEANUP-001-remove-housecall-pro-and-slack-approvals.md` |
| UX-001 | Truthful state + polish pass (connection truth root-cause, stale copy, Stripe-pattern inline help, required states) | E00 | **draft — precondition-gated** — item 3c (founder adds Stripe references + adopt/reject lists to `ui/reference-board.md` first) | High | CLEANUP-001 · PROD-CONFIG-AUDIT | standard | founder visual review on Preview | `UX-001-truthful-state-and-polish-pass.md` |
| PERF-001 | Response-time audit and fixes (measure → fix top causes → re-measure; p75 TTFB < 600 ms on five routes; Approve < 100 ms) | E00 | **draft — batch-gated** — item 3d | Medium-high | UX-001 · PROD-CONFIG-AUDIT | standard (additive indexes = DB slot) | no | `PERF-001-response-time-audit-and-fixes.md` |

### Batch 2 — tenancy + LLM seam (E01) · `auto/batch-2`

| ID | Title | Epic | Status | Priority | Depends on | High-risk class | Founder acceptance | File |
|---|---|---|---|---|---|---|---|---|
| E01-01 | Members, roles and invitations: schema, backfill, RLS policy indirection (owner/admin/tech — D-048) | E01 | **draft — batch-gated** — item 5 | Critical | Batch 1 merged (P0-013 accepted) · P0-011 · D-018/D-048 | tenancy + database-sensitive | YES | `E01-01-members-roles-invitations-schema-rls.md` |
| E01-02 | `forShop()` rollout across service-role paths (ADR-003 TS-1…TS-6) | E01 | **draft — batch-gated** — item 6 | High | E01-01 · ADR-003 accepted (founder-approved 2026-09-01) · CLEANUP-001 (TS-6) | tenancy | YES | `E01-02-forshop-rollout-ts1-ts6.md` |
| E01-03 | Invitation flow (send/accept/revoke), role checks at action boundaries, role-aware navigation | E01 | **draft — batch-gated** — item 7 | High | E01-01 · E01-02 · D-048 | standard | no | `E01-03-invitation-flow-ui-role-aware-nav.md` |
| E01-04 | `ModelProvider` seam / AI gateway (D-029): one `llm.ts`, registry, retries/timeouts, per-call cost + latency | E01 | **draft — batch-gated** — item 8 | High | E01-03 · P0-012 · D-029 | standard (one additive `llm_calls` migration) | no | `E01-04-model-provider-seam-ai-gateway.md` |
| E01-05 | Eval gating in CI on prompt-file change + nightly eval run with alerting | E01 | **draft — decision-gated on Q-06** — item 9 (the autorun row assumes "both"; Q-06 is NOT in the decision log — founder approval required before the Builder reaches this item, else HARD STOP) | High | **Q-06 (founder)** · E01-04 · P0-012 · founder CI secret + branch protection | standard | no | `E01-05-eval-gating-ci-prompt-change.md` |

### Batch 3 — CRM completion + imports (E03) · `auto/batch-3`

| ID | Title | Epic | Status | Priority | Depends on | High-risk class | Founder acceptance | File |
|---|---|---|---|---|---|---|---|---|
| E03-01 | Direct customer and vehicle create/edit, customer export, tags UI, DB type codegen (D-040) | E03 | **draft — batch-gated** — item 10 | High | Batch 2 merged · P0-009 · D-040 | database-sensitive | no | `E03-01-direct-customer-vehicle-create-edit-export.md` |
| E03-02 | Structured import wizard (D-022): CSV + Jobber export + Urable export → staging → mapping → preview → commit → rollback | E03 | **draft — batch-gated** — item 11 (founder supplies real export files first) | Critical | E03-01 · E01-02/03 · D-022/D-035/D-052 | database-sensitive | YES (real export files) | `E03-02-structured-import-wizard.md` |
| E03-03 | Lifecycle derivation wired (180/365 — D-039) and win-back audiences fueled by lifecycle | E03 | **draft — batch-gated** — item 12 | High | E03-02 · E01-02 · P0-012 · D-039 | standard | no | `E03-03-lifecycle-wiring-win-back-fuel.md` |
| E03-04 | Single-truth pass: retire `leads.status`, one activity timestamp, one lifecycle vocabulary, flat vehicle read-cutover, quote↔lead direction (no drops) | E03 | **draft — batch-gated** — item 13 (E03 exit) | High | E03-03 · E03-01 · P0-009 | database-sensitive | no (Reviewer falsification pass) | `E03-04-retire-leads-status-single-truth-pass.md` |
| P3-001 | Housecall Pro dependency review | E03 | **superseded** — item 14 closes as a docs tombstone (D-052 / CLEANUP-001) | — | — | none | no | `P3-001-housecallpro-dependency-review.md` |

### Batch 4 — native calendar (E02) · `auto/batch-4`

| ID | Title | Epic | Status | Priority | Depends on | High-risk class | Founder acceptance | File |
|---|---|---|---|---|---|---|---|---|
| E02-01 | Availability engine (read-only): open-slot computation, buffers/travel/multi-day inputs, `/calendar` shading, voice alternatives | E02 | **draft — batch-gated** — item 15 | High | Batch 3 merged · E01-01 · D-013/D-015/D-016/D-046 | calendar (read-only leg) | YES | `E02-01-availability-engine-read-only.md` |
| E02-02 | Native appointments as source of truth (D-013): `CalendarProvider` + email seams, `shop_connections`, sync state, `external_busy_blocks`, authority inversion behind flag (ADR-005 in-ticket) | E02 | **draft — batch-gated** — item 16 | High | E02-01 · E01-01 · P0-004A · D-029/D-050 | calendar + database-sensitive | YES | `E02-02-native-appointments-source-of-truth.md` |
| E02-03 | Direct Google Calendar + Gmail adapters (D-050) — OAuth (two consents), mirror CRUD, incremental busy sync, in-thread mail, `provider_events` idempotency | E02 | **draft — batch-gated** — item 17 (founder: Google Cloud OAuth client + Preview env) | High | E02-02 · D-050/D-023/D-043 | calendar + security | YES | `E02-03-google-calendar-gmail-direct-adapters.md` |
| E02-04 | Microsoft Graph adapter (Outlook calendar + mail) behind the same seams (D-043 fast-follow, flag off at merge) | E02 | **draft — batch-gated** — item 18 (founder: Azure app registration + Preview env) | Medium-high | E02-03 · D-014/D-043/D-050 | calendar + security | YES | `E02-04-microsoft-graph-adapter.md` |
| E02-05 | Conflict enforcement default-on on the native model (D-015/D-016); `external_busy_blocks` as the conflict source; block-time mirroring; production enablement | E02 | **draft — batch-gated** — item 19 | High | E02-04 · P0-004A · D-015/D-016 | calendar | YES (production enablement decision) | `E02-05-conflict-enforcement-default-on.md` |
| E02-06 | Booking without an external calendar: authority cutover, Aurinko retirement (D-050), reconnect migration, calendar view parity (day/month/agenda) | E02 | **draft — batch-gated** — item 20 (E02 exit; founder: Production `GOOGLE_OAUTH_*` before deploy; `AURINKO_*` removal after the reconnect window) | High | E02-05 · E02-03 · D-013/D-050/D-030/D-046 | calendar + database-sensitive + security | YES | `E02-06-booking-without-external-calendar-cutover-aurinko-retirement.md` |

### Batch 5 — jobs & team ops (E04) · `auto/batch-5`

| ID | Title | Epic | Status | Priority | Depends on | High-risk class | Founder acceptance | File |
|---|---|---|---|---|---|---|---|---|
| E04-01 | Work-order model: ADR-004 (jobs vs appointments split — decided in-ticket before schema) + additive schema for assignments, checklists, inspection, signatures, pickup/drop-off; photo MIME allow-list | E04 | **draft — batch-gated + ADR-gated** — item 20 | Critical | Batch 4 merged · E01-01/03 · E03-01/04 · D-036/D-018/D-048/D-017 | database-sensitive | YES (incl. ADR-004 acceptance) | `E04-01-work-order-model-adr-and-schema.md` |
| E04-02 | Job assignments: assign/unassign, jobs board (inside Calendar per `06`), in-app assignee notifications, CRM push fields if supported | E04 | **draft — batch-gated** — item 21 | High | E04-01 · E01-03 · E02-06 · D-048/D-049 | standard | YES | `E04-02-job-assignments-board-notifications.md` |
| E04-03 | Checklists: per-service templates (seeded), per-job instances, QC completion gate, pre/post inspection with photos | E04 | **draft — batch-gated** — item 22 | High | E04-02 · E03-01 | standard | YES | `E04-03-checklists-templates-instances-inspection-qc.md` |
| E04-04 | Tech-scoped views: My day, role-scoped job detail v2 (crew notes, signatures, pickup/drop-off), work-order share view, permission teeth (D-048) | E04 | **draft — batch-gated** — item 23 | High | E04-03 · E04-02 · E01-03 · ADR-004 | standard (tenancy if ADR-004 chose RLS-level tech scoping) | YES | `E04-04-tech-scoped-views-my-day-job-detail-v2-signatures-share.md` |
| E04-05 | Team scheduling: per-member hours/capacity, per-resource availability, calendar member lanes, assignment rules under the serialized lock | E04 | **draft — batch-gated** — item 24 (E04 exit: a 3-person shop runs its day) | High | E04-04 · E04-02 · E02-01/02/05 · D-015/D-016 | calendar + database-sensitive | YES (E04 exit) | `E04-05-team-scheduling-per-member-availability.md` |

**Not cut (recorded so nothing drops):** E01 `shop_connections` credentials slice → delivered by E02-02; E01 trial-model build → P0-013 + D-035; E01-01C production cutover of membership-only policies → cut by the Organizer when the dual-accept window closes; E03 Google Contacts fast-follow, quote public-token regeneration/expiry hardening, `advanceQuoteFollowUps` wiring → post-Batch-3 backlog; E04 annex deferrals (warranty → E06-era, rework → E05-era, profitability → E08) unchanged; Batch 6+ (E07/E05/E08/E09) cut when Batch 5 closes.

> **P0-002 completed 2026-07-30** (PR #9, reviewed APPROVE): the `ready-after-P0-002` review gate is now satisfied — tickets carrying that label may enter review once slotted, subject to WIP limits and their own listed decisions (Q-04, Q-08). Labels are left in place per-row until each ticket is actually slotted.

Statuses (complete vocabulary — no other status labels are valid): **draft** (spec exists, prerequisites unresolved) · **ready** (dependencies + decisions resolved, may be picked up) · **ready-after-P0-002** (defined 2026-07-27: the spec is complete and no founder decision blocks it; the ticket may be slotted for implementation when WIP allows, but it may not enter **review** — and therefore cannot merge or reach done — until P0-002 is complete, per the global review gate in `../10-roadmap.md` sequencing rule 2. For **P0-003 only** the gate is stronger: implementation itself may not start before P0-002 is done) · **in-progress** (one Builder assigned, recorded in `../program/work-in-progress.md`) · **in-review** (one Reviewer assigned) · **done** (DoD met, evidence recorded) · **blocked** (recorded in `../program/blocked.md` with reason).

## Ticket template (added 2026-07-27 — the "full ticket template" other docs reference)

Every ticket file MUST contain the following sections, in this order. The structure is derived from the existing P0 tickets, which already comply. A ticket missing any required section is **draft** by definition, regardless of its status line — an Organizer cannot mark it ready, and a Builder cannot pick it up.

| # | Section | Required content |
|---|---|---|
| 1 | **Ticket ID** / **Epic** | ID + owning epic |
| 2 | **Status** | One label from the status vocabulary above, plus any gate note |
| 3 | **Priority** | Phase + severity + one-line why |
| 4 | **Objective** / **User outcome** | What changes and who feels it |
| 5 | **Current code references** | Audit/file:line evidence — claims cite code, never vibes |
| 6 | **Exact scope** | Numbered, bounded list of the work |
| 7 | **Explicit non-goals** | What this ticket deliberately does NOT do |
| 8 | **Dependencies** | Ticket dependencies + binding decisions (D-###/Q-##) — "none" must be stated, not implied |
| 9 | **Expected modules affected** | File-level blast radius |
| 10 | **Database impact** / **Migration impact** | Schema/migration statement — "None" must be explicit (drives the DB-sensitive WIP slot) |
| 11 | **API / UI / Permission impact** | Contract and surface changes, incl. required UI states |
| 12 | **Tenant-isolation / Security impact** | Scoping requirements + at least one isolation test where service-role paths are touched |
| 13 | **Idempotency / Observability / Analytics requirements** | Replay behavior, logging, events ("none" stated explicitly) |
| 14 | **Feature flag** | Flag name, or "None — fix" with justification (D-027) |
| 15 | **Automated tests** | Test classes required (unit / integration / tenant-isolation / failure-path) |
| 16 | **Manual acceptance procedure** | Numbered steps; every step must be executable by the Builder or explicitly assigned to a named human — a step nobody owns is a spec defect |
| 17 | **Failure cases** | What breaks and what the behavior must be |
| 18 | **Rollback strategy** | How to unwind, incl. migration/in-flight-data notes |
| 19 | **Definition of done** | `../12-definition-of-done.md` plus ticket-specific evidence |

## Lifecycle

```
draft ──▶ ready ──▶ in-progress ──▶ in-review ──▶ done
              ▲            │              │
              └── blocked ◀┴──────────────┘  (reason + unblock condition in program/blocked.md)
```

- The Organizer moves tickets to **ready** only when every dependency is done and every referenced decision is Approved in `../11-decision-log.md`.
- A Builder moves a ticket to **in-progress** by recording it in `../program/work-in-progress.md` — never by starting silently.
- **in-review** requires the Builder's completion report (per `../agent-briefs/claude-builder.md`) attached to the ticket file as an appendix or linked run note.
- **done** requires the Reviewer's sign-off against `../12-definition-of-done.md` plus the ticket's own DoD section.

## WIP limits (hard rules — enforced in `../program/work-in-progress.md`)

1. Maximum **two** tickets in-progress at once, total.
2. Maximum **one** database-sensitive ticket (touches migrations/schema) in-progress at a time.
3. Maximum **one** high-risk ticket (payment, tenancy, or calendar class) in-progress at a time.
4. **One Builder and one Reviewer per ticket** — never the same agent/session.
5. **No ticket enters implementation until its dependencies are done and its decisions are resolved.** A ticket that discovers an unresolved founder decision mid-flight stops and moves to blocked — the Builder never decides silently.

## Sprint 1 selection

Per `../program/current-sprint.md`: **P0-001 and P0-002 only.** P0-003 may move to implementation only after P0-002 is complete (a conflict service without CI that can fail is unreviewable). Everything else queues.

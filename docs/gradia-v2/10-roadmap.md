# 10 — Roadmap (P0–P10)

_The one ordered roadmap. Supersedes, as the ordering authority: audit doc 12's time-boxed plan, `GRADIA_MVP_PLAN.md` §4 phases (complete), `IMPLEMENTATION_PLAN.md`, and the P0–P9 queue in the sharpening/telephony/recovery/CRM specs (those remain the feature-content sources). Epics live in `epics/`; tickets in `tickets/`; live sprint state in `program/`._

Phases are sequential by default; a later phase may start only when its dependencies (not the whole prior phase) are done. The 2026-08-07 alpha sits inside P0.

| Phase | Name | Epic | Objective (one line) | Exit criterion |
|---|---|---|---|---|
| **P0** | Stabilization | E00 | Fix what makes the current platform leaky: credential leak, CI depth, conflicts, idempotency, broken seams, alerting. | All 12 P0 tickets done; audit re-scores security ≥7 and reliability ≥7 (re-score = a non-Builder session re-runs audit docs 06/10 scoring with cited evidence — never self-certified by the implementing session); alpha shippable (date policy: Q-25). |
| **P1** | Organization, tenancy and backend foundation | E01 | Members/roles/invitations, service-role scoping mechanism, `shops` god-table split direction, LLM seam. | A second user can be invited with a role; tenant isolation is mechanism, not discipline; schema expansion unblocked (D-018). |
| **P2** | Native calendar and availability | E02 | Gradia DB becomes appointment source of truth (D-013); availability engine; Google + Microsoft as synced mirrors (D-014). | Booking works with no external calendar connected; conflicts hard-block automation (D-015), warn-and-override HITL (D-016). |
| **P3** | CRM and import completion | E03 | Direct customer create/edit/export, VIN/vehicle completion, single-truth pass (retire `leads.status`, flat vehicle cols), structured CRM import wizard meeting D-022, lifecycle wiring; Housecall Pro dependency review (P3-001, Q-19). | An owner can migrate from Jobber/HCP/CSV with staging→preview→rollback; CRM usable fully AI-off (D-002). |
| **P4** | Jobs and team operations | E04 | Work orders, assignments, checklists, job scheduling for teams (requires P1 roles). | A 3-person shop can run its day in Gradia. |
| **P5** | Invoices and payments | E05 | Stripe Connect (D-019): deposits on quotes, invoices on jobs, payment records immutable (D-024). | Quote deposit + job invoice collected end-to-end in test mode; ledgers replay-safe. |
| **P6** | Recurring jobs, memberships and fleets | E06 | Three separate domains (D-017) on top of P2 calendar + P5 payments. | Each domain has its own model, UI, and billing hooks; maintenance schedules finally consumed. |
| **P7** | Communication parity | E07 | Email in the unified inbox, in-thread reply composer, outbound email threading, delivery tracking, template library. | Conversations = voice + SMS + email, read AND write, with delivery status. |
| **P8** | Reporting and responsive PWA | E08 | Funnel/campaign analytics, daily brief, exportable reports; installable responsive PWA (D-020). | Owner runs the business from a phone browser; core reports exist and trace to rows. |
| **P9** | Gradia differentiation | E09 | Opportunity Engine v1, earned-autonomy graduation UX, memory correction, voice quote verifier, prompt-injection hardening. | The "money on the table" surface ships; autonomy graduation is evidence-based and visible. |
| **P10** | Scale and production hardening | E10 | Outbox/queue, soft delete + data export/deletion (GDPR-shaped), structured logging/health/tracing, E2E suite, performance passes. | Measured headroom for 10× shops; SEV runbooks exercised. |

## Sequencing rules

1. **P0-001 (credential rotation) precedes everything** — including the rest of P0.
2. **P0-002 (CI enforcement) precedes any other implementation ticket** entering review (a reviewer needs CI that can fail).
3. **P1 (tenancy) precedes major schema expansion** (D-018): E04/E05/E06 tables are not created until members/roles land.
4. **P2 precedes P6** (recurring/memberships/fleets book against native availability) and precedes any online-booking surface.
5. **P5 precedes P6 memberships** (membership billing) and the quote-deposit flow in `ui/flows/quote-to-deposit.md`.
6. High-risk WIP limit: only one of {payments, tenancy, calendar} may be in active implementation at a time (see `program/work-in-progress.md`).
7. Alpha (2026-08-07) requires **P0 complete** — nothing from P1+ is an alpha blocker. **Feasibility note (2026-07-27):** 12 tickets at max-2 WIP in the remaining window is not plausible; the miss policy (move the date vs define an alpha-minimum subset) is a founder decision — `program/decision-queue.md` Q-25. Do not silently relax the gate.
8. **P4 (stable jobs) precedes advanced reporting** — E08's job-dependent reports (job profitability, employee productivity, labor utilization) require E04 done; E08 may start earlier only for reports whose source domains exist (added 2026-07-27; E04 added to E08 dependencies).
9. **Reliable event processing precedes autonomy expansion** — E09 requires the P0 idempotency chain (P0-005/006/007) and P0-012 alerting complete. The E10 outbox is *not* the bar (the founder-approved order runs P9 before P10), but any E09 ticket that expands autonomous execution on a webhook/cron-driven path must state its idempotency basis explicitly (added 2026-07-27; dependencies added to E09).

## What this roadmap deliberately rejects or delays

- **LangGraph / agent-framework migration** — rejected (D-010).
- **Microservices split** — rejected without measured need (D-008).
- **Native mobile apps** — delayed behind PWA (D-020).
- **Instagram/Facebook channels** — remain out (code already removed; WHAT_GRADIA_DOES §3).
- **Photo-based quoting (Estimator), social posting (Marketer), Gradia Pay/BNPL, Gradia Vision** — historical PROJECT_BRIEF ambitions; not scheduled in P0–P10.
- **Slack approvals revival** — blocked by D-026 until tenant authorization is rebuilt; not scheduled.
- **Text-to-SQL BI** — rejected; fixed query builders stay (audit doc 06 confirms safer path in code).
- **Direct Google/Microsoft calendar integrations** — delayed until after E02 stabilizes `CalendarProvider` and the native appointment system (Q-21); Aurinko stays transitional meanwhile (D-030).
- **Housecall Pro bidirectional sync** — rejected without paying-customer demand (Q-19, D-030); import-only vs removal decided after P3-001.
- **Square / POS** — delayed to a post-E05 evaluation (`vendors/planned-evaluations/payment-pos.md`); never a replacement for Stripe Connect (D-019).

## Cross-references

- Capability → phase mapping: `04-capability-map.md`
- Dependency detail: `program/dependency-map.md`
- Dates/releases: `program/release-calendar.md` + `13-release-strategy.md`
- Audit evidence for every P0 item: `platform/docs/audit/` docs 06, 10, 11, 12

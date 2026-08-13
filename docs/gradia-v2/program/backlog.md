# Program — Backlog

_Created 2026-07-25 by the Organizer. Ordered backlog below the two live sprints. Ticketed items reference `../tickets/`; epic-level entries are NOT yet ticketed — the Organizer cuts tickets per phase as each epic approaches. Order within a band is priority order._

## Band 1 — Remaining P0 tickets (E00, after Sprint 2)

| # | Ticket | Title | Notes |
|---|---|---|---|
| 1 | P0-008 | Twilio subaccount status callback repair | Small, isolated bug fix (`api/twilio/sms/status/route.ts:75-83`); can slot in whenever a standard slot frees. |
| 2 | P0-009 | Quote acceptance, lead linkage and expiration repair | Money-path correctness; expired-quote visitor UX copy depends on Q-04 (minimal honest state ships regardless). |
| 3 | P0-010 | Production environment and error-surface cleanup | Batch: env vars, `error.tsx`/`not-found.tsx`, stale `revalidatePath`, `agents.ts` copy, orphans, M-1 auth gate. |
| 4 | P0-011 | Service-role tenant-scoping review and helper design | Review + `forShop()` design; includes the C-2 shop-binding fix. Its design output feeds E01. |
| 5 | P0-012 | Monitoring alert delivery and incident hooks | Delivery seam builds now; final destination config waits on Q-08 (see `blocked.md`). |

## Band 2 — Deferred P0-adjacent items (split out, not lost)

- **P0-004A — Appointment booking atomicity and concurrency** — **done 2026-08-11** (merged PR #15 `2103943`; Cursor APPROVE; completion record in `../tickets/P0-004A-appointment-booking-atomicity-concurrency.md`). Closed the false-executed, duplicate/replay, partial-ordering, and check→insert concurrency gaps; the enablement pre-condition it carried is satisfied (founder manual QA remains the last gate). Its recorded follow-ups now live in this band:
  1. Move owner-direct override audit/telemetry after successful serialized persistence.
  2. Stronger owner-direct retry/idempotency for drag-reschedule and block-time.
  3. Pin the `write_appointment_serialized` RPC `search_path`.
  4. Address external-first cancellation ordering.
  5. Calendar-sync reconciliation/outbox mechanism (relates to E10 outbox/queue).
- **Quote public-token hardening** (audit L-3: `randomBytes` + expiry + rate limit on `/q/[token]`) — rate-limit rides in P0-009; token regeneration deferred to an E03-era ticket.
- **Ledger RLS tightening** (`usage_events` / `payments` / `shop_metrics` → SELECT-only, matching `credit_grants`; D-024) — **resolved 2026-08-13: absorbed into P0-005** (migration `20260812130000_ledger_rls_select_only.sql`, merged PR #17); no separate ticket needed.
- **P0-005 follow-ups (recorded at its 2026-08-13 close; Organizer sequences):** **P0-005A** provider_events retention/pruning (own ticket, filed — ADR-001 C2); reminder/confirmation duplicate approval-**card** staging race (duplicate external send already protected by the `automation_runs` unique); extend `usage_events` uniqueness to `outreach_draft` once historical vendor_ref compatibility permits (ADR-001 C6 time-box); provider_events metadata/attempts bounds (later hardening — optional fold-in to P0-005A); transient local Supabase/PostgREST integration-test 502 flakiness tracked as test-infra hygiene; staging manual acceptance run before the P0-005 migrations are considered fully rollout-accepted (steps in the ticket's close record). ADR-001 C3/C4/C5 ride inside the P0-006/P0-007/Aurinko ticket scopes, not here.
- **Live-contract verification runs** — first real A2P registration, Housecall Pro against a live account, end-to-end CSV recovery smoke. Founder-driven (see `blocked.md`); runbooks exist in `platform/docs/*-go-live.md`.
- **home-redesign branch Phase 5 verify + merge** — pre-alpha; owned outside the ticket flow (see `release-calendar.md`).

## Band 3 — Epic-level entries (not yet ticketed; Organizer tickets per phase)

| Epic | Phase | Headline work items |
|---|---|---|
| E01 Organization, tenancy and backend foundation | P1 | Members/roles/invitations tables + policy indirection; `requireShop` rewrite; `forShop()` mechanism (from P0-011 design); `shops` god-table split direction; LLM provider seam + retries/timeouts; eval CI gating (Q-06); trial model build (blocked on Q-13 numbers). |
| E02 Native calendar and availability | P2 | Gradia DB as appointment source of truth (D-013); availability engine on the P0-003 service; remove hard Aurinko dependency (`approvals.ts:686`); Google + Microsoft sync (Q-09 priority); online-booking groundwork. |
| E03 CRM and import completion | P3 | Direct customer create/edit/export (Q-03); VIN/trim + per-vehicle history; single-truth pass (retire `leads.status`, flat vehicle cols, three timestamps); structured import wizard to the D-022 bar; wire `lifecycle.ts` (blocked on Q-02); DB type codegen; **P3-001 Housecall Pro dependency review** (already specced — feeds Q-19: import-only vs removal). |
| E04 Jobs and team operations | P4 | Work orders, assignments, checklists, team scheduling (requires E01 roles). |
| E05 Invoices and payments | P5 | Stripe Connect re-enable (D-019); quote deposits; job invoices; immutable payment records (D-024). |
| E06 Recurring jobs, memberships and fleets | P6 | Three separate domains (D-017); consume `maintenance_schedule`; membership billing on E05. |
| E07 Communication parity | P7 | Email in unified inbox + in-thread composer; outbound threading (`aurinko.ts:356`); classifier failure-polarity fix; delivery tracking; template library; operator quick-reply policy (Q-05). |
| E08 Reporting and responsive PWA | P8 | Funnel/campaign analytics; daily brief (ROI-receipt machinery); exports; installable PWA (D-020). |
| E09 Gradia differentiation | P9 | Opportunity Engine v1; autonomy graduation UX (`trust.ts`); memory correction; voice quote verifier; prompt-injection hardening + injection eval suite. |
| E10 Scale and production hardening | P10 | Outbox/queue; soft delete + GDPR export/deletion; structured logging + health + tracing; Playwright E2E; perf passes; `rate_limits` pruning. |

## Band 4 — Cleanup items folded into P0-010 (tracked here so nothing drops)

From audit doc 08's prioritized list — all inside P0-010's scope unless noted:

1. Fix the four stale `revalidatePath` targets (`actions/custom-agents.ts`, `actions/autonomy.ts`, `actions/recovery.ts`, `actions/approvals.ts`).
2. Add `error.tsx` (at minimum at `(dashboard)/` level) + `not-found.tsx`.
3. Rewrite `agents.ts` catalog copy (Slack → in-app; `/chat` → `/conversations`).
4. Delete the seven orphaned modules + the dead `askGradiaPage` flag.
5. Add missing `loading.tsx` (customers, `/calendar`, `/receptionist`, `/settings`).
6. Replace raw amber classes with `--status-warning` tokens.
7. Housecall Pro live-endpoint verification — **not** P0-010; lives in Band 2 (founder).
8. Root-clutter sweep after home-redesign merges — rides with archival approval Q-10.

## Rules

- Nothing here enters implementation without a ticket spec meeting the `../tickets/README.md` template and the entry conditions in `work-in-progress.md`.
- The Organizer re-orders this file; Builders never pull from it directly.

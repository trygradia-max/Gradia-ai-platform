# Program — Backlog

_Created 2026-07-25 by the Organizer. Ordered backlog below the two live sprints. Ticketed items reference `../tickets/`; epic-level entries are NOT yet ticketed — the Organizer cuts tickets per phase as each epic approaches. Order within a band is priority order._

## Band 1 — Remaining P0 tickets (E00, after Sprint 2)

| # | Ticket | Title | Notes |
|---|---|---|---|
| 1 | P0-012 | Monitoring alert delivery and incident hooks | **Next implementation position as of the 2026-09-01 P0-011 close** — ready. Delivery seam builds now; final destination config waits on Q-08 (see `blocked.md`). Queued consumers: P0-011's `TENANT_SCOPE_VIOLATION` structured signal; P0-008's M1 credential-observability follow-up. |
| 2 | P0-013 | Production billing model alignment (D-031 three-tier implementation) | **Draft — decision-gated on Q-22** (founder tier decisions; `blocked.md`). **Launch-blocking before live paid billing activation** — `STRIPE_PRICE_*` stays unset in Production (checkout fail-closed, proven at the P0-010 acceptance) until it lands. Payments + database-sensitive risk classes. |

(P0-011 — Service-role tenant-scoping review and helper design — **done 2026-09-01**, merged PR #29 squash `e02c81a` (Builder `34c83fa` → Cursor review-fix `3446fe2`); Cursor APPROVE AFTER LOCAL FIX with two HIGH fixed pre-merge; founder acceptance PASS; ADR-003 founder-approved; left Band 1 — its follow-ups are in Band 2 below. P0-010 — done 2026-08-28, merged PR #27 `5d82fa3`, reviewed tree `618cf41`, Cursor APPROVE with one HIGH fixed pre-merge, founder acceptance PASS incl. the recorded production billing exception; Band 4 items 1–6 shipped with it, with the Builder deviations recorded in its close record. P0-009 — done 2026-08-26, merged PR #25 `d3c0e4d`; close record in `../tickets/P0-009-quote-acceptance-lead-linkage-expiration.md`. P0-008 — done 2026-08-25, PR #23 `1ea198f`; close record and Band 2 follow-ups likewise.)

## Band 2 — Deferred P0-adjacent items (split out, not lost)

- **P0-004A — Appointment booking atomicity and concurrency** — **done 2026-08-11** (merged PR #15 `2103943`; Cursor APPROVE; completion record in `../tickets/P0-004A-appointment-booking-atomicity-concurrency.md`). Closed the false-executed, duplicate/replay, partial-ordering, and check→insert concurrency gaps; the enablement pre-condition it carried is satisfied (founder manual QA remains the last gate). Its recorded follow-ups now live in this band:
  1. Move owner-direct override audit/telemetry after successful serialized persistence.
  2. Stronger owner-direct retry/idempotency for drag-reschedule and block-time.
  3. Pin the `write_appointment_serialized` RPC `search_path`.
  4. Address external-first cancellation ordering.
  5. Calendar-sync reconciliation/outbox mechanism (relates to E10 outbox/queue).
- **Quote public-token hardening** (audit L-3: `randomBytes` + expiry + rate limit on `/q/[token]`) — **rate-limit + length-check parity shipped 2026-08-26 in P0-009** (PR #25; shop-keyed `quote_response` bucket, fail-open on limiter infrastructure failure); token regeneration (`randomBytes` + token expiry) remains deferred to an E03-era ticket.
- **P0-009 follow-ups (recorded at its 2026-08-26 close; Organizer sequences):**
  1. **M-1 — acceptance-side reconciliation:** a narrow crash window remains between the atomic quote → `accepted` claim and the `pending_actions` insert — if the process dies inside it, a retry may echo `accepted` without staging the requested booking and without a reconciliation marker. Cursor-recorded MEDIUM residual, outside the ticket's required idempotency scope (which covered the executor/replay side); not a merge blocker. Add acceptance-side reconciliation so that window heals like the executor side does.
  2. **L-1 — shop-local `valid_until` expiry:** expiry currently binds at end of UTC day; potential local-midnight mismatch for non-UTC shops. Track shop-local expiry once shop timezone is available.
  3. **L-3 — per-token rate-limit sub-bucket:** the per-shop `quote_response` bucket can be exhausted for ~1 minute by someone holding a valid token (accepted pilot residual). Consider a per-token sub-bucket only if pilots show abuse.
  4. **L-2 — accept-race `bookingStaged:false` echo:** cosmetic-only concurrent-accept reporting residual (no duplicate state) — documented, no work planned.
  5. **`recordPayloadReconciliation` scoping re-review** rides in P0-011 (recorded in that ticket), not here.
  6. **Q-04** richer expired-quote UX (re-quote CTA) remains open, non-blocking — minimal honest state is live.
- **P0-011 follow-ups (recorded at its 2026-09-01 close; Organizer sequences — none blocking):**
  1. **ADR-003 migration batches TS-1…TS-6** (founder-approved direction, NOT started): TS-1 remaining crons + `lib/automations.ts` → `forShop`; TS-2 session-context service-client actions; TS-3 provider webhooks (under their replay suites); TS-4 MCP server + `agent-runtime`/`agent-events` threading; TS-5 (design gate, E01) re-evaluate session-variable RLS-for-service-role vs facade-forever; TS-6 (small) thread a `shopId` into `lib/slack.ts` `storeSlackRef`/`updateSlackForPending`. Sequenced post-P0 per the ADR.
  2. **M1 — Slack workspace→shop identity:** the shipped tenant binding uses channel+message_ts of the posted card — sufficient for the disabled surface; a real team/workspace→shop mapping is REQUIRED before any Slack re-enable (rides the D-026 re-enable gate).
  3. **M2 — `storeSlackRef`/`updateSlackForPending` bare-id writes** — with TS-6.
  4. **M3 — `executeCancelAppointment` deletes by appointment id after a scoped load** — pre-existing invariant; mechanized when approvals.ts converts (TS-batch).
  5. **LOW/OPTIONAL (accepted at close, no work planned unless evidence changes):** whitespace-only shopId passes `forShop`'s empty-check; cross-tenant claims echo `already_decided` rather than a distinct status (structured log carries the signal); `match_customer_memory` mismatch lacks its `match_shop_knowledge`-equivalent integration test; MCP usage counter id-only after trusted credential lookup; quote-response race-echo SELECT id-only; some vehicle patches bare-id after trusted resolution; `agent-events` publisher-resolved shopId until TS-4; Slack tests flip the frozen FEATURES object via cast.
  6. **Test-infra:** P0-009 `quote_response` rate-limit **fixed-window timing flake** (surfaced once locally at the P0-011 acceptance; passed in isolation, on rerun, and in CI on the accepted SHA) — fold into the existing integration-test hygiene line under the P0-005 follow-ups.
- **P0-010 follow-ups (recorded at its 2026-08-28 close; Organizer sequences):**
  1. **M-1 — provider/model error details may surface raw to the owner:** reproduced at acceptance — a provider `401 …` string reached the AI-lead UI on model failure. Wrap provider failures in honest generic copy per the strings.ts error conventions.
  2. **M-2 — AI-lead and inbound classification share the `inbound_classify` analytics kind:** owner-initiated extractions and inbound-message classifies mix in usage analytics. A dedicated AI-Lead SKU/kind (and any repricing) is a **founder pricing decision** — rides the Q-22-era pricing work, never decided silently.
  3. **M-3 — two API routes still revalidate the legacy `/leads` stub:** P0-010's fix + source-scan test cover `src/app/actions` only; extend both to `src/app/api`.
  4. **Audit M-2 (agent `config` `z.unknown()` → real zod schema):** audit docs 06/08 mapped it to P0-010, but the cut ticket's scope never included it and P0-010 shipped without it — still open (see `../08-security-and-reliability.md` findings table).
  5. **Public-URL / forwarded-host trust:** the `GRADIA_DASHBOARD_URL` → `x-forwarded-host` → `host` fallback spans 6+ modules (audit 04-C spoofable public-URL base). Operationally mitigated 2026-08-28 — founder confirmed `GRADIA_DASHBOARD_URL` PRESENT in Production, so the fallback never engages there — but the code path remains; future hardening ticket.
  6. **Env-docs gaps beyond the ticket's five:** `GRADIA_LLM_MODEL`, `TWILIO_PRIMARY_PROFILE_SID`, and the dev/test `*_API_BASE` seams remain undocumented in `.env.example`.
  7. **Cosmetic residue (LOW/OPTIONAL):** raw amber classes on the public `how-it-works` page (not a settings fallback — out of P0-010's token scope); stale "exactly these six" `app-sidebar.tsx` comment (C-15-adjacent). Neither shipped with P0-010.
- **Ledger RLS tightening** (`usage_events` / `payments` / `shop_metrics` → SELECT-only, matching `credit_grants`; D-024) — **resolved 2026-08-13: absorbed into P0-005** (migration `20260812130000_ledger_rls_select_only.sql`, merged PR #17); no separate ticket needed.
- **P0-005 follow-ups (recorded at its 2026-08-13 close; Organizer sequences):** **P0-005A** provider_events retention/pruning (own ticket, filed — ADR-001 C2); reminder/confirmation duplicate approval-**card** staging race (duplicate external send already protected by the `automation_runs` unique); extend `usage_events` uniqueness to `outreach_draft` once historical vendor_ref compatibility permits (ADR-001 C6 time-box); provider_events metadata/attempts bounds (later hardening — optional fold-in to P0-005A); transient local Supabase/PostgREST integration-test 502 flakiness tracked as test-infra hygiene; staging manual acceptance run before the P0-005 migrations are considered fully rollout-accepted (steps in the ticket's close record). ADR-001 C3/C4/C5 ride inside the P0-006/P0-007/Aurinko ticket scopes, not here.
- **P0-006 follow-ups (recorded at its 2026-08-14 close; Organizer sequences):** (1) **consent-keyword customer-resolution failure** — review so a consent event can never be considered successfully complete without the required consent persistence; (2) Aurinko `accountId:`-prefixed event identity remains the ADR-001 C4 follow-up; (3) **P0-005A** provider_events retention/pruning remains open; (4) optional: use the already-trimmed MessageSid for metering-reconciliation consistency; (5) optional low-priority: classifier-output persistence — only if future cost/reliability data justifies eliminating the accepted retry-reclassification residual (Cursor-recorded, non-blocking; see the ticket close record); (6) the P0-008 deferred findings — **dispositioned 2026-08-25 at the P0-008 close** (provider_events hardening ruled not-required for the naturally idempotent status write; query-string shop/token selection and unknown-SID behavior closed test-locked; stale/out-of-order updates accepted as residual L2; A2P verification audited correct with one L4 follow-up below) — see the P0-008 close record; (7) production P0-004 conflict enforcement remains OFF.
- **P0-007 follow-ups (recorded at its 2026-08-14 close; Organizer sequences):**
  1. **Vapi tool-call/function-call replay protection** — end-of-call is now protected, but synchronous tool-call/function-call events are not replay-deduped (independently confirmed outside P0-007 scope). Investigate the provider `toolCallId` as a stable idempotency identity; `captureLead`/`proposeBooking` staging must not duplicate under provider retry. **Kept separate from P0-008.**
  2. **Vapi/global provider-event cross-tenant griefing mitigation** — an authenticated malicious tenant knowing another shop's opaque Vapi `call.id` could pre-claim the global `(provider, event_id)` receipt (denial/under-billing only, never cross-tenant mutation/disclosure — accepted ADR-001 residual). Emit a security warning when a duplicate claim's stored shop differs from the authenticated shop; evaluate per-provider tenant-safe namespacing where the tenant is deterministically resolvable; preserve ADR-001's global-key reasoning.
  3. **P0-005A** provider_events retention/pruning remains open — both consumer routes now write receipts, so the sequencing pressure is real.
  4. Optional: revisit Vapi route `maxDuration=60` if real end-of-call processing approaches the ceiling; revisit `call_records` durability if Glass Box completeness becomes contractual; revisit the count-based transcript resume if Vapi retry payload ordering semantics change.
- **P0-008 follow-ups (recorded at its 2026-08-25 close; Organizer sequences):**
  1. **M1 — credential-class/decryption observability:** a subaccount token decryption failure is fail-closed (correct) but under-reported — the resolver can fall through and later log a generic signature mismatch with `credentialSource` env-or-none instead of explicitly naming the subaccount decryption failure. Make the credential-class failure loud and specific (the ticket's original observability intent), consumable by P0-012 alerting.
  2. **L4 — A2P status-callback DB-error retryability:** the A2P route's shop lookup treats a DB lookup failure like not-found/404 rather than a retryable 500 (pre-existing, deliberately untouched by P0-008 — the SMS status route got the 500 treatment). Align when next touching that route.
  3. **L1 — legacy no-`?shop=` path retirement:** the legacy status-callback path (env-master auth + global MessageSid lookup) is an accepted LOW residual — all currently generated callback URLs carry `?shop=`. Track eventual retirement once no legacy master-account callback URLs can remain configured.
  4. **L3 — status-callback metadata merge concurrency:** the read-modify-write jsonb merge can race under concurrent callbacks for one message (accepted at pilot scale; L2 last-write-wins is the ticket-sanctioned semantic). Revisit only if scale or evidence warrants.
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

> **Resolved 2026-08-28 at the P0-010 close (PR #27):** items 1–6 shipped, with deviations recorded in the ticket's close record (five of seven orphans deleted — `revenue.ts`/`today-money.ts` regained importers, `ui/badge.tsx` already gone; `askGradiaPage` flag kept — it gained a real consumer; amber classes already token-compliant at HEAD). Items 7–8 were never P0-010's and stand as noted below.

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

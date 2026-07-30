# 14 — Product Analytics

_Created 2026-07-25 by the Organizer. Defines the canonical activation/lifecycle event set. **No event code is implemented in this session** — this is the specification future instrumentation tickets build against. The storage/pipeline choice (in-DB events table vs third-party analytics) is an open item in `program/decision-queue.md`._

## Ground rules

- Events carry **ids, not PII**: `shop_id` always; entity ids (`customer_id`, `quote_id`, `appointment_id`, `pending_action_id`) as relevant; never names/phones/emails/message bodies.
- Events are emitted at the **domain-function success point** (the same "one path" discipline as sends/approvals), never from UI components.
- "First X" events fire once per shop — enforced by a unique constraint per (shop_id, event), not by code checks.
- Fabricating or estimating event data is forbidden (D-025). If a figure isn't traceable to a row, it isn't reported.

## Canonical event set

| Event | Definition / trigger moment (grounded in current code paths) | Key properties | Instrumentation today | Phase |
|---|---|---|---|---|
| **Account created** | Supabase Auth signup completes (first session established) | shop_id (once created), auth method | NOT INSTRUMENTED — nearest signal: `auth.users` row | P0/P1 |
| **Business profile completed** | `saveShop` succeeds with `settings.onboarding_done: true` (wizard finish) | shop_id, steps skipped | NOT INSTRUMENTED — nearest: `shops.settings` | P1 |
| **Import started** | Recovery/structured import job created (`import_jobs` insert via `/api/recovery/import*`) — extends to CRM import wizard (E03) | shop_id, import_job_id, source type, row count | PARTIAL — `import_jobs` rows exist; no event semantics | P3 |
| **Import completed** | Import job reaches reviewed/approved terminal state (`approveRecoveryCandidates` batch done) | shop_id, import_job_id, approved/rejected/dup counts | PARTIAL — derivable from `import_jobs`/`import_messages` | P3 |
| **Calendar connected** | Aurinko (later Google/Microsoft, E02) OAuth callback stores tokens for calendar scope | shop_id, provider | NOT INSTRUMENTED — nearest: `shops` aurinko columns | P2 |
| **Service menu configured** | First `services` row saved (or `applyDetailerTemplate` applied) | shop_id, service count, via_template | NOT INSTRUMENTED — nearest: `services` rows | P1 |
| **First customer created** | First `customers` insert for the shop — any path: `findOrCreateCustomer`, import approval, executor | shop_id, customer_id, source (inbound/import/manual/agent) | NOT INSTRUMENTED — nearest: `customers.created_at` min | P3 |
| **First lead received** | First `leads` insert from an **inbound** channel (SMS/voice/email webhook staging path), as opposed to owner-created | shop_id, lead_id, channel, source | NOT INSTRUMENTED — nearest: `leads` + `source` column | P0/P3 |
| **First quote sent** | First `sendQuote` success (quote status → `sent`) | shop_id, quote_id, channel | NOT INSTRUMENTED — nearest: `quotes.status` | P3 |
| **First appointment booked** | First `executeBookAppointment` success (appointment row inserted) | shop_id, appointment_id, origin (voice/quote/agent/manual) | NOT INSTRUMENTED — nearest: `appointments.created_at` min | P2 |
| **First job completed** | First appointment status-machine transition to `completed` (`jobs.ts`) | shop_id, appointment_id, quoted_amount_cents | NOT INSTRUMENTED — nearest: `appointments.status` | P4 |
| **First payment collected** | E05: first Stripe Connect payment succeeded for a shop's customer. (Platform-subscription payments do NOT count.) | shop_id, payment id, amount_cents | NOT BUILT — capability is P5 scope | P5 |
| **First AI action approved** | First `pending_actions` resolution in {approved_unedited, edited} executed successfully | shop_id, pending_action_id, action_type | PARTIAL — fully derivable from `pending_actions.resolution` telemetry | P0 |
| **First revenue opportunity acted on** | First Opportunity Engine suggestion (E09) accepted → staged action approved | shop_id, suggestion ref, pending_action_id | NOT BUILT — capability is P9 scope; nearest today: whisper-suggestion sweep | P9 |
| **First receptionist call completed** | First `call_records` upsert with a completed call for the shop | shop_id, call_record_id, duration | PARTIAL — derivable from `call_records` | P0 |
| **Trial converted** | Stripe webhook: subscription becomes active/paid from trial state (D-005 trial model) | shop_id, plan, package_2 | PARTIAL — `shops.plan` transitions exist; trial semantics pending Q-13 | P0/P1 |
| **Subscription canceled** | Stripe webhook: subscription canceled/lapsed → `shops.plan` leaves active | shop_id, plan at cancel, tenure days, reason if collected | PARTIAL — webhook lifecycle handled; no event/reason capture | P0/P1 |

## Funnels

**Activation funnel (per shop, time-boxed to first 14 days — clock start follows D-032/Q-13 once the trial model lands):**
Account created → Business profile completed → (Import completed ∥ First customer created) → Calendar connected → Service menu configured → First quote sent → First appointment booked → First AI action approved.
The step order after profile completion is not enforced — report step-completion rates, not strict sequence.

**Trial → paid funnel:** Account created → activation milestones above → Trial converted; with Subscription canceled as the terminal negative. Segment by: import used (yes/no), receptionist enabled (yes/no), first AI action approved (yes/no) — the three hypotheses about what drives conversion.

**Ongoing health (post-activation):** weekly approved-action count, credits consumed vs allowance, calls handled — already derivable from `usage_events` / `pending_actions` / `call_records`; the ROI-receipt machinery (`shop_metrics`) is the existing in-product mirror of these.

## Implementation notes (for the future instrumentation ticket)

- Most "first X" events are **backfillable** from existing tables (min(created_at) queries) — the instrumentation ticket should backfill so historical shops aren't zeroed.
- The emission point list above doubles as the code-touch list; each is one line at an existing domain-function success point — no new business logic.
- Open decisions before build: storage/pipeline (events table vs vendor), retention, and whether owner-facing analytics reuse the same rows (recommend yes, to keep one truth). See `program/decision-queue.md`.

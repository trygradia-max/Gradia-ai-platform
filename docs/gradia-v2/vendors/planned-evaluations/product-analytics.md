# Planned Evaluation — Product Analytics

_Created 2026-07-27 (vendor-architecture amendment). Planning only — no vendor is selected or installed. Adoption requires the 17-point checklist in `../README.md` incl. founder approval._

## Why this evaluation exists

`../../14-product-analytics.md` defines 17 canonical activation/lifecycle events (Account created → Subscription canceled); almost nothing is instrumented and no pipeline is chosen (Q-12). Requirements must be fixed **before** any vendor conversation so the vendor is fitted to Gradia, not vice versa.

## Requirements (before any vendor)

1. **Activation funnels** — the 17 canonical events composable into the two funnels defined in doc 14 (activation; trial→paid). Funnel definitions live in Gradia docs, not vendor UI-only config.
2. **Privacy / no PII** — event properties carry ids only (`shop_id`, entity ids, source enums); never names, phones, emails, message content. This is a hard rule from doc 14, vendor-independent.
3. **Session replay policy** — default **off**; enabling replay is a separate founder decision with explicit consent handling; no vendor chosen for its replay feature.
4. **Cost at pilot scale** — priced for tens of shops now without punishing 10× growth; free-tier cliff behavior **requires verification** per candidate.
5. **Data export** — full raw-event export, no lock-in; export format **requires verification** per candidate.
6. **Retention** — configurable; must satisfy the future GDPR-shaped deletion work (E10) — deleting a shop must be able to delete/anonymize its events.
7. **Server-side AND client-side events** — most canonical events fire server-side at the real code paths (e.g. First appointment booked = `executeBookAppointment` success); client-side only for surface interactions. A server-first SDK posture is mandatory.
8. **Identity merging** — anon visitor → auth user → shop; multi-shop owners (cookie-pinned active shop) must not corrupt shop-level funnels; merging semantics **requires verification** per candidate.
9. **Warehouse export** — path to Postgres/warehouse export so analytics can join `usage_events`/`payments` (the revenue truth stays in Gradia's ledgers, never the analytics vendor).
10. **Tenant isolation** — events keyed by `shop_id`; no cross-tenant visibility risk in any shared dashboard.

## Current state in Gradia

No product-analytics instrumentation. Nearest existing signals: `usage_events` ledger, `shop_metrics` (ROI receipt), `custom_agent_runs`, `pending_actions.resolution` telemetry. Doc 14 maps each canonical event to its trigger code path with status NOT INSTRUMENTED.

## Gradia-owned boundary

A thin Gradia-owned `track()` emitter (name TBD at implementation) so the vendor is swappable and the no-PII rule is enforced at one choke point — same D-029 logic as the provider interfaces, applied to telemetry.

## Trigger / timing

Q-12's Organizer recommendation stands: **own-DB events table first** (RLS-scoped, zero new data processors before the GDPR-shaped P10 work); vendor evaluation when funnel analysis outgrows SQL — realistically P1+ instrumentation, vendor question revisited around E08 (reporting).

## Candidate options (not selected)

Own-DB events table · PostHog (self-host option relevant to privacy posture) · Amplitude · Mixpanel. Capabilities against requirements 4–9: **requires verification** at evaluation time.

## Open questions → decision queue

Q-12 (pipeline choice) · session-replay consent policy (new queue item if ever proposed) · whether marketing-site analytics (capability 28) shares the pipeline or stays separate.

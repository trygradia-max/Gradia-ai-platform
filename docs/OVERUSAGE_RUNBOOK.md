# Over-usage & cost-abuse protection — runbook

How Gradia is protected from runaway/abusive usage cost, what's enforced in
code vs. ops, and what to do when an alert fires. Last reviewed 2026-06-15.

## The model: defense in depth

| Layer | Control | Where | Fails |
|---|---|---|---|
| 1. Per-shop cost ceiling | Credit allowance — `isOverCreditLimit` + `precheckCredits` + `checkFeatureAccess` (Gradia Agent / Whisper 402 when out of credits) | `lib/credits.ts`, `/api/bi/chat`, `/api/whisper/process` | **closed** |
| 2. Plan gating | `isPaid` / `hasPackage2` — free & past_due run nothing; autonomy + scheduler require a paid plan | `lib/entitlements.ts`, `autonomy.ts`, `agent-runtime.ts` | **closed** |
| 3. Outreach blast radius | Audience cap 50/200, cooldowns, opt-out | `lib/agent-audience.ts` | closed |
| 4. Loop bounds | BI `MAX_TURNS=6`, `max_tokens=1024`; planner one-shot | `lib/bi-agent.ts`, `lib/agent-planner.ts` | closed |
| 5. Burst limiter | Per-shop/minute on owner endpoints; per-shop/day on **unmetered inbound classification** (the only uncapped LLM path) | `lib/rate-limit.ts` (+ Twilio/Aurinko webhooks, BI/Whisper routes) | **open** (soft) |
| 6. Auto-top-up ceiling | `checkAutoTopupAllowed` — `shops.credit_limit` caps automatic rebuys | `lib/credits.ts` | closed |
| 7. Anomaly detection | Nightly scan: spend spikes, sub-floor margin, global daily ceiling | `lib/monitoring.ts` (reconcile cron) | n/a (alerts) |
| 8. Vendor hard caps | Org/account spend limits at Anthropic, OpenAI, Twilio | **ops — see below** | **closed** |

Layer 5 fails **open** on purpose: it's a soft smoother on top of the hard
credit gate (layer 1). A counter outage must not take down inbound handling or
the owner's chat — and the credit gate still caps real spend.

## Rate-limit defaults (`lib/rate-limit.ts → RATE_LIMITS`)

- `inbound_classify`: **400 / shop / day** — spam-flood ceiling on the unmetered
  Haiku classify per inbound SMS/email. Over it, the message is still captured;
  only the LLM classify (and the lead proposal it drives) is skipped.
- `bi_chat`: **20 / shop / minute** — Gradia Agent / Ask Gradia burst.
- `whisper`: **20 / shop / minute** — Whisper burst.

Tune these as pilot traffic comes in.

## Ops: vendor-side hard caps (layer 8 — DO THIS)

Code can't set these; they're the ultimate backstop so no bug or abuse can run
an unbounded bill platform-wide.

- **Anthropic** — set a monthly **org spend limit** + usage alert emails
  (Console → Billing → Limits).
- **OpenAI** (Whisper transcription) — set a **monthly usage limit** + a soft
  alert threshold (Billing → Limits).
- **Twilio** — set an **account-level spend trigger/cap** (Usage Triggers) to
  alert/suspend at a monthly dollar ceiling; messaging is the largest real-cost
  vendor.
- Optional code backstop: set `GLOBAL_DAILY_COST_CEILING_CENTS` in the deploy
  env — the nightly scan raises a `global_ceiling` alert when platform retail
  spend crosses it.

## When an alert fires (`[monitoring] ANOMALY …` in logs)

- `spend_spike shop=<id>` — one shop spending ≥3× its trailing daily average.
  Check `usage_events` for that shop: a stuck autonomous agent, an outreach
  blast, or abuse. Lower the shop's `credit_limit` or pause its agents.
- `margin_floor shop=<id>` — gross margin under 50% for the period. Usually a
  cost regression (model price change, a prompt that ballooned) — check
  `pricing_config` vs. real cost and re-run the cost review.
- `global_ceiling` — platform daily spend crossed the env ceiling. Page on this;
  confirm against the vendor dashboards.

## Related

- Pricing & margins: `_docs/GRADIA_PRICING.md`
- Metering conventions: `gradia-metering-billing` skill
- Cost review (per-1,000-credit model): see 2026-06-15 analysis

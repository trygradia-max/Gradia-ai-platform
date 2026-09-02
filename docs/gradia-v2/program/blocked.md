# Program — Blocked

_Created 2026-07-25 by the Organizer. Register of work that cannot proceed. Format: item · blocked on · since · owner. An item leaves this file only when the blocker is resolved and recorded (decision → `../11-decision-log.md`; founder action → noted in the relevant ticket)._

| Item | Blocked on | Since | Owner |
|---|---|---|---|
| Live A2P registration verification (TrustHub policy SIDs, `twilio-a2p.ts:11-15`) | Founder accounts + first real registration run (`FOUNDER_OPS_RUNBOOK.md`, `docs/twilio-go-live.md`). | 2026-07-25 | Founder |
| Trial model build (E01/billing scope of D-005) | **Q-13** — trial length + variable-cost allowance numbers. Design can proceed; no implementation ticket is cut until numbers land. | 2026-07-25 | Founder |
| Marketing-site pricing page + trial-allowance sizing | **Q-22** — D-031 three-tier split/allowances/timing undecided (C-14); Q-13 numbers must be re-derived against the new tiers. Live billing stays untouched during P0 regardless. | 2026-07-27 | Founder |
| **P0-013 — Production billing model alignment** (launch-blocking before live paid billing activation) | Founder decisions **Q-22** — the Core/Pro/Operator commercial tier decisions (feature split, credit/minute allowances, voice/pack disposition, adoption timing, existing-shop treatment). The ticket is cut as **draft — decision-gated** (`../tickets/P0-013-production-billing-model-alignment.md`) and may not enter implementation until those decisions are recorded. Standing guard from the P0-010 close: `STRIPE_PRICE_ID` / `STRIPE_PRICE_VOICE_ADDON` / `STRIPE_PRICE_CREDIT_PACK` / `STRIPE_PRICE_MINUTE_PACK` stay **unset in Production** — checkout is proven fail-closed — and nobody instructs setting them until P0-013 is implemented, reviewed, accepted, and ready for Production. **P0-011 completed independently of this row (done 2026-09-01, PR #29); P0-012 likewise proceeds independently.** (Predecessor row resolved: P0-010 unblocked when the `docs/close-p0-009` closeout landed as `e70b287` PR #26, then implemented, merged 2026-08-28 as PR #27 `5d82fa3`, Cursor APPROVE with one HIGH fixed pre-merge in `618cf41`, founder acceptance PASS incl. the recorded billing exception; close record in its ticket file.) | 2026-08-28 | Founder |

## Rules

- Never make a blocked founder decision silently (Builder contract). A Builder who hits an unlisted blocker stops, marks the ticket blocked here, and reports.
- Partial progress is allowed only where a row explicitly says so (e.g. P0-012 seam, trial design).
- The Organizer reviews this file at every sprint boundary and pushes stale rows to the founder via `decision-queue.md`.

_2026-09-01 (autorun prep): rows for Q-01 (→ D-038, rotate-only), Q-02 (→ D-039, lifecycle wired in E03-03), Q-08 (→ D-042, Slack ops webhook + SMS), and Housecall Pro live verification (→ D-052, connector deleted in CLEANUP-001) removed. Founder still owes: Slack ops webhook URL for P0-012 destination config; Stripe live products for P0-013 acceptance._

# Program — Blocked

_Created 2026-07-25 by the Organizer. Register of work that cannot proceed. Format: item · blocked on · since · owner. An item leaves this file only when the blocker is resolved and recorded (decision → `../11-decision-log.md`; founder action → noted in the relevant ticket)._

| Item | Blocked on | Since | Owner |
|---|---|---|---|
| P0-001 sub-step: git-history scrub of the leaked DB URL | Founder decision **Q-01** (scrub vs rotate-only). Rotation and working-tree scrub are NOT blocked and proceed in Sprint 1. | 2026-07-25 | Founder |
| `lifecycle.ts` wiring to a cron (E03; fuels win-back) | Founder sign-off on thresholds **Q-02** (active <180d, at_risk 180–365, lapsed >365). The module is finished and deliberately unwired pending this (audit doc 11). | 2026-07-25 | Founder |
| Live A2P registration verification (TrustHub policy SIDs, `twilio-a2p.ts:11-15`) | Founder accounts + first real registration run (`FOUNDER_OPS_RUNBOOK.md`, `docs/twilio-go-live.md`). | 2026-07-25 | Founder |
| Housecall Pro live-endpoint verification (`housecallpro.ts` `TODO(verify)` markers) | Founder HCP account + live smoke (`docs/jobber-go-live.md` pattern). Blocks marketing any HCP claim (D-028). | 2026-07-25 | Founder |
| Trial model build (E01/billing scope of D-005) | **Q-13** — trial length + variable-cost allowance numbers. Design can proceed; no implementation ticket is cut until numbers land. | 2026-07-25 | Founder |
| P0-012 final alert-destination configuration | **Q-08** — where alerts go (Slack channel / SMS). The delivery **seam** is not blocked and builds in the ticket; only the destination config waits. | 2026-07-25 | Founder |
| Marketing-site pricing page + trial-allowance sizing | **Q-22** — D-031 three-tier split/allowances/timing undecided (C-14); Q-13 numbers must be re-derived against the new tiers. Live billing stays untouched during P0 regardless. | 2026-07-27 | Founder |
| **P0-013 — Production billing model alignment** (launch-blocking before live paid billing activation) | Founder decisions **Q-22** — the Core/Pro/Operator commercial tier decisions (feature split, credit/minute allowances, voice/pack disposition, adoption timing, existing-shop treatment). The ticket is cut as **draft — decision-gated** (`../tickets/P0-013-production-billing-model-alignment.md`) and may not enter implementation until those decisions are recorded. Standing guard from the P0-010 close: `STRIPE_PRICE_ID` / `STRIPE_PRICE_VOICE_ADDON` / `STRIPE_PRICE_CREDIT_PACK` / `STRIPE_PRICE_MINUTE_PACK` stay **unset in Production** — checkout is proven fail-closed — and nobody instructs setting them until P0-013 is implemented, reviewed, accepted, and ready for Production. **P0-011 proceeds independently and is not blocked by this row.** (Predecessor row resolved: P0-010 unblocked when the `docs/close-p0-009` closeout landed as `e70b287` PR #26, then implemented, merged 2026-08-28 as PR #27 `5d82fa3`, Cursor APPROVE with one HIGH fixed pre-merge in `618cf41`, founder acceptance PASS incl. the recorded billing exception; close record in its ticket file.) | 2026-08-28 | Founder |

## Rules

- Never make a blocked founder decision silently (Builder contract). A Builder who hits an unlisted blocker stops, marks the ticket blocked here, and reports.
- Partial progress is allowed only where a row explicitly says so (e.g. P0-012 seam, trial design).
- The Organizer reviews this file at every sprint boundary and pushes stale rows to the founder via `decision-queue.md`.

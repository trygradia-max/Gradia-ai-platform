# Runbook — Emergency Feature Shutdown

_Created 2026-07-25 by the Organizer. The kill-switch map for Gradia. The design already favors this runbook: every risky surface is flag-gated, entitlement-gated, HITL-staged, or per-shop toggleable ("gate, don't delete"). Know the grains before the incident — reaching for the wrong one either under-contains or takes down the whole product._

## The kill-switch inventory (smallest blast radius first)

| Grain | Mechanism | Latency | Blast radius |
|---|---|---|---|
| One automation, one shop | Automation toggle approval/autopilot, or disable the automation | Immediate (next sweep) | Single behavior, single shop |
| One agent, one shop | Agent mode → suggest, or disable the custom agent | Immediate (next run) | Single agent |
| All AI staging, one shop | **Shadow Mode** (`shops.simulation_mode`) — blocks staging at four checkpoints | Immediate | Shop's AI goes dry-run; CRM untouched |
| All autonomy, one shop | **Entitlement kill: drop Package 2** — `resolveAgentMode` forces suggest-first; scheduled autopilot + voice stop | Next call / next run (never mid-call) | Shop reverts to approve-first Core |
| One provider seam, all shops | Disable the webhook at the provider console (Twilio/Vapi/Aurinko/Stripe) | Immediate | Channel goes silent platform-wide |
| All crons | Rotate `CRON_SECRET` in Vercel env (+ redeploy) — all 8 routes fail closed | Minutes | Sweeps, reminders, reconciliation, retention all pause |
| One feature, all shops | **`src/lib/features.ts` flag flip + redeploy** — routes 404, UI gates, runtime refuses | **Requires a deploy** (compile-time const) | Feature dark everywhere, reversibly |
| Everything | Vercel: pause deployment / take the app down | Minutes | Total outage — SEV-0 containment only |

## Decision tree

1. **Is money moving wrongly?** → Stripe dashboard actions first (`double-billing.md`), then the narrowest gate that stops the writer.
2. **Is it cross-tenant?** → provider-console webhook disable or CRON_SECRET rotation to close the machine path NOW (`tenant-data-leak.md`); flags are too slow if a deploy queue is in the way.
3. **Is AI sending/staging something wrong?**
   - One shop → Shadow Mode or entitlement kill.
   - All shops, one behavior → automation/autopilot flags; remember **HITL is itself a containment layer** — forcing everything to suggest-first is usually enough, because humans become the filter.
4. **Is a feature broken but harmless?** → flag flip on the next deploy; no emergency.
5. Voice special case: **never cut a live call** — every voice mechanism applies next-call by design. Don't fight this invariant.

## Execution notes
- Flag flips are code commits: edit `features.ts`, commit, deploy. **P0-002 must not slow an emergency deploy** — CI gates merges to main; in a declared SEV-0 the founder may deploy a flag-only change with expedited review, documented in the incident note. (Flag-only diffs are the one sanctioned fast path; nothing else skips CI.)
- Compile-time flags mean there is no runtime flag console — per-shop runtime flags are a P4-era idea (audit gap analysis). Until then, per-shop containment = Shadow Mode / entitlement / per-automation toggles.
- After any provider-console webhook disable, inbound events during the window are **lost, not queued** (no dead-letter until E10) — record the window; recovery may need provider-side redelivery (REQUIRES VERIFICATION per provider).
- Package-2 entitlement kill has a billing side effect (it is a Stripe subscription item) — for containment, prefer the code-side autonomy floor via Shadow Mode unless voice must also stop; if entitlement is dropped operationally, make the shop financially whole afterward.

## Verification after shutdown
- The dangerous behavior provably stopped: no new `pending_actions` of the type (Shadow Mode), no new `automation_runs`, webhook route returning 404/no traffic, cron routes 401ing.
- The rest of the product still works: login, CRM reads, approvals of already-staged safe actions.

## Re-enable protocol
- Reverse order of shutdown; the triggering defect has a merged fix **with a locking test**; one-shop canary before platform-wide re-enable where the grain allows; the incident note records who flipped what, when — mode/flag switches must stay auditable (autonomy-model invariant).

## Known gaps
- Flag flips need a deploy — worst-case latency is your deploy time; provider-console and CRON_SECRET paths are the true "seconds" switches.
- No global "pause all outbound" single switch; the composite is: autopilot off + crons paused + approvals left unapproved. Consider a first-class one as an E10/backlog candidate.
- Webhook-disable data loss (above) until E10 outbox/queue.

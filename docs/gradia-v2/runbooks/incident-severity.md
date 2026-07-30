# Runbook — Incident Severity Model

_Created 2026-07-25 by the Organizer. Defines SEV-0 through SEV-3 for Gradia, who declares, response targets, communication rules, and the postmortem requirement. Every other runbook in this directory references this scale._

## Severity levels

| Level | Definition | Examples (this platform) | Response target |
|---|---|---|---|
| **SEV-0** | Cross-tenant data exposure, credential compromise, or money incorrectly moved. Trust-destroying if unhandled. | The leaked DB credential (audit C-1) exploited; a service-role path leaking one shop's customers to another (C-2 shape); a charge or credit applied to the wrong shop | **Immediate, all-hands (today: the founder drops everything).** Contain within 1 hour; owner communication same day |
| **SEV-1** | A core promise broken for multiple shops, or compliance exposure: double-booking occurring, duplicate outbound messages sent to customers, double billing, outbound to opted-out numbers, production down | Webhook retries producing duplicate texts; voice minutes double-metered across shops; broken build deployed to main | Contain within 4 hours; fix or feature-shutdown within 24h |
| **SEV-2** | A feature dead or degraded for multiple shops with a workaround, or a single shop's money/compliance data affected | Aurinko outage flooding approvals with false lead cards; A2P registration failing live; delivery status silently absent | Acknowledge within 1 business day; fix scheduled into the current sprint |
| **SEV-3** | Cosmetic, single-shop degraded state, or internal-only breakage | A stale `revalidatePath`; one shop's stale voice assistant repaired by the hourly voice-sync cron | Ticket in backlog; no interruption of sprint WIP |

Rule of thumb: **if tenant isolation, money, or consent is involved, start one level higher than instinct suggests and downgrade with evidence.**

## Who declares and runs incidents

- **Incident commander: the founder.** Gradia is a single-operator company today (risk R-15); there is no rotation or escalation ladder to invoke. Declaring an incident means: stop feature work, open a dated incident note in `../releases/` or a scratch file, work the matching runbook top to bottom.
- Agents (Claude Code / Cursor) may **recommend** a severity and prepare diagnosis/containment steps, but only the founder executes destructive containment (credential rotation, flag flips to production, cron disabling) — these are founder-account actions anyway (`FOUNDER_OPS_RUNBOOK.md`).

## Communication rules

- **Affected owners are notified honestly** — what happened, what it affected in *their* shop, what was done. This follows the product truth discipline (D-028 / `WHAT_GRADIA_DOES.md`): never minimize, never claim "no impact" without evidence from real rows.
- SEV-0 involving personal data: notification is mandatory, same day, per-shop specific. Consult the tenant-data-leak runbook for scope determination first — do not notify with guesses.
- Duplicate-message and double-billing incidents include the make-good in the same message (see those runbooks).
- Nothing outbound to customers-of-shops (the shops' clients) without the affected owner's knowledge — Gradia speaks as the shop, so incident comms to end customers are the owner's call.

## Postmortem requirement

Every SEV-0 and SEV-1 (and any recurring SEV-2) gets a postmortem within one week:

1. Timeline (detection → containment → recovery), from real evidence (Vercel logs, Sentry, table rows).
2. Root cause and why existing guards missed it.
3. Actions: each becomes a ticket in `../tickets/` or a backlog entry in `../program/backlog.md`.
4. **Update `../risks/risk-register.md`** — add or re-score the row. A postmortem that changes no risk row is incomplete.
5. If detection relied on luck rather than alerting, note it explicitly — that is a P0-012-class gap until alert delivery lands.

## Known global gaps (apply to every incident until fixed)

- **Alerts are console-only** — `monitoring.ts` anomalies, reconciliation drift, and cron failures page nobody until **P0-012** lands. Detection today is founder-initiated inspection or an owner report.
- **No `/api/health`** endpoint until P0-012 — "is it up" checks are manual.
- **No queue/dead-letter until P10 (E10)** — a failed cron sweep waits for the next tick; weekly jobs have no catch-up. Recovery steps must account for missed windows.
- **Backups: Supabase platform PITR settings are REQUIRES VERIFICATION** (audit open question #17) — verify tier and retention *before* the first incident needs them (see `data-restore.md`).

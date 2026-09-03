# Release 1 — "Nothing gets missed"

> **SUPERSEDED 2026-09-03.** The single source of truth for what Gradia is and what gets built next is `platform/CONTEXT.md`. This file is history and detail reference only — do not plan from it.


_Founder scope decision, 2026-09-03. This file is the **scope authority** for Release 1. It outranks `10-roadmap.md` phase ordering for what ships next; the roadmap remains the authority for what comes after. Every decision an implementing session might need is pre-answered below — if a session finds a question this file does not answer, that is a HARD STOP and a line in `decision-queue.md`, not a guess._

## What Gradia is (claim law for R1)

Gradia is the **front office and revenue system for detailing, PPF, coating and tint shops, run by an agent.**

Leads from every source — Meta lead ads, website forms, phone calls, SMS, email — land in one pipeline automatically. The Gradia Agent picks them up within seconds, qualifies over SMS, quotes, and books them on the calendar. A **Chief of Staff** screen shows everything the agent did while the owner was working, and anything needing a human is one tap. The owner reads and approves; they do not operate the software.

Positioning contrast: Jobber/Urable are systems of record the owner operates. Gradia does the work and reports it. That difference is the entire pricing justification.

## ICP (D-055)

**Established shops with staff** — 3-30 employees, one or more locations, already spending on ads. Not solo operators. This ICP makes multi-user roles mandatory in Release 2, not optional.

## The three flagships

1. **Every lead lands and gets worked in 60 seconds.** Meta lead ads + web form + call + SMS + email → one pipeline → agent SMS response within 60s → qualify → propose times.
2. **Chief of Staff.** One screen: what happened, what needs you, and a command bar where the owner asks for work in plain language and the agent does it.
3. **It becomes a booked job.** SMS conversation → appointment on a calendar that cannot double-book.

## Release map (do not reorder without a founder decision)

| Release | Name | Contents |
|---|---|---|
| **R1** | Nothing gets missed | The three flagships above + billing so shops can pay + 5-screen UI pass |
| **R2** | Enterprise-ready | Members/roles/invitations (E01); CRM immaculate — customers, vehicles, pipeline, quotes, direct edit/export, import wizard (E03); bulk marketing campaigns + consent model |
| **R3** | Money | Stripe Connect (D-019): deposits on quotes, invoices on jobs, payments inside Gradia, platform revenue share |

## Decisions — pre-answered, do not re-ask

- **D-056 — Meta Lead Ads is IN for R1.** This does **not** revive Instagram/Facebook *messaging* channels (removed, WHAT_GRADIA_DOES §3). Lead Ads is an inbound lead source only: webhook → lead row → agent. No IG/FB DM surface, no social posting.
- **D-057 — Payments are Stripe Connect, R3.** Gradia does **not** become a payment processor (money transmitter licensing, underwriting, reserves — out of scope permanently). Connect gives the in-app payment experience and the revenue share. No payment work in R1.
- **D-058 — CRM polish is R2.** R1 uses leads/customers/vehicles as they exist today. R1 tickets may not refactor CRM schema.
- **D-059 — Multi-user roles are R2.** R1 is owner-facing, single login. R1 tickets may not add members/roles tables (D-018 still holds: no schema expansion before E01).
- **D-060 — Agent command bar is a persistent bar on the Chief of Staff screen**, not a floating widget and not a separate page. R1 capability = operational asks over the shop's own data (status questions, quote a lead, book a slot, draft a reply). Every write goes through the existing approval executor — no second execution path.
- **D-061 — Bulk/marketing campaigns are R2.** Outbound to a segment of past customers is marketing traffic: requires recorded per-customer consent plus a separate marketing 10DLC campaign registration. The command bar refuses these in R1 with an honest "not yet" state.
- **D-062 — Instant-response SLA is 60 seconds** from lead creation to first outbound SMS, measured and test-locked.
- **D-063 — R1 navigation is five screens:** Chief of Staff, Inbox, Calendar, Customers, Settings. Everything else (jobs, invoices, memberships, fleets, reporting, receptionist builder, automations) goes behind a flag and off the nav. Hidden, not deleted. When a prospect asks for a hidden feature the answer is "not yet — we run the front office," never a half-working screen.
- **D-064 — Gradia Whisper ships as-is in R1.** It works; no R1 ticket touches it.
- **D-065 — Data export is R1; the full import wizard is R2.** Export (shop downloads customers, vehicles, leads, appointments, conversations as CSV/JSON) is a trust and contract requirement and ships in R1 — this supersedes its P10 placement in `10-roadmap.md`. A **minimal** customer/vehicle CSV import also ships in R1 so a switching shop is not empty on day one. The staged preview/dedupe/rollback migration wizard meeting the D-022 bar stays R2. Actual regulatory obligations (state privacy laws, GDPR if EU data is ever processed) are a founder + counsel question, not an engineering assumption — recorded in `decision-queue.md`.
- **D-066 — Tool lanes: Claude Code builds, Cursor designs, never concurrently.** Claude Code (Builder) implements the feature with functional, unstyled-to-spec UI and opens the PR. Cursor (Reviewer/Design) then does the design pass as a separate commit **on that same PR branch**, after the Builder session has ended. The two agents must never hold the same repo at the same time — concurrent work on `platform/` is a process violation, not a merge problem to resolve later. The marketing repo remains Cursor-only.

## Ticket queue — one ticket = one session

Each ticket must touch ≤ 12 files. A ticket that cannot fit is split before it is started, not after it stalls.

| # | Ticket | Owner | Notes |
|---|---|---|---|
| 0a | **Meta Business Verification + App Review** for `leads_retrieval` | **Founder — start immediately** | Calendar time, not build time. Days-to-weeks at Meta's pace. Blocks R1-05 going live but not its build. |
| 0b | **Voice acceptance run** on a real inbound call | **Founder** | Voice has never been verified end-to-end. Cannot be demoed or claimed until this passes. |
| 0c | **Confirm A2P 10DLC registration is live** (transactional) | **Founder** | If not live, outbound SMS degrades silently — which breaks flagship #1 entirely. |
| R1-01 | Finish **P0-013** three-tier billing | Builder | 80% written on branch `wip/p0-013`. Review, complete, test, PR. Founder + Cursor acceptance; Stripe live prices founder-only. |
| R1-02 | **Conflict enforcement ON** in production | Builder + Founder | Built and dormant behind `NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT`. Needs the P0-004 manual acceptance walk on a flag-on Preview, then the flip. |
| R1-03 | **Lead intake seam** — one normalized entry point every source writes through (source, payload, dedupe, tenant binding, replay-safe) | Builder | The spine. R1-04/05 are thin adapters on top. No new lead source ships without going through it. |
| R1-04 | **Web form + inbound call/SMS/email → intake seam** | Builder | Wires existing sources to the new seam. |
| R1-05 | **Meta Lead Ads webhook → intake seam** | Builder | Signature verification, replay-safe, per-shop page binding. Build it before 0a clears; ship it after. |
| R1-06 | **Instant response** — new lead triggers agent SMS within 60s, qualifies, proposes times | Builder | D-062 SLA test-locked. Uses the existing send-policy boundary and consent rules. |
| R1-07 | **Book from the SMS conversation** → appointment | Builder | Closes the loop. Depends on R1-02. |
| R1-08 | **Chief of Staff screen** — activity stream (what the agent did) + needs-you queue | Builder | Reads existing approvals/trust/usage data. No new schema. |
| R1-09 | **Agent command bar** on Chief of Staff | Builder | D-060. Writes through the approval executor only. Refuses R2 capabilities honestly. |
| R1-10 | **Navigation cut** — five screens, everything else flag-hidden | Builder | D-063. |
| R1-11 | **Data export** — shop downloads customers, vehicles, leads, appointments, conversations (CSV + JSON), tenant-scoped, rate-limited | Builder | D-065. Small. Kills the "what if we leave" objection. |
| R1-12 | **Minimal CSV import** — customers + vehicles, dedupe on phone/email, no staging UI | Builder | D-065. The full wizard is R2 — this ticket may not build toward it. |
| R1-13 | **UI pass** — Stripe-grade on the five screens | Cursor (design lane) | Against `ui/reference-board.md`. Truthful states, designed empty/loading/error, inline explanation. Runs per-PR under D-066, not as one late redesign. |

## Definition of done for R1

A shop owner fills out a Meta lead form on a phone. Within 60 seconds that phone receives a qualifying SMS from the shop. The conversation books an appointment. The appointment appears on a calendar that refuses to double-book. The owner opens Chief of Staff, sees exactly what happened, and can ask the command bar a question about it and get real work back. The shop can pay Gradia for this.

Demoed live, on production, on a real phone. Not a test suite.

## Acceptance rule for every R1 ticket

Tests passing is necessary and not sufficient. Every ticket's acceptance is the founder (or the Reviewer) **watching the behavior on a Vercel Preview** — autorun rule 8. A ticket whose behavior was never observed is BUILT, not DONE.

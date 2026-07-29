# 06 — UI Information Architecture

_Created 2026-07-25 by the Organizer. Records the final IA (glass-box redesign, `platform/docs/BUILD_REFERENCE.md` §2–3, amended by `HOME_REDESIGN_PLAN.md` 2026-07-16) and plans where every FUTURE surface (P1–P10) lands. BUILD_REFERENCE remains the design-system authority; this doc adds the forward map. Detailed flow specs: `ui/flows/`._

## 1. Current shipped IA (corrected 2026-07-27 — C-15)

Sidebar, as shipped (**seven** destinations + two pinned — Calendar was added as a destination in commit `3a06340`, `app-sidebar.tsx`; the earlier "exactly six" text here and in BUILD_REFERENCE §2 was behind the code):

```
Home · Approvals (badge = pending count) · Activity · Conversations · Customers · Calendar · Receptionist
────────────────────────────────────────
Numbers & Billing · Settings          (pinned bottom)
```

Consolidations already executed (all legacy routes are redirect stubs, audit 08): agent/agents/agents-build → **Receptionist** · chat (Ask Gradia) → **Conversations** · leads + recovery → **Customers** · `/schedule` → `/calendar`.

**Known IA tension (reframed 2026-07-27):** the Calendar destination shipped ahead of the planning docs — decision queue **Q-15** now asks the founder to *ratify or revert* it (ratification amends BUILD_REFERENCE §2). Contradiction C-15 in `16-document-source-map.md` records the drift; the stale "exactly these six" code comment rides P0-010.

**Target IA (recorded, not adopted — Q-23):** the founder master definition (2026-07-27) recommends a 9-item navigation: **Home · Inbox · Calendar · Customers · Sales · Jobs · Gradia · Reports · Settings**. This is held in decision queue **Q-23** as the convergence target, phase-by-phase: Sales → E03, Jobs → E04, Reports → E08 (Q-16), Gradia → E09, Inbox (consolidating Approvals/Conversations/Activity) → Q-23. Each promotion is a BUILD_REFERENCE §2 amendment via the queue — never a silent addition. Until a Q-23 resolution, the shipped IA above stands.

## 2. Screen inventory (current)

| Screen | Content (authority: BUILD_REFERENCE §3) |
|---|---|
| **Home** | Amended 2026-07-16: analytics header pinned on top and IS the ROI receipt (conservative, row-traced, split upcoming revenue) → AgentHomeBar (owner agent inline, expands to BiChat on `/api/agent/chat`) → KPI sparkline row → today's bookings → recent Activity. No nudge cards. |
| **Approvals** | "Waiting on you." The one HITL inbox: Approve / Edit & approve / Dismiss — never binary. |
| **Activity** | Reverse-chronological glass-box feed; outcome badge, AI/human flag, "because" line only where decision-log data exists. "Needs review" filter deep-links to Approvals. |
| **Conversations** | Calls + SMS unified today (email pending P7); caller, time, one-line summary, outcome badge. |
| **Customers** | One file per person; channels stitched; recovery is a flow inside customer context. |
| **Receptionist** | Progressive disclosure: 5 up-front settings, rest behind Advanced. (Catalog copy is stale — P0-010.) |
| **Numbers & Billing** | Numbers, plan, packs, usage pill ("~200 texts · ~20 calls", credits in fine print). |
| **Settings** | Connections (ConnectionTile 3-state), shop profile, service menu, automations, advanced/MCP behind disclosure. |
| **Calendar** | Week view + working hours (shipped as the seventh destination — ratify/revert in Q-15). |
| `/calls/[callId]`, `/q/[token]`, `/onboarding` | Call glass-box record · public quote page · 5-step wizard. |

## 3. Composer rules (locked)

- **⌘K/Whisper is the primary composer** — desktop ⌘K, mobile bottom composer with tap-to-talk. Retoken, never demote (the Home AgentHomeBar surfaces it inline; ⌘K itself stays).
- The composer is **never the only path** to any action.
- Chrome copy is NARRATOR voice from `strings.ts`; agent-authored content is CHARACTER voice from `persona.ts` — untouchable.

## 4. Where future surfaces land (P1–P10)

Placements chosen to preserve the current shipped IA; items that likely force an IA change are flagged to the decision queue rather than decided here. The per-phase convergence toward the founder's 9-item target IA is governed by Q-23.

| Future surface | Phase | Proposed home | IA impact |
|---|---|---|---|
| Team members, roles, invitations | P1 | **Settings → Team** section (invite, role, remove); member attribution appears on Activity entries and job records | None — Settings absorbs it |
| Trial state / subscription | P3 | **Numbers & Billing** (trial meter, allowances, convert CTA); topbar usage pill gains trial framing | None |
| Native calendar & availability | P2 | `/calendar` grows into the availability authority (working hours, conflicts, external-sync status) | **Q-15** (reframed): the Calendar destination already shipped — ratify it (amending BUILD_REFERENCE §2) or revert. Recommendation: ratify — a scheduling OS (D-001) hiding its calendar is untenable |
| Jobs & work orders (team ops) | P4 | Job detail stays inside **Customers** (customer file → job) + day/dispatch view inside Calendar destination (per Q-15); assignment chips ride on P1 members | Medium — no new destination if Q-15 resolves to promote Calendar |
| Invoices & payments | P5 | Invoice lives on the job/customer file; shop-level payment reporting in **Numbers & Billing**; payment request actions through Approvals (ALWAYS_HITL) | None |
| Recurring jobs | P6 | Setup from job completion + customer file; schedule instances render in Calendar | None |
| Memberships | P6 | **Customers → Memberships** segment view + per-customer membership panel; plan config in Settings | None |
| Fleet accounts | P6 | **Customers → Companies/Fleets** (company file = fleet account: vehicles, visits, terms) | Low — Customers gains a company entity view |
| Communication parity (email in inbox, composer, templates) | P7 | **Conversations** (email threads + in-thread reply); template library in Settings | None |
| Reports | P8 | Home analytics header remains the daily surface; a **Reports** view for funnels/campaign/export — proposed under Numbers & Billing initially | **Q-16** if reports outgrow that placement (eighth destination) |
| Opportunity Engine | P9 | Ranked "money on the table" module on **Home** (replacing nothing; nudge-card rules still apply — it is a data module, not a nudge) + Activity for its trail | None, but must pass the no-nudge-cards rule (§8-A5/A8) — **a design spec is required before E09 ticket cutting** (added 2026-07-27); "Gradia" as its own destination is a Q-23 option |
| Autonomy graduation UX | P9 | **Receptionist** (per-agent mode control, evidence panel from `trust.ts`) | None |
| Support/ops surfaces (health, incident banners) | P10 | Global banner system + Settings → Status | None |

## 5. Mobile / PWA implications (D-020)

- The sidebar destinations collapse to a bottom tab bar (Home · Approvals · Conversations · Customers · More) — exact set to be validated in `ui/responsive-rules.md`; Approvals badge must survive collapse.
- Every flow in `ui/flows/` defines its mobile behavior explicitly; the go-live smoke already requires the <60s phone loop (capture lead by voice → approve → read receipt).
- PWA (P8/E08): installability, offline read of today's schedule and approvals queue (write actions require connectivity — approvals are never queued offline without explicit design), push notification for new approvals (analytics event + permission prompt rules in `14-product-analytics.md`).
- Wide content scrolls in its own container; dashboard motion stays 100–150ms; cinematic layer remains public-pages-only.

## 6. Rules that bind any IA change

1. No new sidebar destination without a decision-queue entry + founder approval (BUILD_REFERENCE says "Sidebar exactly").
2. Approvals is the ONE HITL inbox — no surface duplicates it; new features deep-link into it.
3. Every owner card has an owner-clickable action (UX spec rule, still in force).
4. No vendor names/env vars/raw enums on owner-visible surfaces (rename map).
5. Empty states are written before the screen ships (`strings.ts`), loading/error/success states required per `12-definition-of-done.md`.

## 7. Required UI standards — additions (founder master definition, 2026-07-27)

Two founder-required standards not previously recorded here:

- **Global search.** Cross-entity search (customers, vehicles, quotes, jobs, conversations) is a required product standard. Note: **⌘K today is a composer (verbs), not search** — the two must not be conflated; whether search lives inside ⌘K or as its own affordance is a design choice for the phase that first ships it (E03 has the first real corpus). Until designed, no doc may claim Gradia "has global search."
- **Consistent quick-create.** One consistent quick-create pattern (customer, lead, quote, appointment, job as each domain lands) — today only the pipeline "New lead" quick-create exists. Extend the same pattern per phase; never one-off per screen.

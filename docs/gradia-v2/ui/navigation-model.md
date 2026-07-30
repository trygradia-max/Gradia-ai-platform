# UI — Navigation Model

_Created 2026-07-25 by the Organizer. Condenses `platform/docs/BUILD_REFERENCE.md` §2 (final IA, spec §8-A4) and records where future-epic surfaces land. The full future-surface analysis lives in `../06-ui-information-architecture.md`._

## The sidebar (shipped IA — do not add destinations casually)

**Corrected 2026-07-27 (C-15):** seven destinations, plus two pinned at the bottom — Calendar shipped as a destination in commit `3a06340`; the earlier "exactly six / verified in code" text here was stale (the audit-doc-08 verification predated that commit):

```
Home
Approvals          ← badge = pending count
Activity
Conversations
Customers
Calendar           ← shipped ahead of the docs — ratify/revert in Q-15
Receptionist
────────────────
Numbers & Billing  (pinned)
Settings           (pinned)
```

The stale `app-sidebar.tsx` code comment ("exactly these six") is a P0-010 cleanup item. The founder's 9-item target IA (Home/Inbox/Calendar/Customers/Sales/Jobs/Gradia/Reports/Settings) is held in decision queue **Q-23** — convergence is per-phase, never silent.

## Consolidation map (legacy → final)

All legacy routes are redirect stubs, none in nav:

| Legacy | Lands at |
|---|---|
| `/agent`, `/agents`, `/agents/build` | `/receptionist`, `/receptionist/build` |
| `/chat` (Ask Gradia) | `/conversations` (preserves `?c=`) |
| `/leads` | `/customers` |
| `/recovery` | `/customers/recovery` |
| `/schedule` | `/calendar` |
| `/` | `/dashboard` |

Known defect: four server actions still `revalidatePath` legacy targets (`/agents`, `/recovery`, `/leads`) — fix rides P0-010.

## Deep-link rules

- Activity's "Needs review" filter **deep-links to Approvals — never duplicates it**. One HITL inbox, period.
- KPI "Needs your review" tiles on Home link to Approvals.
- Call rows link to `/calls/[callId]` glass-box records.
- Quote public pages live outside the shell at `/q/[token]`.

## The command bar

The **⌘K/Whisper command bar is the primary composer** — desktop ⌘K, mobile bottom composer with tap-to-talk. Rules: retoken it, never demote it; it is **never the only path to any action**. The Home `AgentHomeBar` (2026-07-16 amendment) surfaces the same agent inline and expands into BiChat on `/api/agent/chat`; ⌘K itself stays undemoted.

## Topbar

Usage pill in **human units** ("~200 texts · ~20 calls"), credits in fine print. Never lead with raw credit numbers.

## Where future surfaces land (planning direction — final placement in `../06-ui-information-architecture.md`)

| Future capability (epic) | Proposed home | IA risk |
|---|---|---|
| Jobs / work orders (E04) | Calendar + job detail under Customers today; a dedicated **Jobs** destination is a likely promotion — held in **Q-23** (target IA), not assumed | Medium — first real pressure on the destination count |
| Invoices & payments (E05) | Numbers & Billing (owner money) + payment state on job/quote records | Low |
| Memberships / recurring / fleets (E06) | Inside Customers (per-customer) + a management surface under a Jobs-or-Operations destination | Medium — rides the E04 decision |
| Team & roles (E01/E04) | Settings → Team | Low |
| Reports (E08) | Numbers & Billing grows into reporting, or Home analytics deepens | Low |
| Online booking config (E02) | Receptionist (it is the shop's front door config) or Settings | Low |

Rule: any added or renamed destination is an IA amendment — BUILD_REFERENCE §2 update via the decision queue (Q-15/Q-23), never a silent addition. Calendar shipping ahead of this rule is exactly the drift the rule exists to prevent; it is recorded (C-15), not excused.

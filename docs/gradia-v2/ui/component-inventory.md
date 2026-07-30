# UI — Component Inventory

_Created 2026-07-25 by the Organizer. Condenses `platform/docs/BUILD_REFERENCE.md` §6 and `_docs/redesign/COMPONENT-SOURCING-MAP.md` (binding), plus the Home rebuild additions and audit doc 08 findings. Rule one: **build/extend, don't reinvent.**_

## Sourcing rules (binding, from the sourcing map)

- **shadcn/ui primitives underneath** (style `base-nova`), existing paths `components/ui/` + `components/gradia/`.
- Imports are **retokened before commit** and only **at the layer that uses them** — never fork primitive internals.
- **No new Base UI components — the Radix/Base UI mix is frozen.**
- Charts: **Recharts/Tremor copy-paste** (Layer 3), retokened to the one-accent chart palette.
- New component = last resort; document it here when it happens.

## Existing components (extend these)

| Component | Notes / status |
|---|---|
| Sidebar + NavItem | Shipped IA rendered (`app-sidebar.tsx`) — seven destinations incl. Calendar (C-15; ratify/revert in Q-15); stale "exactly these six" code comment fix rides P0-010 |
| SetupProgressPill | Onboarding progress |
| SectionHeader | Eyebrow + Geist-600 headline + subhead |
| KpiCard | `.font-data` numbers; delta chips only with real prior-period rows |
| Data tables w/ density toggle | Collapse to cards on mobile |
| HeatBadge | Deterministic heat heuristic — labeled, never a percentage |
| StatusPill | Semantic tokens only, icon + text |
| ChannelTile + ConnectionTile | ConnectionTile is the 3-state pattern: NOT CONNECTED → CONNECTING… → CONNECTED (✓ + identity + Manage); OAuth in centered popups |
| AgentCard (w/ mode control) | Autonomy mode UI; ALWAYS_HITL floor never presented as toggleable |
| ApprovalCard | Three-way: Approve / Edit & approve / Dismiss |
| ActivityEvent | Outcome badge, AI/human flag, "because" line only where decision-log data exists |
| NudgeCard | Language Pack §4 — **engine is post-alpha; no nudge cards on Home** (§8-A5/A8) |
| ChatThread / Composer | BiChat panel; `/api/agent/chat` + `/api/bi/chat` |
| VoiceCapture | Whisper tap-to-talk |
| EmptyState | Always written |
| Glass-box call components | `components/glassbox/` (Layer 4), `/calls/[callId]` |
| **HomeAnalytics** | New (Home rebuild Phase 2) — stat tiles → weekly revenue chart → receipt proof strip; inherits the receipt's sacred discipline |
| **AgentHomeBar** | New (Phase 3) — slim composer expanding into BiChat; ⌘K undemoted |

## Known inventory debt (audit doc 08 — cleanup rides P0-010)

- **Orphans to delete:** `co-owner-card.tsx` (+ `data/co-owner.ts`), `schedule-groups.tsx`, `data/revenue.ts`, `data/today-money.ts`, `data/interactions.ts`, unused `ui/badge.tsx`, `ui/scroll-area.tsx`; dead flag `FEATURES.askGradiaPage`.
- `RevenueTiles` / `TodayMoneyRows`: removed from Home by the rebuild; delete once nothing references them (per HOME_REDESIGN_PLAN Phase 4).
- Raw amber classes in settings cards → status tokens.

## Planned components for future epics (design before build; none exist today)

| Component | Epic | Notes |
|---|---|---|
| JobBoard / WorkOrderCard / ChecklistItem | E04 | Assignment + status machine surfaces; reuse status pills, timeline patterns |
| InvoiceView / PaymentStatusPill / DepositRequestCard | E05 | Money surfaces — `.font-data`, immutable-record framing, ALWAYS-HITL affordances |
| MembershipCard / PlanUsageMeter | E06 | Mirrors the existing usage-pill pattern |
| RecurrenceEditor | E06 | Constrained recurrence, not a cron builder |
| FleetAccountHeader / VehicleRosterTable | E06 | Builds on vehicles table + data tables |
| AvailabilityGrid / ConflictWarning | E02/P0-004 | ConflictWarning ships earlier with P0-004 on approval cards |
| InboxThread w/ reply composer (email) | E07 | Extends ChatThread; one send path preserved |
| ReportCard / FunnelChart | E08 | Recharts/Tremor, one-accent palette |
| ImportWizard (staging→mapping→preview→rollback) | E03 | Generalizes the recovery review-queue pattern (D-022) |

Rule: each planned component gets a short spec in its epic before build; additions land in this inventory in the same PR that creates them.

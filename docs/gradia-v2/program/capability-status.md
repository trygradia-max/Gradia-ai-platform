# Program — Capability Status

_Created 2026-07-25 by the Organizer. Compact live status board. **`../04-capability-map.md` governs** — this is a summary the Organizer keeps in sync; on any discrepancy, 04 wins. Status vocabulary: not planned / planned / designed / building / internal / pilot / public / deprecated. A capability is never marked further along because a table or page exists._

| # | Capability | Phase | Status | Next step (one line) |
|---|---|---|---|---|
| 1 | Platform foundation | P0 / P10 | pilot | P0-002 done 2026-07-30 (CI gates blocking, PR #9); P0-001 in-review; P0-010/011/012 remain in the stabilization batch |
| 2 | Organizations | P1 | pilot | Single-owner shops work; members model (E01) unlocks the rest |
| 3 | Members, roles and permissions | P1 | planned | E01: members table + policy indirection + invitations |
| 4 | Locations and resources | P4 | planned | Model with E04 (jobs/teams); nothing exists today |
| 5 | Customers and companies | P3 | pilot / planned | Direct create/edit/export (Q-03); companies are net-new |
| 6 | Vehicles and service history | P3 | pilot | VIN/trim fields + per-vehicle history view |
| 7 | Leads and pipeline | P3 / P8 | pilot | Retire legacy `status` enum; funnel analytics later (P8) |
| 8 | Quotes and deposits | P0 / P5 | pilot / planned | P0-009 repairs accept→book + expiry; deposits wait for E05 |
| 9 | Calendar and availability | P0 / P2 | building / designed | P0-003/004 conflict enforcement; E02 native source of truth (D-013) |
| 10 | Jobs and work orders | P4 | pilot / planned | Status machine exists; assignments/checklists need E01 roles |
| 11 | Invoices and payments | P5 | planned | Stripe Connect first (D-019); flagged-off foundation exists |
| 12 | Recurring jobs | P6 | planned | Separate domain (D-017); maintenance_schedule armed, unconsumed |
| 13 | Memberships | P6 | planned | Separate domain; billing rides on E05 |
| 14 | Fleet accounts and service | P6 | planned | Separate domain; nothing exists today |
| 15 | Communications | P0 / P7 | pilot / planned | P0-006/008 fixes now; email inbox + composer in E07 |
| 16 | Imports and exports | P3 | internal | Recovery import real; structured wizard to D-022 bar; exports missing |
| 17 | Reporting | P8 | building | Home analytics exemplary; funnels/campaign analytics/daily brief missing |
| 18 | Gradia Agent | P1 / P9 | pilot | Strongest subsystem; LLM seam + eval gating (E01) mature it |
| 19 | Opportunity Engine | P9 | designed | Pieces exist (whisper sweep, revival, schedules); unify in E09 |
| 20 | Voice receptionist | P0 / P9 | internal | Live acceptance run pending — not claimable until it passes |
| 21 | Earned autonomy | P9 | internal | trust.ts recommendations exist; graduation UX in E09 |
| 22 | Integrations | P1–P3 | pilot (mixed) | HCP unverified live; A2P SIDs unverified; LLM seam missing |
| 23 | Trial and subscription billing | P0 / P1 | pilot / planned | Billing loop is beta-grade; trial model waits on Q-13 (D-005) + Q-22 (D-031 pricing) |
| 24 | Security and privacy | P0 / P10 | building | P0-001 first; then P0-011; GDPR deletion/export at P10 |
| 25 | Reliability and observability | P0 / P10 | building | P0-005/006/007/012 now; outbox/queue + logging at P10 |
| 26 | Support operations | P10 | planned | No support tooling exists; scope with pilot feedback |
| 27 | Responsive PWA | P8 | planned | Responsive today; installable/offline PWA in E08 (D-020) |
| 28 | Marketing website | P0–P8 | building | Claims discipline (D-028); category/headline decided (D-033); pricing page waits on Q-22 |

_Update rule: the Organizer edits this file when a capability's status transitions in 04 (with the acceptance evidence 04 requires), at sprint boundaries, and at every release. **This board is regenerated from 04's summary table whenever 04 changes — any phase/status drift between the two files is a defect** (reconciled 2026-07-27: 11 drifted rows corrected to match 04)._

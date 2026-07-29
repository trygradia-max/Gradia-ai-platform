# Flow — Onboarding

_Created 2026-07-25 by the Organizer. Grounded in audit trace K (shop creation) and `_docs/GRADIA_UX_ONBOARDING_SPEC.md` (wizard content still valid; 3-page IA superseded — see source map C-07)._

**Maturity:** EXISTS — 5-step wizard (shop → service menu → inbox → number → receptionist), **steps 2–5 skippable** (corrected 2026-07-27: Services has an unconditional Continue with a zero-services warning — only step 1 is required; matches `../../07-onboarding-and-imports.md` §1), zero founder-touch (audit trace K). Target extensions: trial start (D-005, activation-gated per D-032/Q-13) and an import step (D-006) — E03/P3. The full 12-step target flow (five workflow templates, payments/team steps, simulated-workflow validation, readiness gate) is specified in `../../07-onboarding-and-imports.md` §2b — this doc covers the live wizard only.
**Phase/Epic:** Live today; extensions ride E03.

## Entry point
Supabase signup → any dashboard route → `requireShop()` finds no shop → redirect to `/onboarding`.

## User objective
Go from "just signed up" to a shop that can capture leads, quote from a real service menu, and (optionally) answer the phone — without talking to a human.

## Required data
Shop name, timezone, contact identity (required); service menu (starter template one tap, or manual); email/calendar OAuth (optional); number provisioning + A2P business details (optional); receptionist config (optional).

## Exact steps
1. **Shop** — name, timezone, basics → `saveShop` upserts by owner, sets `settings.onboarding_done:false`, pins active-shop cookie. (Required — the only non-skippable step.)
2. **Service menu** (skippable) — apply the detailer starter template (`applyDetailerTemplate`) or add services manually. No defaults are seeded silently; continuing with zero services shows a written warning.
3. **Inbox** (skippable) — connect email/calendar via Aurinko OAuth popup (see `calendar-connection.md`).
4. **Number** (skippable) — provision a Gradia number (Twilio subaccount) or BYO; A2P registration collects business details.
5. **Receptionist** (skippable) — voice builder; requires Package 2 entitlement to go live (see `voice-receptionist-setup.md`).
6. **(TARGET, D-005/D-006)** — trial starts with operational allowances stated in human units; offer "Import your customers" (see `crm-import.md`) before first use.

## System decisions
- Multi-shop per owner supported (`?new=1` + switcher); plan defaults to `free` — paywall gates run/send downstream, not the dashboard.
- Working hours default in code (9–5×7) until edited.
- Nothing is provisioned per-shop by the founder — every step is self-serve (locked principle #9).
- TARGET: trial allowance caps fail closed (existing credit machinery), numbers pending decision queue Q-13.

## AI involvement
None during the wizard itself. AI features activate afterward and default to suggest-HITL.

## Permissions
Owner only today (single-user tenancy). After E01/P1, only owner/admin roles may run onboarding or edit shop settings; invited members skip the wizard.

## Error states
- Shop save fails → inline error, values preserved, retry.
- OAuth popup denied/closed → tile returns to NOT CONNECTED with "Connection didn't finish — try again."
- Number purchase fails (e.g. missing `ENCRYPTION_KEY` server-side) → fail-closed with named next step; step remains skippable.
- A2P rejection → status surfaced with the carrier reason; wizard continues, SMS gated until approved.

## Empty states
- Menu step before any service: "Your menu is empty. Start with the detailer template — you can edit every price." (written, per design system; copy in `strings.ts`).

## Success state
Wizard complete → `/dashboard` with the written zero-state analytics header; skipped steps surface as ConnectionTiles/setup pill, never blockers.

## Next recommended action
Import customers (trial) or "Add your first lead" / connect calendar — whichever step was skipped first.

## Mobile behavior
Full wizard usable on a phone: single-column steps, OAuth in popups that return correctly, tap-to-talk deferred until receptionist test call. PWA install prompt lands post-E08.

## Analytics events
`Account created` (signup), `Business profile completed` (step 1 saved), `Service menu configured` (step 2 saved), `Calendar connected` (step 3), `Import started`/`Import completed` (target step 6).

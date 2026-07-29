# Flow — Calendar Connection

_Created 2026-07-25 by the Organizer. Grounded in the Aurinko OAuth flow (audit trace G/§Connections in BUILD_REFERENCE §4) and D-013/D-014 (Gradia DB becomes appointment source of truth; Google + Microsoft are synchronized integrations)._

**Maturity:** EXISTS — Aurinko OAuth in a centered popup, ConnectionTile with three states (NOT CONNECTED → CONNECTING… → CONNECTED ✓ + identity + Manage), CSRF-nonce-protected callback, encrypted tokens, transparent refresh. Target: Microsoft/Outlook sync and the source-of-truth inversion (booking no longer hard-requires a connected calendar).
**Phase/Epic:** Live today; inversion + Microsoft ride E02 / P2.

## Entry point
Onboarding step 3, or Settings/Connections tile, or the fail-closed prompt when approving a booking with no calendar connected (current behavior — removed in E02).

## User objective
"Gradia knows my calendar": bookings land on the calendar the owner actually looks at, and busy time blocks Gradia's scheduling.

## Required data
Google (today) or Microsoft (target) account with calendar scope.

## Exact steps
1. Owner clicks **Connect** on the calendar ConnectionTile.
2. Centered OAuth popup opens (`/api/aurinko/auth/start`, CSRF nonce cookie set).
3. Owner grants access; callback verifies state, exchanges tokens (AES-256-GCM at rest), subscribes webhooks.
4. Tile flips CONNECTING… → CONNECTED with the account identity and a Manage action; parent page polls popup completion.
5. **(TARGET, E02)** Initial sync: existing external events imported as busy time; Gradia appointments become the system of record and mirror outward (D-013); external edits sync back as busy/mirror updates (D-014).

## System decisions
- Today: `executeBookAppointment` hard-requires the connection (fails closed at `approvals.ts:686`) — E02 removes this; booking must work with no external calendar.
- Target sync conflict rule: Gradia's row wins for Gradia-created appointments; external events are busy-time inputs to availability (P0-003 service).
- One tile per provider; no vendor names beyond the provider brand the owner chose (rename map).

## AI involvement
None in the connection itself. Downstream, AI booking proposals consume availability; money + calendar writes remain ALWAYS-HITL.

## Permissions
Owner today. Post-E01: owner/admin connect/disconnect; members see status only.

## Error states
- Popup closed/denied → tile back to NOT CONNECTED, "Connection didn't finish — try again."
- Token refresh failure → tile shows NEEDS RECONNECT (target: owner-facing reconnect alert — audit gap "no owner-facing reconnect alerts").
- Webhook subscribe failure → connection retried/fail-closed, never silently half-connected.

## Empty states
Not applicable (tile always renders one of its three states); Connections page first-use copy teaches what each connection unlocks.

## Success state
CONNECTED tile with account identity; next booking approval shows the real calendar destination; (target) availability reflects external busy time.

## Next recommended action
Book or approve the first appointment; set working hours if defaults were never edited.

## Mobile behavior
OAuth popup falls back to full-screen sheet on mobile and returns to the tile; three-state tile unchanged.

## Analytics events
`Calendar connected`.

# Flow — Team Setup

_Created 2026-07-27 by the Organizer (audit correction: no team-invitation/staff-assignment flow existed despite E01/E04 target flows elsewhere). Governed by D-018 (tenancy before schema expansion) and the Q-17 role taxonomy (owner/admin/tech recommended, undecided)._

**Maturity:** TARGET — single-owner tenancy today (`shops.owner_id`, zero member tables). Everything below lands with E01; bay/resource assignment with E04.
**Phase/Epic:** E01 / P1 (invite, roles, revoke); E04 / P4 (staff-to-job/bay assignment, availability).

## Entry point
Settings → Team (per `06-ui-information-architecture.md` §4); onboarding target step 6 (`07-onboarding-and-imports.md` §2b) once E01 ships.

## User objective
Get an employee into the shop's Gradia with the right access in under a minute — and out again just as fast when they leave.

## Required data
Member email, role (Q-17 taxonomy), location access (multi-location shops, target), staff profile (display name, what they work on — feeds E04 assignment), invitation state.

## Exact steps
1. Owner/admin opens Settings → Team → Invite: email + role (+ location access where locations exist).
2. Invitation issued (expiring token, resendable, revocable while pending); pending invites listed with state.
3. Invitee accepts → account joins the shop with the assigned role; **no onboarding wizard re-run** (members skip it — `onboarding.md` §Permissions); lands on a role-appropriate Home.
4. Role visibility applies immediately: techs see assigned-job threads/jobs only (Q-17 matrix); admin ≈ owner minus billing/danger zone (exact matrix = E01 ticket scope).
5. Staff profile completed (name, skills/services) → member becomes assignable in E04 job scheduling; bay/resource assignment rides E04.
6. Change role / revoke: immediate effect, sessions invalidated on revoke; audit entry records actor, target, before/after (audit actor identity — founder requirement).

## System decisions
- Roles start minimal and expandable (Q-17: owner/admin/tech recommended) — no custom permission builder (founder delay list).
- Every action's actor is recorded — approvals, edits, sends attribute to the member, not just "the shop" (extends the existing decider-recorded pattern).
- Tenant isolation is mechanism, not discipline: member access enforced by RLS/policy indirection (E01), covered by tenant-isolation tests (08 §2).
- Invitations are the only join path — no open shop discovery, no email-domain auto-join.

## AI involvement
None in the flow itself. Post-E01, member roles bound what AI surfaces show (approval rights role-scoped per `approval-action.md` §Permissions).

## Permissions
Invite/role-change/revoke: owner (and admin, per the Q-17 matrix resolution). Members cannot elevate their own role.

## Error states
- Invite to an email already in another shop → supported (multi-shop membership) or named-reason block — E01 ticket decides; never a silent failure.
- Expired invitation → clear expired state with one-tap resend.
- Revoked member holds an open session → next request 403s to a written "access removed" screen; no partial access.
- Last-owner protection: the sole owner cannot demote/remove themselves.

## Empty states
- "Just you so far. Invite your first teammate — they'll see only what their role allows."

## Success state
Member listed active with role and location access; their actions appear attributed in Activity from their first session.

## Next recommended action
Assign the new member to today's jobs (E04) or set their working hours (E02/E04 availability).

## Mobile behavior
Invite/accept fully usable on phone (invitees will open the email there); team list manageable in one column; role changes confirmed explicitly.

## Analytics events
`Member invited`, `Member joined` (time-to-accept), `Member role changed`, `Member removed` — activation milestone: `Second user active` (a real multi-user shop).

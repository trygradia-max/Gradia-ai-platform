# E01-03 — Invitation flow (send / accept / revoke), role checks at action boundaries, role-aware navigation

_Cut 2026-09-01 by the Organizer for autorun Batch 2 (`../program/autorun.md`). Specification only._

## Ticket ID
E01-03

## Epic
E01 — Organization, tenancy and backend foundation (phase P1)

## Status
**draft — batch-gated.** Autorun Batch 2, queue item 7. Enters after E01-02 is committed. Risk class **standard** (UI + server actions on E01-01's schema; no migration expected). Founder acceptance **no** (autorun table). Decisions binding: D-048 (owner/admin/tech), D-036, D-046/D-049 (IA unchanged: Team lives under Settings; no new destination), D-045 (member events → own-DB table if present). No open decision.

## Priority
P1 — High. E01 acceptance criterion 1 ("owner invites a second user; they accept, sign in, operate under role limits; removal revokes access immediately") and D-036's launch requirement. Settings today shows a placeholder: "Team and billing controls land here next." (`settings/page.tsx:489-495`).

## Objective
Ship the Team card under Settings: invite by email + role, pending/expired/revoked states, accept page for new or existing auth users, role change, removal with immediate session invalidation, last-owner protection surfaced; enforce role floors at every server-action boundary (`requireMember(minRole)`), and make navigation and Billing/Numbers visibility role-aware. Attribute approvals/activity to the member who acted.

## User outcome
An owner types a teammate's email, picks admin or tech, and the teammate is in within a minute, seeing only what their role allows. Removing them locks them out on their next request. Approvals and Activity say which person decided.

## Current code references
- Schema + helpers from E01-01: `members`, `invitations` (token_hash, expiry, single-use), `is_shop_member()`, `requireMember()` in `src/lib/members.ts`, last-owner trigger, `decided_by_member_id`.
- Settings page: `src/app/(dashboard)/settings/page.tsx` (single page; placeholder `:489-495`; no `/settings/team` route).
- Sidebar: `src/components/gradia/app-sidebar.tsx:48-61` (seven + two pinned; comment `:43-47` locks the IA); render loops `:116-131,137-146`.
- Auth: Supabase Auth email flows (`src/app/auth/callback/route.ts`), login page `/login`; onboarding wizard `src/components/gradia/onboarding-wizard.tsx` (members must **skip** it — `ui/flows/team-setup.md` step 3, `onboarding.md` §Permissions).
- Server actions to gate (representative, full list by grep of `requireShop()` callers): billing `src/app/actions/billing.ts`, autonomy `src/app/actions/autonomy.ts`, agents/automations, settings/shop mutations `src/app/actions/shop.ts`, approvals decisions `src/app/actions/approvals.ts`, recovery import/undo `src/app/actions/recovery.ts`, working hours, voice builder, twilio provisioning, payments/Stripe Connect (flagged off), exports (E03-01 later).
- Email sending for invites: today only through the Aurinko owner mailbox (`approvals.ts:1979-1994`) — **not suitable** (a shop's own Gmail should not send platform invites; many shops have no mailbox connected). Transactional email is a `vendors/planned-evaluations/transactional-email.md` category with no vendor selected → see scope 3 for the no-new-vendor path.
- Strings: `src/lib/strings.ts` (chrome copy); `ui/flows/team-setup.md` (steps, error/empty/success states, analytics events); `06-ui-information-architecture.md` §4.
- Activity/approvals detail components: `src/components/gradia/*approval*`, activity feed (`/activity`), `trust.ts` decider telemetry.

## Exact scope
1. **Team card (Settings):** list active members (name/email, role, joined), pending invitations (email, role, expires, Resend, Revoke), Invite form (email + role ∈ {admin, tech}; owner role assignable only by an owner via "transfer/add owner" — keep to add-owner in this ticket, transfer is out), Change role, Remove; last-owner protection surfaced as a disabled control with written reason; written empty state ("Just you so far…"), loading skeleton, error states. No new sidebar destination (D-049).
2. **Server actions:** `inviteMember`, `resendInvitation`, `revokeInvitation`, `acceptInvitation(token)`, `changeMemberRole`, `removeMember` — zod-validated, `requireMember('admin')` for invite/revoke/role-change/remove (owner-only for owner-role grants and for removing an admin — matrix documented), rate-limited invite sends (existing `rate-limit.ts` bucket), audit entry per action (actor, target, before/after) written to `action_decisions`-style audit or a small `member_audit` jsonb on `members` — Builder chooses **without a new table** unless unavoidable (if a table is needed → additive migration and the DB slot; state it at slotting).
3. **Invitation delivery (no new vendor):** invitation email sent through **Supabase Auth's invite/magic-link flow** (`auth.admin.inviteUserByEmail` or `generateLink` + the platform's existing auth email sender) carrying a redirect to `/invite/[token]`; the invitation row is the authorization (Supabase's link only authenticates). Copy in `strings.ts`; the from-identity is the platform's auth sender (zero founder touch per shop). If Supabase invite emails prove unusable for existing auth users, fall back to a magic link to the same accept URL. A dedicated transactional-email vendor remains a planned evaluation (not adopted here).
4. **Accept page `/invite/[token]`:** unauthenticated → sign in/sign up (existing auth) → on return, validate token (hash match, unexpired, unrevoked, unaccepted, email matches the signed-in user's email — or explicit "sign in as the invited address" state), create the member row, mark accepted, set the active-shop cookie, land on a role-appropriate Home; **skip onboarding wizard** for members (guard in the onboarding redirect). Expired → written state with Resend request; already-a-member → idempotent success.
5. **Role floors at boundaries:** every server action mutating billing, autonomy mode, agent/automation config, integrations/connections, shop settings, imports/undo, provisioning → `requireMember('admin')` (owner ⊇ admin); billing checkout/portal + shop deletion → `requireMember('owner')`; approvals decide/edit → admin (tech decisions are E04-04's scoped exception — none here); read-only actions unchanged. Permission tests per action per role (E01 epic testing requirement). Wrong role → typed refusal rendered as a written "needs an admin" state, never a crash.
6. **Role-aware navigation:** sidebar hides Numbers & Billing for `tech`; Settings shows only the sections a role may edit (tech: profile + notifications only); Receptionist/automation controls admin+; approvals visible to admin+ (tech sees Approvals only if E04-04 later scopes it — hidden now). `app-sidebar.tsx` comment updated (still seven + two; visibility per role, not a new IA).
7. **Attribution:** Approvals detail + Activity entries show the member (name) who decided/acted, from `decided_by_member_id` (E01-01); ROI receipt/agent copy unchanged.
8. **Session invalidation on removal:** removed member's next request → `requireShop` resolution fails for that shop → written "Access removed" screen (`/access-removed` or an inline state), cookie cleared, fallback to another membership if any.
9. **Analytics:** `Member invited`, `Member joined`, `Member role changed`, `Member removed`, milestone `Second user active` — emitted to the D-045 events table if it exists; otherwise recorded as pending instrumentation in `14-product-analytics.md` (no vendor).
10. Docs: `ui/flows/team-setup.md` maturity → LIVE (behind flag), `06-ui-information-architecture.md` §4, `04-capability-map.md`, `program/capability-status.md`, `08-security-and-reliability.md` permission matrix.

## Explicit non-goals
- No per-record ACLs, no custom roles, no owner transfer, no multi-location access, no SSO.
- No tech-scoped data views (E04-04) — techs simply see less navigation and no billing/autonomy controls; job-level scoping is E04.
- No transactional-email vendor adoption.
- No shop switcher redesign beyond membership-aware listing (E01-01 did the data side).

## Dependencies
- E01-01 (schema) and E01-02 (facade) committed. CLEANUP-001 merged (Slack copy gone).
- Decisions: D-048, D-036, D-049, D-045 — Approved.

## Expected modules affected
New: `src/app/(dashboard)/settings/team-card.tsx` (or `components/gradia/team-card.tsx`), `src/app/actions/members.ts`, `src/app/invite/[token]/page.tsx`, `src/app/access-removed/page.tsx` (or inline), `eval/permissions.test.ts`. Modified: `settings/page.tsx`, `app-sidebar.tsx`, `src/lib/members.ts`, `src/lib/shop.ts` (removal handling), every gated server action (one line each), approvals detail + activity components, onboarding redirect guard, `strings.ts`, `features.ts` (`teamMembers`), `14-product-analytics.md`, flow/IA/capability docs.

## Database impact
None expected (uses E01-01 tables). If an audit table is chosen: one additive migration (state at slotting).

## Migration impact
Zero or one additive migration.

## API impact
New server actions; new `/invite/[token]` route (unauthenticated landing that requires auth to proceed).

## UI impact
Team card (list, invite form, pending list), accept page, access-removed state, role-aware sidebar/settings, attribution in Approvals/Activity — all with skeletons/empty/error/success states per DoD F; mobile: invite/accept fully usable on phone (flow doc).

## Permission impact
The role matrix (documented in `members.ts` + `08`): owner ⊇ admin ⊇ tech; billing/deletion owner-only; config/integrations/imports/approvals admin+; tech read-only baseline (data-level parity until E04-04).

## Tenant-isolation impact
Invitation acceptance binds membership to the invitation's `shop_id` (never to a client-supplied shop); token lookup by hash; RLS from E01-01 covers rows; permission tests include cross-shop negatives (admin of A cannot invite into B).

## Security impact
Tokens CSPRNG, hashed, expiring (proposal: 7 days), single-use; email-match check on accept; invite rate limit; audit trail for every membership change; removal invalidates access immediately. No open shop discovery or domain auto-join (flow doc).

## Idempotency requirements
Accept twice → one member row (unique) + idempotent success; resend rotates the token (old hash invalid).

## Observability requirements
`[members]` structured logs (shop_id, actor member id, action); SEV-3 alert on repeated failed accepts (token guessing) via the rate limiter's signal.

## Analytics requirements
Events in scope 9.

## Feature flag
`FEATURES.teamMembers` — gates the Team card + invite routes; **default true** on merge (E01-01's policies are membership-only in the integration tier and dual-accept in production until E01-01C — inviting a member works in either state). Off → card hidden, accept page shows "Team invitations aren't enabled for this shop yet" (written).

## Automated tests
- Invitation lifecycle: create/resend/revoke/accept/expired/reused/wrong-email/already-member.
- Permission matrix: each gated action × {owner, admin, tech, non-member} (table-driven).
- Removal: removed member's next `requireShop` → denied; other membership fallback.
- Last-owner: UI disabled + server refusal (trigger).
- Role-aware nav: sidebar/settings sections per role (component tests).
- Attribution: decision path stamps member id; Activity renders the name.
- Tenant-isolation: cross-shop invite/accept negatives.

## Manual acceptance procedure
1. Builder (local): owner invites a second address as tech → email/magic link received (local Supabase inbucket) → accept → lands on Home without the onboarding wizard; sidebar hides Numbers & Billing; billing action refused server-side.
2. Builder: change role to admin → billing still hidden, settings sections appear; remove member → next request shows Access removed.
3. Builder: attempt to remove the sole owner → disabled + refused.
4. Builder: approve a card as admin → Approvals detail/Activity show the admin's name.
5. Reviewer (Cursor): permission matrix spot-check; acceptance recorded in `autorun-log.md` (no founder gate).

## Failure cases
- Auth email not delivered → pending row + Resend; written state names the address.
- Invitee signs in with a different email → written mismatch state, no membership created.
- Flag off after members exist → members keep access (flag gates UI only); documented.

## Rollback strategy
Flag off hides the surface; revert the commit; members/invitations rows remain (additive, inert). No migration to unwind unless the audit table was added (then it is dormant).

## Definition of done
`../12-definition-of-done.md` plus: permission matrix test table committed; flow doc + IA + capability docs updated; analytics events recorded or marked pending in `14-product-analytics.md`; E01 acceptance criterion 1 and 5 evidenced in the close record.

# E01 — Organization, Tenancy and Backend Foundation

_Created 2026-07-25 by the Organizer. Phase: **P1**. Status: planned._

## Objective

Replace the single-owner-per-shop model with real organizations: members, roles, invitations, and permission checks — plus the two structural backends the audit flags as pre-requisites for everything after: a tenant-scoping *mechanism* for service-role paths (from P0-011's design) and the missing LLM provider seam. Set the `shops` god-table split direction.

## User outcome

A shop owner invites an employee, who signs in with their own account, sees the shop, and can do exactly what their role allows. No more shared owner logins. Nothing an employee does escapes the audit trail's "who decided" record.

## Business reason

D-018: multi-user tenancy and roles must precede major schema expansion. Audit doc 09 ranks single-owner tenancy the #1 future-rewrite risk ("touches every policy, `requireShop`, and the audit trail — introduce a members table before more tables accrete"). Every epic from E04 on assumes teams. Team shops are also the larger revenue tier.

## Current foundation

- `shops.owner_id → auth.users` with uniform RLS `shop_id IN (SELECT id FROM shops WHERE owner_id = auth.uid())` on all 28 tables (audit doc 05).
- `src/lib/shop.ts` `requireUser()`/`requireShop()` — single choke point for session→shop resolution; cookie-pinned active shop; multi-shop per owner already works.
- Resolution telemetry already records who decided each approval (`trust.ts`).
- `ai-service.ts` already has the right retry/backoff shape to generalize into the LLM seam (audit doc 12 item 8).
- P0-011 delivers the reviewed `forShop()` helper design and the service-role usage inventory (~29 files).

## Missing work

1. `members` table (shop_id, user_id, role, status, invited_by, timestamps) + `invitations` (token, email, role, expiry).
2. Policy indirection: rewrite all RLS policies from `owner_id = auth.uid()` to membership lookup; keep owner as a role.
3. `requireShop()` rewrite → `requireMember(minRole)`; permission checks at server-action boundaries.
4. Invitation flow: send, accept (new or existing auth user), revoke; role change; member removal.
5. Implement the `forShop(shopId)` scoped-query helper from P0-011 across service-role paths (convert discipline to mechanism).
6. AI gateway (`ModelProvider`, D-029/ADR-002 — the LLM seam): one `llm.ts` (model registry per task tier, timeouts, retries, error taxonomy; records retries/timeouts/costs/latency/failures per D-029); migrate ~10 hardcoded call sites so no app module hardcodes a model ID; kill prod effect of `GRADIA_LLM_MODEL`.
7. `shops` god-table split *direction*: ADR for `shop_connections` (credentials out of `shops`, column privacy); execute at least the credentials slice.
8. Role-aware audit trail: `action_decisions`/`pending_actions` decider = member, not implicit owner.

## Domain entities

New: `members`, `invitations`, (`shop_connections` slice). Modified: every RLS policy; `shops` loses credential columns it sheds to `shop_connections`.

## Backend services

`src/lib/shop.ts` (rewrite), new `src/lib/members.ts`, new `src/lib/llm.ts` seam, `forShop()` helper module, invitation server actions + email send (via existing Aurinko/owner-notification path or transactional address — ADR).

## UI surfaces

Settings → Team card (list members, roles, invite, revoke); invitation accept page; role-gated visibility for Billing/Numbers (owner/admin only); "who approved" attribution in Activity/Approvals detail.

## Integrations

Supabase Auth (second/third users per shop), email delivery for invites. No new vendors.

## Security implications

Highest-leverage security epic: RLS policy rewrite must be proven equivalent-or-stricter (RLS test suite becomes mandatory here — audit doc 03 lists none today). Invitation tokens: CSPRNG, expiring, single-use. Role floor: money/billing/autonomy-mode changes = owner/admin only. The C-2 class of bug (unbound service-role claims) is structurally closed by `forShop()` adoption.

## Tenant implications

This epic *is* the tenancy change. Migration must preserve existing single-owner shops exactly (backfill: every current owner becomes a member with role `owner`). Cookie-pinned active-shop switching must respect membership, not ownership.

## Migration implications

Multi-step, database-sensitive (WIP limit: alone in flight): (1) additive tables + backfill members from owners; (2) dual-accept RLS (owner OR member) — verify; (3) flip policies to membership-only; (4) `shop_connections` slice with dual-read window. Each step reversible; never a single big-bang policy swap.

## Product analytics

No new funnel events (17-event set unchanged); adds `member_invited`/`member_joined` as candidate additions — decision queue before extending the canonical set.

## Dependencies

P0 complete (specifically P0-002 CI, P0-011 design). Decisions: D-018 (approved). Open: role taxonomy (owner/admin/tech? — decision queue Q-17), invite email sender identity.

## Risks

- RLS rewrite touches all 28 tables — a subtle policy error is a cross-tenant leak; mitigate with the new RLS test suite + staged dual-accept rollout.
- `requireShop` is imported everywhere; behavior drift breaks every page — characterization tests first.
- LLM seam migration can silently change model/params on a worker — eval suites must run per migrated call site (locked principle #6).

## Non-goals

No permissions matrix beyond a small fixed role set; no per-record ACLs; no SSO/SAML; no team *scheduling* features (E04); no full god-table decomposition beyond the credentials slice.

## Feature flags

`FEATURES.teamMembers` gates the invite UI while policies roll out dual-accept. LLM seam and forShop are not flagged (invisible refactors gated by tests).

## Testing requirements

RLS test suite (new, permanent): member of shop A cannot read/write shop B across every table. Permission tests per role per server action. Invitation lifecycle tests (expiry, reuse, revoked). Idempotent backfill test. LLM seam: eval tiers green per migrated module; grep-test that no model id exists outside `llm.ts`. `forShop`: lint/test rule that service-role query builders come from the helper.

## Rollout plan

Internal shop first → pilot shops with `teamMembers` on → default on. Policy flip (step 3) only after two weeks of dual-accept telemetry showing zero owner-only denials. God-table credentials slice last (independent).

## Acceptance criteria

1. Owner invites a second user; they accept, sign in, operate under role limits; removal revokes access immediately.
2. Every RLS policy passes the isolation suite; service-role paths use `forShop()` (enforced by test).
3. All model ids live in `llm.ts`; a simulated 429 retries instead of dropping a campaign recipient.
4. Existing single-owner shops migrate with zero behavior change (verified on a seeded clone).
5. Approvals/Activity show which member acted.

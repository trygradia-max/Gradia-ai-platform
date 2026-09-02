# E01-01 — Members, roles and invitations: schema, backfill, RLS policy indirection (owner/admin/tech)

_Cut 2026-09-01 by the Organizer for autorun Batch 2 (`../program/autorun.md`). Specification only._

## Ticket ID
E01-01

## Epic
E01 — Organization, tenancy and backend foundation (phase P1)

## Status
**draft — batch-gated.** Autorun Batch 2, queue item 5 (first ticket on `auto/batch-2`). Enters only after Batch 1 is merged (P0-013 is acceptance-gated — autorun rule 5). Risk class **tenancy + database-sensitive** (occupies both the high-risk and DB-sensitive WIP slots). Founder acceptance **YES**. Decisions binding: D-018 (tenancy before schema expansion), **D-048** (roles = owner/admin/tech), D-036 (multi-user is a launch requirement), ADR-003 (facade). No open decision blocks it.

## Priority
P1 — Critical path. Audit doc 09 ranks single-owner tenancy the #1 future-rewrite risk; every E02+ table must be born under membership policies (D-018); D-036 makes a 2+ staff shop the primary customer. Nothing in E02–E05 can start before this lands.

## Objective
Introduce `members` and `invitations`, backfill every current owner as a member with role `owner`, and rewrite the RLS predicate on every tenant-owned table from `owner_id = auth.uid()` to a membership lookup — staged as additive tables → dual-accept policies (owner OR member) → membership-only — with a permanent RLS isolation test suite. Roles are exactly owner / admin / tech (D-048). Session resolution (`requireShop`) learns membership; role enforcement at action boundaries is E01-03.

## User outcome
Invisible to owners at this ticket's end (no UI yet): every existing shop keeps working exactly as before, and the database is ready for a second person. Founder-as-operator: the C-2 class of bug can no longer hide behind "the owner is the shop".

## Current code references
- `shops.owner_id uuid NOT NULL REFERENCES auth.users(id)` — `supabase/migrations/20260507220000_gradia_core.sql:16-23` (index `:25`). No members/roles/invitations/team tables anywhere (grep verified 2026-09-01).
- RLS shapes: `shops` direct `owner_id = (SELECT auth.uid())` `:78,82,86,91`; every tenant table `shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))` `FOR ALL` (`:96-102` services, `:105-111` leads, `:114-120` appointments …) — the same string across all 60 migrations; ledgers `FOR SELECT` only (`20260812130000_ledger_rls_select_only.sql:21,29,37`).
- Session resolution: `src/lib/shop.ts:12` cookie `gradia_active_shop`; `requireUser()` `:14`; `getOptionalShop()` `:35` (owner-filtered `:48-54`, fallback `:57-63`); `requireShop()` `:72`; `listShopsForCurrentUser()` `:81` (owner-filtered). Mutations `src/app/actions/shop.ts`.
- Decider attribution today: `pending_actions.decided_by_user` (`20260508150000_pending_actions_decided_by_user.sql`), `trust.ts` resolution telemetry (E01 epic §Current foundation).
- Facade: `src/lib/supabase/for-shop.ts:38` (ADR-003) — new tables' service-role access goes through it.
- Tests: `eval/integration/tenant-isolation.int.test.ts` (code-level scoping), `eval/integration/ledger-idempotency.int.test.ts` (RLS on ledgers), `eval/integration/_db.ts` (real Postgres via Supabase CLI 2.98.2, `ci-integration.yml`).
- Flows: `ui/flows/team-setup.md` (steps 1–6, error/empty states), `06-ui-information-architecture.md` §4 Settings → Team.
- Latest migration: `20260825120000_quote_status_booked.sql`; convention `YYYYMMDDHHMMSS_snake_case.sql`; `supabase/rollbacks/` exists.

## Exact scope
1. **Tables (migration A, additive):** `members` (`id, shop_id, user_id → auth.users, role member_role ENUM('owner','admin','tech'), status ENUM('active','removed'), invited_by, created_at, updated_at, removed_at`; unique `(shop_id, user_id)`; index `(user_id)`), `invitations` (`id, shop_id, email (citext/normalized), role, token_hash (sha256 of a CSPRNG token — plaintext never stored), invited_by, expires_at, accepted_at, revoked_at, created_at`; unique partial on `(shop_id, lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL`). RLS: members/invitations readable by active members of the shop; writable per role in E01-03 (this ticket: owner/admin write). **Last-owner protection** as a DB trigger (cannot remove/demote the sole active owner) — durable invariant in the database (DoD C).
2. **Backfill (same migration, idempotent):** every `shops.owner_id` → `members(role='owner', status='active')` `ON CONFLICT DO NOTHING`. Trigger: a new shop insert auto-creates the owner member row (so `createShop` needs no code change to stay consistent).
3. **Membership helper function (SQL):** `public.is_shop_member(shop uuid) → boolean` (SECURITY DEFINER, `STABLE`, search_path pinned) = exists active member for `auth.uid()`; and `member_role(shop uuid)`. All new policies reference these (one seam to change later — ADR-003 TS-5 compatible).
4. **Dual-accept policies (migration B):** for **every** tenant-owned table (enumerate all — expect 28–31), `CREATE OR REPLACE`/`DROP+CREATE` the policy predicate as `shop_id IN (SELECT id FROM shops WHERE owner_id = auth.uid()) OR is_shop_member(shop_id)`; `shops` itself: SELECT for members, UPDATE/DELETE owner-or-admin (admin cannot delete a shop — owner only). Ledger tables keep `FOR SELECT` only. Per-table list in the migration header + a generated check script that fails if any table with a `shop_id` column lacks a membership policy.
5. **Membership-only cutover (migration C, separate file, applied in this ticket for the local/integration tier; production application is gated by the rollout note — see Rollback):** drop the `owner_id` disjunct. Because backfill guarantees owner ∈ members, the flip is behaviorally a no-op — proven by the isolation suite running against both B and C states.
6. **`requireShop` → membership:** `getOptionalShop()`/`listShopsForCurrentUser()` resolve via `members` (active), keeping owner semantics; cookie-pinned shop must be one the user is a member of; `requireMember(minRole)` added (thin; wide adoption in E01-03). Characterization tests around `requireShop` first (E01 epic risk).
7. **Decider attribution:** `pending_actions.decided_by_user` and `action_decisions` already carry a user id — add `decided_by_member_id` (nullable FK) stamped by the decision path so "who decided" resolves to a member/role; backfill from user id where a member exists. (`trust.ts` reads unchanged.)
8. **RLS isolation suite (permanent, integration tier):** for every tenant table: member of A cannot SELECT/INSERT/UPDATE/DELETE B's rows via the session client; removed member loses access; `tech` and `admin` see rows (data-level parity; UI/role gating is E01-03); ledger tables stay read-only. Generated from the table list so a new table without a policy fails the suite.
9. **Analytics groundwork:** none (member events in E01-03).
10. Docs: `03-domain-model.md` §1 (current → members), `08-security-and-reliability.md` RLS section, ADR-003 TS-5 note ("membership functions are the seam a session-variable design would reuse"), `program/capability-status.md`.

## Explicit non-goals
- No invitation sending/accepting UI or emails (E01-03). No role checks in server actions beyond `requireMember` existence (E01-03).
- No `shop_connections` slice (lands in E02-02 per the Batch 4 plan). No god-table decomposition.
- No SSO/SAML, no custom roles, no per-record ACLs, no multi-location.
- No `forShop` conversions of existing files (E01-02).

## Dependencies
- Batch 1 merged (P0-013 accepted + merged — autorun rule 5). P0-011 done (facade). P0-002 CI + integration tier.
- Decisions: D-018, D-048, D-036 — Approved.

## Expected modules affected
New migrations A/B/C (+ rollback files under `supabase/rollbacks/`), `src/lib/shop.ts` (rewrite of resolution), `src/lib/members.ts` (new: `requireMember`, role helpers, types), `src/lib/types/database.ts` (member/invitation rows, role enum), decision paths stamping `decided_by_member_id` (`src/lib/approvals.ts` claim/decide site, `src/app/actions/approvals.ts`, `trust.ts` read), `eval/integration/rls-isolation.int.test.ts` (new, generated), characterization tests for `shop.ts`, `scripts/check-rls-coverage.mjs` (new; run in `test:int`), docs.

## Database impact
Two new tables + enum types; new SQL functions + trigger; **every tenant table's RLS policy rewritten** (B then C); one nullable column on `pending_actions`/`action_decisions` with backfill.

## Migration impact
Three numbered, idempotent migrations with rollback files; re-run twice locally. **Occupies the DB-sensitive slot.** Production application order: A+B in one deploy; C only after the rollout note's condition (E01 epic: two weeks of dual-accept with zero owner-only denials — measured by the log line added in scope 4's policies? RLS cannot log; instead the app logs any `requireShop` resolution that succeeds by ownership but not membership — expected zero after backfill). Founder applies C to Production by merging the follow-up flag/migration PR (Organizer cuts it as E01-01C at the time; the Builder never touches Production).

## API impact
None external. `requireShop()` contract preserved; `requireMember(minRole)` added.

## UI impact
None visible. (Settings "Team and billing controls land here next" placeholder `settings/page.tsx:489-495` untouched until E01-03.)

## Permission impact
Data-level: members of any role can read tenant rows (role gating is app-level in E01-03 and E04-04); write policies: owner/admin for `members`/`invitations`; shop delete owner-only. Documented matrix in `members.ts` header.

## Tenant-isolation impact
This ticket **is** the tenancy change. RLS isolation suite is the acceptance instrument; `forShop` for any service-role path touching the new tables; cookie-pinned shop validated against membership (a stale cookie for a shop the user left → fallback to another membership or `/onboarding`).

## Security impact
Highest-leverage security change in the program (E01 epic). Invitation tokens hashed at rest (CSPRNG 32 bytes, expiring, single-use — enforced by E01-03's accept path; schema here). SQL functions SECURITY DEFINER with pinned `search_path` (P0-004A follow-up pattern). No policy may be weakened: the coverage script + the suite are locking tests.

## Idempotency requirements
Backfill + trigger idempotent; migrations re-runnable; `decided_by_member_id` backfill idempotent.

## Observability requirements
Structured log when resolution succeeds by ownership but not membership (`[shop] membership_gap`, shop_id, user_id) — must be zero after backfill; feeds the C-cutover decision. Alert seam: SEV-2 if non-zero in production.

## Analytics requirements
None (E01-03).

## Feature flag
None for schema/policies (invisible refactor gated by tests — E01 epic). `FEATURES.teamMembers` is introduced **in E01-03** for the UI.

## Automated tests
- Integration (real Postgres): migrations A/B/C re-run twice; backfill equivalence (every owner is an active owner-member); trigger on new shop; last-owner protection; RLS isolation suite across all tenant tables in both B and C states; ledger read-only preserved; removed member denied.
- Unit/characterization: `requireShop`/`getOptionalShop`/`listShopsForCurrentUser` identical outputs for single-owner shops; cookie validation; `requireMember` role ordering (`owner > admin > tech`).
- Coverage script: fails when a `shop_id` table lacks a membership policy (run as part of `test:int`).
- Tenant-scoping inventory (`eval/tenant-scoping.test.ts`) unchanged or updated by addition only.

## Manual acceptance procedure
1. Builder (local Supabase): apply A/B; seed two shops with two users; as user 1 verify every page loads identically to pre-migration; as a manually inserted `tech` member of shop 1, verify session client reads shop 1 rows and none of shop 2 (SQL-level check + one page).
2. Builder: apply C locally; repeat; `membership_gap` log count = 0.
3. Builder: attempt to demote/remove the sole owner via SQL → trigger refuses.
4. **Founder:** on the batch preview against the staging/preview database (never Production): steps 1–3; confirm the founder's own shop behaves identically; PASS/FAIL in `autorun-log.md`. Production rollout of A+B rides the batch merge (founder daily loop); C is a later founder-merged PR per the rollout note.

## Failure cases
- A tenant table missed by the policy rewrite → coverage script fails CI (fail closed).
- Backfill finds a shop whose `owner_id` user no longer exists → FK prevents the member row; migration logs the shop id and continues (owner-only disjunct still grants access in state B; state C would lock it out — the C precondition includes zero such rows).
- Cookie points at a shop the user is not a member of → resolution falls back; never a cross-shop read.

## Rollback strategy
State C → re-apply B's policies (rollback file). State B → A's tables are inert without the policy disjunct; drop policies back to owner-only (rollback file). Tables/columns stay (additive). `shop.ts` revert restores owner-only resolution. No data loss at any step.

## Definition of done
`../12-definition-of-done.md` plus: RLS isolation suite + coverage script in CI (integration tier); migrations A/B/C + rollback files; `membership_gap` = 0 on the preview DB; founder step 4 PASS recorded; `03-domain-model.md`, `08-security-and-reliability.md`, ADR-003 TS-5 note, `04-capability-map.md`, `program/capability-status.md` updated in the same change; the E01-01C production cutover follow-up recorded in `program/backlog.md`.

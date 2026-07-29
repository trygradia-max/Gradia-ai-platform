# P0-001 — Exposed database credential remediation

- **Ticket ID:** P0-001
- **Epic:** E00 — Stabilization
- **Status:** in-review — founder password rotation completed 2026-07-29; repository remediation implemented 2026-07-29 (Claude Builder). NOT done: acceptance steps 2 and 6 assigned to the founder (see Appendix), Cursor Reviewer sign-off pending, merge to `main` pending. Q-01 (history scrub) remains open.
- **Priority:** Critical (the single most serious finding in the audit; everything else is moot until this lands)

## Objective

Neutralize audit finding **C-1**: a live Supabase Postgres superuser connection string (including the password) is committed at `.gitignore:46`, present in pushed git history. Rotate the credential, remove the line, and eliminate the loose secret-file pile (audit finding **H-1**).

## User outcome

No shop's data can be read or written by anyone holding a copy of the repository or its history. Owners are never told about this; the outcome is that cross-tenant compromise via the leaked credential becomes impossible.

## Current code references

- `.gitignore:46` — full `SUPABASE_DB_URL postgresql://postgres:<password>@db.<project>.supabase.co:5432/postgres`, verified in working tree AND `git show HEAD:.gitignore` (audit doc 06, finding C-1).
- Repo root: `.env.local` plus four backup variants (`.bak-*`, `.pre-restore`, `.save`, `.env.production.pull`) — all gitignored/untracked but on disk (audit doc 06, finding H-1).
- Audit docs: `platform/docs/audit/06-security-and-tenancy-audit.md` (C-1, H-1), `00-executive-summary.md` §Most dangerous weaknesses, `12-recommended-roadmap.md` item 1, `13-open-questions.md` Q1.

## Exact scope

1. **Founder action (dashboard, not code):** rotate the Supabase database password in the Supabase dashboard. The Builder prepares the checklist and verifies afterward; the founder executes. This step is a hard prerequisite for closing the ticket. **✅ COMPLETED by the founder 2026-07-29** (confirmed in writing to the Builder session; old-credential connection-refused evidence still owed — acceptance step 2).
2. Remove the credential line from `.gitignore` (keep the file's legitimate ignore rules intact).
3. Update local/dev/prod environment references to the rotated credential wherever `SUPABASE_DB_URL` is legitimately consumed (env files, Vercel env — founder-assisted for prod).
4. Delete the four `.env.local` backup variants from disk; leave exactly one `.env.local`.
5. Document the incident: date discovered, date rotated, where the credential had propagated (GitHub remote), in `../runbooks/exposed-credential.md`'s incident log section.
6. Record the treat-as-compromised stance: the old credential is assumed leaked regardless of history handling.

## Explicit non-goals

- **Git history rewrite.** Whether to scrub history on a repo with open branches/PRs is an open founder decision (`../program/decision-queue.md` Q-01). This ticket does NOT block on it — rotation neutralizes the credential either way. If the founder later approves a scrub, that is a separate ticket.
- No changes to how the app connects to Supabase (clients in `src/lib/supabase/` are untouched).
- No secret-manager migration, no pre-commit secret-scanning tooling (worthwhile; raise as a follow-up ticket).

## Dependencies

None. This precedes everything, including the rest of P0.

## Expected modules affected

`.gitignore` only, plus untracked env files on disk. Zero application modules.

## Database impact

None to schema. The database password changes (platform-level, not a migration).

## Migration impact

None.

## API impact

None.

## UI impact

None.

## Permission impact

None in-app. Platform-level: the old superuser credential stops working.

## Tenant-isolation impact

Restores the guarantee: the leaked credential bypassed RLS and app entirely (full cross-tenant read/write). After rotation, RLS + app discipline are again the only access paths.

## Security impact

Closes the audit's only CRITICAL open-to-the-world finding. Also removes the H-1 multi-copy secret hazard.

## Idempotency requirements

N/A.

## Observability requirements

Verify post-rotation that the application (which uses the Supabase URL + keys, not the direct Postgres URL) is unaffected: one smoke pass on login + one dashboard page load in prod after rotation.

## Analytics requirements

None.

## Feature flag

None — fix, not feature. There is no partial state worth gating: the credential is either rotated or it is not.

## Automated tests

- **Failure-path / regression:** a repo-hygiene test (or CI grep step, coordinated with P0-002) asserting no `postgresql://` connection string appears in any tracked file. This is the regression lock; it must fail if the line returns.
- No unit/integration tests apply (no app code changes).

## Manual acceptance procedure

1. Founder rotates the DB password in the Supabase dashboard.
2. Attempt to connect with the OLD credential (`psql` with the leaked URL) → connection **refused/authentication failed**.
3. `git show HEAD:.gitignore | grep -c "postgresql://"` → `0`.
4. `git log -S "postgresql://" --oneline -- .gitignore` output captured and pasted into the ticket appendix, with a note: "credential rotated <date>; history retained pending Q-01."
5. `ls -a` repo root → exactly one `.env.local`, zero backup variants.
6. Load the production app: login works, dashboard renders (proves the app never depended on the leaked direct-connection URL).
7. Confirm the incident entry exists in `../runbooks/exposed-credential.md`.

## Failure cases

- **App breaks after rotation** → something was consuming `SUPABASE_DB_URL` directly (audit found no such consumer, but verify); restore service by updating that consumer's env with the new credential — never by reverting the rotation.
- **Old credential still connects** → rotation didn't take (wrong project, cached pooler credentials); repeat rotation, re-verify.
- **Founder unavailable** → ticket blocks (founder-only dashboard access); record in `../program/blocked.md`. Do not work around.

## Rollback strategy

There is no rollback — a credential rotation is deliberately one-way. Contingency for breakage is forward-fix (update consumers with the new credential). The `.gitignore` edit is trivially revertible but must never be.

## Definition of done

All of `../12-definition-of-done.md` plus: old credential verifiably dead (acceptance step 2 evidence recorded); line absent from HEAD; regression grep in place (or explicitly handed to P0-002 with a link); exactly one `.env.local` on disk; incident logged; Q-01 (history scrub) recorded in the decision queue with this ticket referenced.

## Appendix — acceptance evidence (2026-07-29, Builder session)

Acceptance step 4 output, `git log -S "postgresql://" --oneline -- .gitignore`:

```
ca95047 WIP checkpoint: customer recovery UI polish + agent handoff docs
```

**Credential rotated 2026-07-29 (founder, Supabase dashboard); history retained pending Q-01.** The old credential is treated as compromised regardless of history handling (exposure chain: line captured in `ca95047`, pushed to the public `origin` remote — `_docs/redesign/SECURITY-AUDIT.md` C-1 transparency note).

Per-step record (per `../12-definition-of-done.md` §G):

| Step | Outcome |
|---|---|
| 1. Founder rotates DB password | ✅ Done — founder, 2026-07-29 |
| 2. OLD credential connection attempt → refused | **ASSIGNED: founder** (Builder holds no credential values; ticket stays out of done until confirmed) |
| 3. `git show HEAD:.gitignore \| grep -c "postgresql://"` → 0 | ✅ Executed — `0` on `home-redesign` after remediation commit. ⚠️ Other branches (`main`, `redesign/*`, `mvp/*`, `fix/*`) still carry the line at their HEADs until the fix merges |
| 4. `git log -S` output captured + note | ✅ Executed — this appendix |
| 5. `ls -a` → exactly one `.env.local`, zero backups | ✅ Executed — `.env.local` + tracked `.env.example` only; four backup variants deleted 2026-07-29 |
| 6. Prod smoke: login + dashboard renders | **ASSIGNED: founder** |
| 7. Incident entry in `../runbooks/exposed-credential.md` | ✅ Executed — see that file's Incident log |

Regression lock: `eval/repo-hygiene.test.ts` (runs in `npm test`, therefore in CI on every pass; P0-002 hardens the gate).

# Runbook — Exposed Credential

_Created 2026-07-25 by the Organizer. The live instance of this runbook is audit finding C-1 (Supabase DB superuser URL committed at `.gitignore:46`, in pushed history) — remediation ticket **P0-001**. This runbook generalizes to any leaked secret (API keys, `ENCRYPTION_KEY`, `CRON_SECRET`, Stripe/Twilio/Vapi/Aurinko credentials)._

_Related (2026-09-01): the complete inventory of secrets the app reads — 50 names, classified, with what each one unlocks — is `production-config-audit.md` (PROD-CONFIG-AUDIT); use it to scope the blast radius of a leaked name._

## Trigger / symptoms
- A secret value found in git history, a committed file, logs, test output, a screenshot, or a paste.
- Supabase/vendor dashboard shows unexplained access, or anomalous rows appear (see Diagnosis).
- Treat **discovery of exposure as the incident** — do not wait for evidence of use.

## Severity
- DB connection string, service-role key, or `ENCRYPTION_KEY`: **SEV-0** (full cross-tenant read/write or decryption of every shop's stored vendor tokens).
- `CRON_SECRET`, single-vendor API key: **SEV-1** (scoped abuse: cron invocation, vendor spend).
- Anything already rotated before exposure window: downgrade with evidence.

## Immediate containment (in order)
1. **Rotate at the source of authority, not in code:**
   - DB password: Supabase dashboard → Project Settings → Database → reset password.
   - Supabase anon/service-role keys: Supabase dashboard → API → rotate.
   - `ENCRYPTION_KEY`: cannot be simply swapped — it decrypts per-shop Twilio/Vapi/Aurinko tokens at rest. Generate the new key, then re-encrypt: this is a founder+builder task; until done, treat stored tokens as at-risk and rotate the *underlying vendor tokens* too.
   - Stripe / Twilio / Vapi / Aurinko / Anthropic / OpenAI keys: rotate in each vendor console.
   - `CRON_SECRET`: generate new value; crons fail closed until step 2, which is acceptable.
2. **Update Vercel env vars** (production + preview) and **redeploy**. Update local `.env.local` (one file only — the backup pile is itself finding H-1; delete the variants).
3. **Remove the secret from the repo working tree and HEAD** (for C-1: delete the `.gitignore:46` line).
4. **Decide history handling:** rotation neutralizes the credential; rewriting pushed history is a founder decision with costs (open branches/PRs) — recorded in `../program/decision-queue.md`. Do not scrub silently.

## Diagnosis (was it used?)
- Supabase: database logs / connection logs if the plan exposes them — **REQUIRES VERIFICATION** (plan tier unknown; audit open question #17). If unavailable, assume exposure-window access is possible and say so honestly.
- Look for writes that bypass the app's shape: rows in `usage_events`, `payments`, `credit_grants`, `pending_actions`, `shops` with no matching app-side audit trail (`custom_agent_runs`, `action_decisions`, Vercel function logs, Sentry breadcrumbs).
- Check `shops` for altered vendor credentials or added rows; check `auth.users` for unexpected accounts.
- Vendor dashboards for spend anomalies (Twilio, Vapi, Anthropic, OpenAI, Stripe).

## Recovery
- Restore any tampered rows from backup (`data-restore.md`) — remembering ledgers are append-only: correct money by compensating entries, never edits (D-024).
- If cross-tenant read cannot be ruled out for the exposure window, treat as tenant-data-leak (that runbook's communication rules apply).

## Verification
- Old credential fails to connect (test explicitly).
- New secret present only in Vercel env + single local `.env.local`; `git grep` of HEAD finds nothing; `git log -S "<secret prefix>"` outcome documented.
- App smoke: login, one approval executes, one webhook verifies (signature checks depend on rotated secrets).

## Communication
- SEV-0 with possible data access: same-day honest notice to affected owners per `incident-severity.md`.
- Exposure with rotation completed and no evidence of use: record in postmortem; owner notice at founder's discretion — default to transparency.

## Postmortem
- How did the secret land there (the C-1 answer: pasted into `.gitignore`) and what mechanical guard prevents recurrence (secret scanning in CI rides with P0-002 follow-ups; pre-commit hook candidate → backlog).
- Update risk register R-01.

## Incident log

### INC-2026-001 — Supabase DB superuser connection string in `.gitignore` (audit C-1, ticket P0-001)

- **What leaked:** the full `SUPABASE_DB_URL` Postgres superuser connection string (value never reproduced here), committed as line 46 of `platform/.gitignore`.
- **Discovered:** 2026-07-02, manual diff review in the redesign `/security-review` session (`_docs/redesign/SECURITY-AUDIT.md` C-1); gitleaks full-history scan had produced a false negative. Re-confirmed by the 2026-07-20 audit (doc 06, C-1).
- **Propagation:** captured in commit `ca95047` and pushed to the public GitHub remote (`origin`); present in the history of all branches descending from it. Exposure window: treat as public from the 2026-07-02 push onward.
- **Rotated:** **2026-07-29** — founder reset the database password in the Supabase dashboard. The old credential is **treated as compromised** for its full exposure window regardless of history handling.
- **Repo remediation:** 2026-07-29 (Builder, ticket P0-001) — credential line removed from `.gitignore` working tree and branch HEAD (`home-redesign`; merge to `main` pending), four `.env.local` backup variants deleted (finding H-1), regression lock added (`eval/repo-hygiene.test.ts`).
- **Outstanding:** founder evidence that the old credential no longer connects (ticket acceptance step 2); prod smoke (step 6); re-pull of `.env.production.pull` when next needed; **Q-01** (history scrub vs rotate-only) still open — history NOT rewritten; fix not yet merged to `main`/other branch HEADs.
- **Diagnosis:** Supabase access-log visibility unverified (see Known gaps); no evidence of use has been established either way — per this runbook, exposure-window access is assumed possible.

## Known gaps
- No secret scanning in CI today; detection was manual audit.
- Supabase access-log visibility unverified (**REQUIRES VERIFICATION**).
- `ENCRYPTION_KEY` rotation has no built re-encryption tool — if this runbook fires for it before one exists, budget a day.

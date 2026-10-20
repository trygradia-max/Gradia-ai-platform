# Private review authentication

The production callback defaults to https://gradia-ai-platform.vercel.app. Request
Host, forwarded headers, request origin and `next` never choose its trusted origin.
On Vercel that default stands unless the private-review opt-in below matches.
Off Vercel, a loopback `GRADIA_DASHBOARD_URL` (`http://127.0.0.1` or `http://localhost`,
path ignored) is the only other trusted origin. A non-loopback value does not
replace the production origin.

A private candidate may opt in using deployment-only `GRADIA_PRIVATE_REVIEW_AUTH=1`.
It then uses the platform-provided server `VERCEL_URL`, only when `VERCEL=1` and the
hostname is a generated `gradia-ai-platform-<alphanumeric>-gradia1.vercel.app` host.
Malformed configuration returns HTTP503 before exchanging any code. Missing/0 opt-in
preserves production behavior. Do not set this flag project-wide or supply a browser
origin/header as configuration. Use the deployment's generated URL, not its aliases.

## Operator sequence

1. Build the reviewed commit with the flag set for that candidate only, no public
   domain promotion. Retain Vercel team protection and all provider/cron/write holds.
2. Extend the existing release-freeze exception to the replacement's exact hostname;
   remove the retired review hostname after verifying the replacement.
3. Preserve Supabase's production site URL and current redirect entries. Add only the
   exact candidate `/auth/callback` redirect entry plus `/auth/callback[?]next=**`
   on that same exact hostname. The latter permits the login form's return-path query
   only; the callback still validates `next`. No wildcard hosts or callback paths.
   Verify the actual redirect is accepted before requesting login.
4. Test `/api/health`, missing-code and invalid-code redirects. They must stay on
   the candidate in review mode. Do not log codes, session cookies or credentials.
5. Start a fresh login from the candidate in the same browser. Links/codes from the
   old failed flow are not acceptance evidence and must not be copied/replayed.
6. Confirm successful exchange lands on the candidate dashboard (or onboarding if
   the existing account has no shop), then read authorized pages. Do not create a
   shop, seed data or remove write guards to complete read-only acceptance.
7. Remove retired candidate callback allowlist entries. Rollback is restoring the
   prior exact redirect list/firewall rule and retiring the candidate; the public
   deployment has not changed.

## Evidence

Regression tests run the full internal-destination/open-redirect suite against both
production and private review modes, plus malformed host/flag/platform cases. This
is not proof of successful hosted login: record that separately after browser QA.

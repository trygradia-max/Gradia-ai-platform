# Signed-in launch acceptance: resume handoff

Branch `claude/signed-in-launch-acceptance`, worktree
`/Users/harryhatch/Gradia/worktrees/claude-signed-in-launch-acceptance`, based on `origin/main`
`763cd88` (PR #152 merged). After the acceptance pass, PR #154 was rebased without
conflict onto `origin/main` `b528e96` (PR #153 merged). The three new regression files
then passed 25/25, with clean TypeScript and touched-file ESLint. The browser matrix
below remains local evidence from the pre-rebase product tree; the rebase changed only
commercial-billing files outside these acceptance fixes. If this session is interrupted,
read this file first, then
`git log --oneline origin/main..HEAD` and `git status`.

## Scope (exact)

A truthful, signed-in, **local-only** acceptance pass of the launch-critical product, fixing only
blockers that are reproduced in this pass. Local fixture proof is not hosted acceptance and is labelled so.

In scope: new-shop onboarding; the Starting point quiz and report; canonical `/agents` Agent OS
configuration; reviewed/versioned memory; approval modes; core CRM navigation; billing-blocked and
checkout-required states; owner, manager and staff personas; unauthenticated redirect and return path;
cross-shop isolation; keyboard focus, labels, headings, no horizontal overflow, mobile action hierarchy
at desktop (1280) and 390px.

Out of scope and **not done, by instruction**: any deploy, shared or production database or secret,
live provider (SMS/email/voice/Meta/Aurinko/Jobber), live Stripe, Stripe Dashboard mutation, model call,
real customer data or communication, Vercel change, shared-DB migration, merge of this PR.
Schema changes only if a confirmed blocker cannot be fixed without one (documented first, additive).

## Environment (all local, disposable)

| Item | Value |
| --- | --- |
| Supabase | Own disposable stack, project id `gradia-signed-in-acceptance`, API `127.0.0.1:58531`, DB `:58532`. Created from `tests/supabase/config.toml` with unique ports; migrations symlinked from this branch (126/126 applied, newest `20261117120000`). Shared stack `gradia-isolated-tests` was **not** touched (it already holds a newer migration from another branch). |
| Credentials | `.local-tools/accept-db.json` (mode 600, git-ignored via `/.local-tools/`). Never printed. |
| App | Production build (`next build --webpack`, offline-font mock) served by `next start` on `127.0.0.1:3100`, env passed in-process (no `.env*` file written). Provider keys are absent. `next dev` was abandoned: Turbopack cannot load the offline font mock and webpack dev is too slow for browser runs. |
| Scratch | `$CLAUDE_JOB_DIR/tmp` and `.local-tools/` only. Screenshots live in `.local-tools/accept-shots/` (ignored). Nothing generated is staged. |
| node_modules | APFS clone of the sibling `claude-onboarding-baseline-ui` checkout (identical `package-lock.json`). |

## Personas (synthetic, created through the local auth admin API only)

| Persona | Shop | Role |
| --- | --- | --- |
| `owner-a` | Shop A | owner (creates the shop through onboarding) |
| `manager-a` | Shop A | manager, with and without `baseline.draft` and other delegated grants |
| `staff-a` | Shop A | staff |
| `owner-b` | Shop B | owner (cross-shop isolation) |
| `multi` | A and B | manager in A, owner of B (workspace switching) |
| anonymous | none | unauthenticated redirect and return path |

## Route matrix (final)

Legend: PASS, PASS after fix (blocker reproduced, fixed here), N/A, NOT RUN. Desktop is 1280x900; mobile is 390x844. Local disposable stack only.
Screenshots (ignored, never staged) were reviewed for the rows marked with a number; the rest were verified by DOM/axe/overflow assertions.

| # | Route / flow | Persona(s) | Desktop | 390px | Evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | Signed-out redirect and safe return for 14 gated routes | anon | PASS after fix (B1): every route -> `/login?next=<exact path+query>`; was wrong or missing for 9 | same (server redirect) | `eval/proxy-auth-gate.test.ts`; browser probe |
| 2 | `/onboarding` new owner: business -> Starting point -> number -> help -> `/dashboard` | owner-a, owner-m | PASS | PASS (full run, no overflow, primary action full width) | shots 02-16, 50-m-* |
| 3 | Starting point quiz: unknown vs typed 0, blank, range and cross-field validation, save/resume across reload, review, submit, incomplete refusal | owner-a, owner-m | PASS (revision 1 written, draft consumed) | PASS | 05-13, 50-m-quiz-* |
| 4 | `/starting-point` report evidence labels | owner-a | PASS: all Owner estimate; Not sure kept as unknown; Not measured yet; no improvement claim | PASS | a-_starting_point-d (reviewed) |
| 5 | `/starting-point` authority | manager-a (grant), manager-n, staff-a, owner-b | PASS: granted manager sees report and "Save draft for the owner" only; ungranted manager and staff see "You don't have access"; owner-b sees own shop | no overflow (40-page sweep, see row 16) | 40-*, 41-* |
| 6 | `/agents`, `/agents/build` (7 steps), `/agents/[id]`, revisions | owner-a | PASS: empty state, identity creation, immutable revisions 1 and 2, history | landing/build/activate no overflow | 20-31 |
| 7 | Agent test and activation gating | owner-a | PASS: governance checks ran (100%, safety passed, no model call); activation stays blocked with plain copy (billing not set up, no active Control Center policy) | PASS (no overflow) | 24-25 |
| 8 | Reviewed memory: candidate -> reviewed -> published; pin in builder | owner-a | PASS (rev 1; pin saved as agent revision 2). Manager and staff memory actions NOT RUN in the browser (integration `reviewed-memory`, `team-permissions` cover roles) | NOT RUN | 27-31 |
| 9 | `/control-center` approval-mode explanations | owner-a, manager-a, staff-a | PASS: owner sees "No policy activated. Existing actions require human approval"; manager and staff go to `/team` | PASS (no overflow) | 55 |
| 10 | Approvals: owner `/approvals`, delegated `/team/approvals` | owner-a, manager-a, manager-n, staff-a | PASS: owner Send it / Tweak it / Drop it (Drop verified -> `rejected`, nothing sent; Send NOT exercised, no provider); granted manager sees Approve/Reject; ungranted manager and staff refused | PASS (no overflow) | 53-* |
| 11 | `/billing` checkout-required and blocked | owner-a (manager/staff redirected to `/team`) | PASS: "Contact Gradia to activate" disabled, honest copy, no live checkout; H1 added (B4) | PASS | 44-* |
| 12 | Home, approvals, activity, conversations, customers, calendar, agents, settings, receptionist, team, intake, legacy aliases (`/leads`, `/schedule`, `/chat`, `/agent`) | owner-a | PASS (axe wcag2a/aa clean after B4); empty states written | PASS (no overflow) | o-* |
| 13 | Cross-shop isolation and workspace switching | owner-b, multi, manager-a | PASS: owner-b sees nothing of shop A on 12 direct URLs (agent, revision, customer, conversation, team/intake selectors); multi switches workspaces on `/team` (A manager, own shop owner) and sees A only where granted | no overflow (row 16) | 42, 43 |
| 14 | Keyboard, labels, headings, overflow, action hierarchy | owner-a (+ others for overflow) | PASS: skip link first, tab order through chrome and main, visible focus ring and an accessible name on every stop, no horizontal overflow on any route/persona; topbar overlap fixed (B3) | PASS | t51, t52, t60 |
| 16 | 390px overflow sweep, 8 routes each for manager-a, manager-n, staff-a, owner-b, multi | those five | n/a | PASS: 40 pages, no horizontal overflow | t70 |
| 15 | Staff / limited-manager Team home | staff-a, manager-n, manager-a | PASS after fix (B2) | PASS | browser probe, `eval/team-operations-scope.test.ts` |

## Checkpoint

- [x] Required reading: AGENTS.md, work log, five governing docs (read in full or the sections relevant to this pass), onboarding-baseline handoff.
- [x] Own disposable Supabase stack up at 126/126 migrations.
- [x] Persona/shop seeding (owner-a via real onboarding; manager-a with grants, manager-n without, staff-a, multi via the real `team_invite`/`team_accept_invite` RPCs; owner-b and multi's own shop by service-role insert). Scripts live in `$CLAUDE_JOB_DIR/tmp`, not committed.
- [x] App running locally against the stack.
- [x] Browser pass, desktop.
- [x] Browser pass, 390px.
- [x] Blockers triaged, fixed with regression tests (B1-B4).
- [x] Full unit (195 files, 3,101 passed, 4 intentional skips), `tsc --noEmit`, eslint (src + eval), `next build --webpack`; focused integration (see PR).
- [x] Work log entry and commits.
- [ ] Push and non-draft PR (not merged): see the PR for the final state.

## Confirmed vs unverified ledger

**Confirmed** (observed in this pass, local fixture only): the disposable stack applies 126 migrations from zero on this branch; every PASS row in the matrix above.

**Unverified** (not observed here; do not cite as passing): hosted/production behavior; real Google/magic-link sign-in and the callback exchange (the harness signs in by password against the local Auth server and injects the cookie; the callback's `next` handling is covered by unit tests only); the Approvals `Send it` path and any provider send; Stripe Checkout and the Customer Portal; the real Twilio/Aurinko/Meta/Vapi channels; model-backed agent behavior; manager and staff memory actions in the browser; mobile screenshots of the manager/staff/cross-shop rows (only the overflow sweep was run); a human screen-reader pass; 200% zoom; Safari/Firefox (Chrome only).

## Blockers found, fixed in this PR (each reproduced in the browser, then re-verified)

- **B1: signed-out deep links lost the return path.** The proxy gate only listed `/dashboard /leads /schedule /settings /onboarding`;
  every other signed-in route fell through to its page (fail-closed, no data) but lost the destination (`/agents /starting-point /team
  /conversations` -> `/login` with no `next`; `/approvals /customers /billing /control-center /activity` -> `/onboarding` ->
  `/login?next=/onboarding`). Also the original query string was copied onto `/login` as stray parameters. Fix: `SIGNED_IN_PREFIXES` +
  `PUBLIC_PAGE_PATHS` in `src/lib/supabase/middleware.ts` (segment-boundary match), `/login` carries only `next`. Test
  `eval/proxy-auth-gate.test.ts` scans every `page.tsx` and fails if a new route is neither public nor gated.
  After: 14/14 routes redirect to `/login?next=<exact path+query>`.
- **B2: staff and managers without a queue grant saw a permanent "Work status could not be verified. Refresh the page" error on their
  Team home.** `loadOperationsOverviewForWorkspace` returned `unavailable` for any workspace whose role cannot have a queue, so every
  staff member started on an error that no refresh could clear. Fix: `canReadOperationsQueue` (single rule, `team-permissions.ts`);
  a verified membership without queue grants returns `null` (no brief), while failed/malformed reads and workspaces with no live membership
  stay `unavailable`. The queue RPC still re-checks live membership. Test `eval/team-operations-scope.test.ts`.
  After: staff-a and manager-n see their Team home with no error; manager-a (granted) still sees the checked queue.
- **B3: topbar controls overlapped from 768 to 1280px** (Ask Gradia against the usage and setup pills, up to 61 px; the setup pill wrapped
  to two lines). Fix: content-sized right cluster below `2xl`, `whitespace-nowrap`/`shrink-0` pills, the "Next:" suffix from `2xl`. Measured
  after: zero overlapping control pairs at 768, 1024, 1180, 1280, 1366, 1440, 1536, 1920. Source locks in
  `eval/launch-acceptance-ui-locks.test.ts`.
- **B4 (accessibility, two one-line fixes):** `/calendar` today marker used raw `text-primary` (3.28:1) now `text-accent-text` (axe clean);
  `/billing` had no level-1 heading, now `role="heading" aria-level={1}` on the title.

## Non-blocking findings (recorded, not fixed)

- A manager or staff member who opens `/starting-point` sees the owner sidebar (its links return them to `/team`); the page itself is correctly
  gated (staff and managers without `baseline.draft` get "You don't have access"; a granted manager gets "Save draft for the owner" only).
- `/customers/<other shop id>` shows "That page isn't in the dashboard ... pages moved" (safe, but misleading for a missing record).
- Manager message-approval page shows the queued time as a raw ISO timestamp.
- `/conversations` "Chat" eyebrow uses `text-muted-foreground/70` (4.39:1, borderline; the pattern is used widely).
- Duplicate DOM id `knowledge` (section and card) on `/settings`; `/settings` jumps from h1 to h3.
- `UsagePill` catches `NEXT_REDIRECT` from `requireShop` and logs a `console.error` for a user with no shop yet.
- Reviewed memory lives under a collapsed "Manage individual connections" disclosure on `/settings`.
- The wizard shows the eyebrow "Pick up where you left off" immediately after the first step is saved.
- `/billing`'s only action ("Contact Gradia to activate") is a disabled button with no contact route.
- `/team/approvals` tells an owner "has not been delegated to your account" (owners approve on `/approvals`).

## Environment faults seen (not product defects)

- Host load average ~20 plus the Realtime container spinning at 100% CPU produced Kong 502/connection-reset and Auth timeouts; the app
  failed closed ("Gradia could not create the agent right now. Nothing was created.") and recovered. Fixed locally by stopping Realtime
  (unused), restarting Kong/PostgREST, and putting a retrying shim in front of Kong (`$CLAUDE_JOB_DIR/tmp/retry-proxy.mjs`, not committed).
  Builder identity creation then succeeded 5/5 at ~230 ms. Auth rate limit (30 sign-ins / 5 min) also hit the harness once; cookies are now cached.

## Limitations (carried to the PR)

Local fixture proof only. No hosted/production acceptance, no live provider, Stripe or model call,
no human screen-reader pass, no 200% zoom pass unless stated in the matrix.

# Call Copilot post-call review (PR F)

_2026-11-20. Implements the "Call capture state plus post-call evidence/proposal review" item of PR F in
`docs/roadmap/NEXT_BUILD_ORDER_2026-11-04.md`, under `docs/product/WHISPER_CALL_COPILOT.md`, on top of PR D
(`CALL_COPILOT_INGRESS.md`) and PR E (`CALL_COPILOT_PROPOSALS.md`). It adds no provider, no model, no transcription and
no autonomy. Approving still goes through the one existing executor._

## What this is

A signed-in surface that shows an owner (and, read-only, a manager) what Gradia heard on a consented call and what it
proposes, in plain words, with every proposal tied to the call's own words:

```
 /approvals ──link──▶ /calls/copilot            list of calls (newest first, 20 per page, keyset cursor)
                      /calls/copilot/[callId]   one call: consent and capture · evidence and gaps · extraction ·
                                                source-cited proposals · approve / approve selected / dismiss
 /team ──link──▶ /team/calls, /team/calls/[callId]    the same facts for a manager with crm.read, read-only
```

It extends the existing dashboard shell, tokens, `SectionHeader`, `StatusPill`, `EmptyState`, `ErrorState`, `Pagination`
and `TeamChrome`; it adds no sidebar item (the IA in `BUILD_REFERENCE.md` is closed) and is reached from Approvals and the
Team page. Copy lives in `STRINGS.pages.callReview`; reason and status wording lives in
`src/lib/call-copilot/review-model.ts` and is tested to cover every code the planner, timing grounding, executor and ledger can
produce, so a raw code is never shown.

## The read boundary (migration `20261120160000_call_copilot_review_reads.sql`)

Objects only. No table, column, policy, trigger, row, existing function or existing grant is changed. **No browser role
gains any table access**; the `call_copilot_*` tables stay RLS-on with no grant to `anon`/`authenticated`.

| Function | Callable by | Purpose |
| --- | --- | --- |
| `call_copilot_review_list(shop, limit, before_created, before_id)` | `authenticated` | bounded (1-25, default 20), keyset-paginated calls: capture status, coverage, proposal counts. No transcript, no provider id |
| `call_copilot_review_detail(shop, call, revision)` | `authenticated` | one call: capture/consent state, evidence coverage and gaps, runs, source-cited proposals with fresh denial reasons, and the minimum cited snippets |
| `…_viewer`, `…_ambiguity`, `…_freshness`, `…_snippet` | nobody | internal helpers |

* **Authority is derived from `auth.uid()` inside the database**, never an argument: an active owner of exactly the shop named,
  or an active manager holding `crm.read`. Anyone else (staff, a manager without `crm.read`, an inactive member, another shop's
  owner, `anon`, the service role) gets `42501`. Another shop's call id answers `{found:false}`, byte-for-byte what a random id
  answers. Revocation is immediate (checked on every call).
* **`can_approve` is the owner only.** The approval claim (`control_claim`) independently refuses a manager for these action
  types; the UI shows no control and the server action refuses before the executor is asked.
* **Minimum disclosure.** Transcript text leaves the database only as one *cited span* per citation, capped at 280 characters,
  re-verified against the quote digest stored at extraction time, and only when (a) the PR D gate permits `crm_mutation` use of the
  call now, (b) the proposal's sealed evidence revision is still exactly current, (c) the cited segment lies inside one
  consented captured interval and (d) the span is not card-like. Otherwise the snippet is withheld with a reason code (shown as
  words). Whole segments, provider call ids, user ids, shop ids and candidate customer ids never leave: ambiguity is projected to
  counts and the heard-vs-on-file values the reviewer needs.
* **Freshness is the claim's own check.** `call_copilot_review_freshness` runs the same checks as `call_copilot_recheck` in
  the same order (edited payload → requester → expiry → consent for `crm_mutation` → evidence current → agent definition → CRM
  identity) *without* the claim's row lock, so a review read can never block a capture writer or an approval. The consent and
  evidence answers are computed once per call. A source lock compares the two functions' return codes in order; the integration
  tests compare the review's code with the reason the real claim records for the same action in five scenarios.
* **Bounded.** 25 calls per page, 60 proposals, 10 revisions, 10 runs and 300 snippets per detail read.

Deploy order is fail-closed: apply the migration **before or with** the application build. If the build is live first the pages
show "could not be verified" and offer no action.

## Decisions

* The browser never calls an executor. `approveCallProposal`, `approveSelectedCallProposals` and `dismissCallProposal`
  (`src/app/actions/call-copilot-review.ts`) are server actions that take **references only** (call id, proposal id, the
  `review_token` the reviewer was shown); strict schemas reject a client-supplied shop, action id, payload or role. The shop and actor
  come from the session, the proposal and its pending-action id are re-read from the database, and the existing `executeApproval` /
  `executeRejection` run exactly as they do from `/approvals`.
* **Approve what you saw.** Every proposal carries a `review_token` (a hash of the proposal, its pending action's status and
  payload, the evidence digest and the freshness code). If anything changed since the page was read the action refuses before the
  executor is asked, and the page shows the new state.
* **Dependency order** (`PREREQUISITES` in `review-model.ts`, enforced by the UI and by the server with the same function): a
  vehicle proposal precedes any customer change; notes, quote and appointment wait for vehicle and customer; a message waits for
  vehicle, customer, quote and appointment. A proposal is "waiting for an earlier step" while an undecided prerequisite of the same
  requester and evidence revision exists; dismissing a prerequisite also releases its dependents. Review-only kinds are never
  executable and never selectable.
* **Approve selected is sequential and deterministic.** The whole selection is validated first (unknown, changed, non-approvable
  or prerequisite-skipping selections are refused whole, running nothing), then run in approval order (kind rank, then creation time,
  then id). Fresh state is read before **each** item; the run **stops at the first item that is not a confirmed success** and reports
  the rest as not attempted. Selection is capped at 10.
* **No optimistic claim.** The UI says "Approving…" until the server answers; the answer is the executor's result followed by a
  fresh read of the affected proposals. A thrown or unverifiable executor answer is shown as "not confirmed, refresh and check before
  trying again", never as success. A replay (double click, two tabs, retry) is the executor's own `already_decided`; the integration
  test proves a second identical request creates no second interaction, quote or appointment.
* **Customer memory is review-only and says so.** The card states it cannot be saved or published from a call; there is no action,
  no selection and no code path into reviewed memory. `call_copilot_submit_memory_candidate` was not re-added, and a source lock
  fails if it appears anywhere in `src/`.
* **Dismiss** uses the existing rejection path. It sends nothing and changes no customer data.

## States

Loading skeletons (list and detail, `loading.tsx`), written empty states (no calls, no proposals, no evidence), compact error
states with a Refresh action and **no** approve control when a read cannot be verified, a no-access state, a not-found state that is
identical for a missing and a foreign call, a declined/unknown-outcome/uncertain capture state that says nothing was used, partial
and out-of-date evidence banners with the reasons in words, per-run extraction status (finished, failed before anything was sent,
**outcome unknown and not retried**), and a read-only notice for managers. Layout is a single column with a 16px gutter at phone
width; controls are at least 44px; status is icon + text, never colour alone; the result region is `aria-live`.

## What "stale" looks like (revalidation)

Refresh (and every action) re-reads consent, evidence, agent definition and CRM state. A late decline, a pause, a new segment, an
edited pending payload, a changed customer identity or a revoked requester change a proposal's `freshness` code, hide the snippets
where the gate no longer permits them, and turn the card into "Can't be approved" with the reason. The booking, quote and message
executors additionally run PR E's pre-effect recheck immediately before their effect (unchanged).

## Known limits and findings

1. **A customer approval can stale a booking.** The booking proposal binds the customer's name, phone **and e-mail** as read at
   proposal time. If the customer proposal fills a missing e-mail, approving it (correctly) changes that binding and the booking
   shows "customer record changed" and cannot be approved; a quote, note and message bind only name and phone and are unaffected.
   The review surfaces this honestly and the bulk run stops there; the fix is a re-extraction (no UI yet) or a planner change so a
   booking binds only the fields it actually depends on (PR E planner, deliberately not changed here).
2. **No re-prepare action.** A stale proposal cannot be refreshed from the UI; re-running extraction needs the extractor seam,
   which this PR deliberately does not expose. The reviewer dismisses it or makes the change by hand.
3. **No Edit or "Keep as note".** Editing a staged proposal would invalidate its proof (`call_proposal_edited`), so only
   Approve, Approve selected and Dismiss exist. Review-only items show the words and the reason.
4. **Owner-only approval, one shop per session.** The owner's active shop (cookie-pinned) is used; a multi-shop owner reviews the
   active shop. Managers read through `/team/calls?shop=…` and cannot approve.
5. **Times are UTC.** Shop-timezone rendering needs the shop's zone in the DTO; times are labelled "UTC" rather than guessed.
6. **Snippet budget.** 300 snippets per read; a very large call shows "Not loaded in this view" for the rest.
7. **The definition-inactive reason is not parity-tested in the integration suite** (it is in the claim/review source lock and
   in PR E's tests); the other five reasons are.
8. **No automated screen-reader or 200%-zoom pass** was run; structure, names, live regions and focus targets are asserted in
   component tests, and `axe` was not available in the repo's unit environment.

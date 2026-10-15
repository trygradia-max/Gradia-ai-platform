# Step 6 readiness audit: quote → availability → booking → pipeline

October 14, 2026. Read-only audit of current `main` (`3cc4826`) against
[MVP_IMPLEMENTATION_SEQUENCE.md](MVP_IMPLEMENTATION_SEQUENCE.md) step 6 and the
booking and discount rules in
[AUTONOMY_APPROVAL_MODES.md](../architecture/AUTONOMY_APPROVAL_MODES.md).

Status words:

- **Verified** means a real-Postgres integration test exercises the invariant.
- **Present** means the code exists but only unit tests, or no tests, cover it.
- **Missing** means no code does it.
- **Blocked** means it waits on a founder, release or provider decision.
- **Candidate** marks a defect seen in code reading but not yet reproduced. It is
  not a confirmed bug.

No row here is marked done on code reading alone.

## Matrix

| Invariant | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Quote prices come from the menu | **Verified** (owner and agent paths) | `createOwnerQuote` loads shop-scoped `services` and prices through `buildQuoteLineItem`. `executeCreateQuote` re-derives prices at approval. `create-quote-action.int.test.ts` | That test checks the line count, not the price value. Candidate: the agent path's name matching (`approvals.ts`, `includes(word)`) can add every menu item whose name contains a short spoken word |
| Booking duration from a quote comes from the menu | **Verified by this PR** | `quotedDurationMinutes` in `quote-response.ts`. `quote-acceptance.int.test.ts` → *menu-grounded booking duration* | Before this PR, every accepted quote staged 120 minutes, for both the availability check and the booking |
| Booking duration from voice or MCP comes from the menu | Present | `vapi-tools.ts`, `mcp/server.ts` | Voice prefers the model's duration over the menu and ignores `duration_by_size`. MCP takes the caller's duration (default 90). The executor trusts the payload, falling back to 90. Not changed here |
| Zero default manager discount limit | Present, structural only | Quotes RLS and `requireShop` are owner-only. Managers can claim only `send_sms`/`send_email` (`control_claim`). `policy.ts` has `discountLimit` defaulting to 0 (unit test only) | `evaluatePolicy` is not called at runtime, and there is no discount-limit storage or delegation. Managers are blocked only because quotes are owner-only. Verified October 15 (`held-quote-send.int.test.ts`): a manager with `approvals.messages` can approve a held quote send. The review hash binds the owner's text, so the manager cannot change the price or recipient. Whether managers should deliver quotes at all is an open product question |
| Quote acceptance is approval-first and stages exactly one booking | **Verified** | `quote-acceptance.int.test.ts`: full path, sequential and concurrent double accept, no phone, expiry, forged references | — |
| Hard conflicts cannot be bypassed | **Partial** | `write_appointment_serialized` locks per shop and re-checks overlap under the lock. Covered by `booking-atomicity` and `conflict-enforcement` integration tests | Enforcement is behind `NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT`: off when unset and documented off in Production. With it off, overlap is not refused. The approval card's D-016 "Book it anyway" override lets a human book over a blocking appointment, which conflicts with "non-overridable hard conflicts". Changing either is a release or founder decision and is **Blocked** here |
| Capacity | Present, advisory | `availability.ts`: `over_capacity` is advisory and never refuses | No capacity model blocks. Staff, resource and location assignment are not written by the booking executor, and appointments have no staff, resource or location column. **Missing** |
| Unknown or stale calendar blocks automatic confirmation | Holds vacuously | External calendar failure gives `calendar: "unchecked"`, which is advisory. Booking and reschedule are `ALWAYS_HITL`, and the automatic context hard-blocks conflicts | There is no automatic booking, so nothing auto-confirms. No required-calendar state, stale or unknown, exists for a future booking opt-in. **Missing** before any autonomy. Aurinko coupling unresolved (**Blocked**) |
| Exactly one booking under concurrency and retry | **Verified** | `booking-atomicity.int.test.ts` (TOCTOU, replay, cross-tenant), `quote-acceptance.int.test.ts` (rollback re-run) | — |
| One linked pipeline update | **Verified** for quote bookings | `quote-acceptance.int.test.ts`: no duplicate lead or stage history on re-run | `moveLeadToStage` reads then writes with no compare-and-swap. Fixed October 15: a held quote send approved later, by the owner or a delegated manager, now marks the quote sent. Before, the customer's link answered with \"already decided\" because the quote was still a draft. A quote send now moves the lead forward only from `new` or `needs_quote`, never back from `booked` |
| Governed confirmation | Present | The booking stages a `send_sms` confirmation and the send path applies consent and quiet hours. 48-hour confirm via the no-show cron | No integration test. Candidates: no dedupe key per appointment; the confirmation is skipped on replay, so a crash between the write and staging loses it; the cron stamp has no null guard; the booking and 48-hour confirmations are unlinked |

## Recommended next bounded slices, smallest first

1. ~~Integration test: a manager cannot claim `create_quote`, and a quote-bearing
   `send_sms` claim by a manager is refused or proven harmless.~~ Proven bounded
   October 15; the remaining question is a product decision. A refusal would be
   a SQL change, so it goes in its own PR.
2. Booking confirmation exactly once per appointment, including replay after a
   crash. Test first, then a dedupe key.
3. Voice and MCP booking duration from the menu, using the same helper as this PR.
4. Founder or release decisions: when conflict enforcement turns on in Production,
   and whether the D-016 human override survives the "non-overridable" rule.

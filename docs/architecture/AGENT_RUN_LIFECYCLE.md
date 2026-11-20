# Governed agent run lifecycle (PR C)

_2026-11-19. Migration `20261120103700_agent_run_step_lifecycle.sql`. Backend and internal only.
No deployment, provider call, model call, shared database, billing change or production data. The
governed executor stays **OFF** (`GOVERNED_EXECUTOR_ENABLED = false`)._

This completes the durable execution lifecycle for governed (versioned-definition) agent runs by
**extending the merged scheduled-run claim**, not by adding a second executor. A run is still claimed
once per `(agent, window)` by `claim_scheduled_agent_run` and a worker still owns it through the same
`(worker_id, attempt, lease)` compare-and-set. Everything below lives in the database and is reached
through service-role functions; no browser can call or read any of it.

It implements the Gate 1 contract in `docs/roadmap/AGENTIC_OS_MASTER_BUILD.md`:

`trigger → run → step → command → attempt → evidence → outcome`

and the PR C scope in `docs/roadmap/NEXT_BUILD_ORDER_2026-11-04.md`: steps, stable commands and
attempts; heartbeats; pause/cancel/kill; wait and reconciliation links; restart recovery; recheck
before effects; no automatic retry of an unknown outcome.

## The one rule

> An expired lease, a timeout, a crash or a kill is **never proof that a provider stopped**. An attempt
> whose outcome is not recorded is `unknown`; it is never retried by Gradia, never reported as failed,
> and never reported as complete. Only a person (owner or manager), with written evidence, can say what
> happened, and only a confirmed non-effect makes a new admitted attempt possible.

## Run states (truthful)

| State | Meaning | Who/what moves it |
| --- | --- | --- |
| `running` | A worker holds a live lease. | window claim, resume claim |
| `waiting` | No worker holds it; it continues when its one open wait is ready. | `park_agent_run_wait`, recovery, reconciliation |
| `paused` | A pause was acknowledged; continues only when a person resumes it. | worker ack, database ack, recovery |
| `succeeded` / `skipped` | Finished by the worker (`finish_scheduled_agent_run`). | worker |
| `failed` | Stopped with a **known** state: step refused, wait refused, runtime error, or the bound definition stopped being current while it waited. | worker, resume claim |
| `unknown` | At least one external attempt has no confirmed outcome (or was killed in flight). Needs a person. | record-result, recovery, kill |
| `cancelled` | A cancel request was acknowledged. Effects that already completed stay recorded as completed. | worker ack, database ack |
| `killed` | A kill request was acknowledged with **nothing** unconfirmed. | database ack, reconciliation |

Only a governed run can be `waiting`, `paused`, `cancelled` or `killed` (a CHECK constraint). Legacy,
manual and event rows keep their old states and shapes.

## Identity

- **Step** (`agent_run_steps`): `(run, step_key)` is unique, ordinals are dense, a step's `kind` is part of its
  identity, the count is bounded by the definition's `maximumStepsPerRun`. Re-opening a finished step
  answers `replay_done` (skip it); an abandoned or waiting step resumes; a failed step is never silently re-run.
- **Command** (`agent_run_commands`): the stable identity of one consequential effect. `(run, command_key)` is
  unique. `operation`, `intent` (`stage`/`execute`), `payload_hash`, `idempotency_key`, credits, approval link
  and dedupe key are **immutable** (trigger). Registering the same key with different content is refused
  (`command_changed`): an edit never silently reuses old authority. `idempotency_key` is derived in the database
  (`sha256(shop|run|command_key|operation|payload_hash)`) and is the same on every attempt, so provider-side
  de-duplication applies to the one retry a reconciliation can allow.
- **Dedupe key** (optional): one live command per business object per agent across runs
  (`pending`, `in_flight`, `succeeded`, `unknown` hold it; `failed_before_effect` and `cancelled` free it).
- **Attempt** (`agent_run_attempts`): one provider-facing try. States `refused` (the gate said no; evidence
  stored; nothing was attempted), `started`, `succeeded`, `rejected` (provider definitively refused, no effect),
  `unknown`, `confirmed_effect`, `confirmed_no_effect` (the last two only by reconciliation). A unique partial
  index allows **one** `started` attempt per command no matter who calls.

## Write-ahead attempts

`begin_agent_command_attempt` inserts the `started` attempt **before** the caller touches a provider, in the
same transaction that verifies the gate. A worker that dies after that leaves a `started` row, which recovery
turns into `unknown`. A worker that dies before it leaves nothing, so nothing external can have happened. That
is why a dead governed run with **no** in-flight attempt is safely resumable and one **with** an in-flight
attempt is not. This depends on every effect going through `StepScope.command` (see Limitations).

Result recording (`record_agent_attempt_result`):

- `succeeded` requires a provider reference. An "accepted" answer without one is recorded `unknown`.
- `rejected` means the provider **definitively** refused before any effect. Anything ambiguous (timeout, thrown
  error, dropped connection, unreadable answer) is `unknown`.
- Only the live lease holder can record. A result from a worker whose lease was lost is stored as a
  `late_result_reported` event for the reconciler and changes nothing; if the run was still marked running the
  attempt is classified `unknown` on the spot.
- `unknown` stops the run immediately: command `unknown`, run `unknown`, lease released, one reconciliation wait.

## Pre-effect gate

Immediately before an attempt starts, in one transaction (`begin_agent_command_attempt`):

| Check | Verified by the database | Evidence supplied by the application (`pre-effect-checks.ts`) |
| --- | --- | --- |
| Ownership, lease, attempt fence | yes | |
| Pause / cancel request pending | yes (refuses) | |
| Runtime ceiling, attempt cap | yes | |
| **Binding** (agent enabled, active pointer, activation, policy revision, knowledge head, memory pins, evaluation, hash) | yes, via `agent_definition_binding_reasons` | |
| **Grants** (operation is in the immutable bound snapshot; post-MVP tools refused) | yes | `grants`: also checks the granted maximum mode against the command's intent |
| **Budget** (sum of in-flight, done and unknown credit estimates plus this one ≤ `maximumCreditsPerRun`) | yes | `budget`: commercial lapse gate (`commercial_execution_gate`) |
| **Approval** (execute commands) | yes: status is `approved`, `result_id` is empty, and the payload still hashes to the value recorded at registration | `approval`: status and consumption |
| **Policy** | policy revision equals the bound revision | `policy`: `evaluatePolicy` with current policy history, owner membership, readiness and approval facts, `source: "agent"` |
| **Consent** | | `consent`: `evaluateCustomerSendPolicy` (do-not-contact, STOP, destination suppression, marketing consent, quiet hours, service proof) for execute commands to a customer; staging contacts nobody |
| **Readiness** | | `readiness`: the connector must be `ready` (never `ready_to_test`) |

The six application checks (`policy, consent, readiness, approval, budget, grants`) must each be present **once**
and `pass` (`not_applicable` is accepted only for consent and for approval when none is required). A throw, an
unreadable value, a mislabeled or malformed result becomes `unknown` and is refused exactly like `fail`. Every
refusal is stored as a `refused` attempt with the evidence that was submitted. Missing `safetyVerified` means
**not verified**: the policy check fails, so no consequential effect can be admitted until a trusted content
classifier supplies it.

## Heartbeats, leases and stale recovery

- `heartbeat_agent_run` extends a **live** lease only and reports a pending pause/cancel/kill or the
  definition's `maximumRuntimeSeconds` ceiling (per lease). An expired lease is never resurrected.
- `recover_stale_agent_runs` (called at the start of every cron tick, safe from any number of instances, uses
  `SKIP LOCKED`) classifies each governed run whose lease expired **from its evidence**:

| Evidence | Result |
| --- | --- |
| an attempt is `started` | attempt, command and run become `unknown`; one reconciliation wait; nothing resumes |
| a cancel request is pending | `cancelled` |
| a pause request is pending | `paused` |
| nothing in flight | `waiting` with a `restart_recovery` wait (resumable) |

  The window claim uses the same classification when it meets an expired run for its window
  (`open_duplicate` for waiting/paused work, `unknown` as before). Legacy runs are untouched by the sweep and
  keep the old rule (expired lease ⇒ `unknown`).
- **Compatibility note.** For a governed run with no in-flight attempt, expiry used to mean `unknown`; it now
  means resumable. `agent-runtime-binding.int.test.ts` was updated for exactly that contract change. A governed
  run with an in-flight attempt is still `unknown`.

## Pause, cancel, kill

| Request | Run `running` | Run `waiting` / `paused` | Run `unknown` |
| --- | --- | --- | --- |
| **pause** (owner or manager; or system) | recorded; the worker sees it on its next heartbeat; no new step or attempt may begin; the worker acknowledges at a boundary with **no attempt in flight** → `paused` | acknowledged by the database → `paused` | recorded; applied when reconciled |
| **cancel** (owner) | recorded; in-flight attempts are marked `cancel_state = requested`; the worker acknowledges only after the attempt's outcome is recorded → `cancelled`; commands that never started become `cancelled` | acknowledged by the database → `cancelled` | recorded; applied when reconciled |
| **kill** (owner; or system) | acknowledged by the database **at once**: lease revoked, unstarted commands cancelled, an in-flight attempt becomes `unknown` and the run is `unknown` (`killed_in_flight`) until reconciled, otherwise `killed` | `killed` | stays `unknown`; becomes `killed` when reconciled |

Requests only escalate (pause < cancel < kill); repeating one is `unchanged`; a terminal run answers
`already_terminal`. **Requested is not stopped**: the `requested` outcome means a live worker has been asked.

Provider cancellation is separate. An attempt records `cancel_state`: `requested` (we asked), then what the
effect seam reported: `confirmed_cancelled`, `not_cancellable` or `unknown`. A cancelled run can therefore
truthfully show a **completed** command whose provider could not be stopped.

A person resumes a paused run with `resume_paused_agent_run` (owner or manager); it becomes `waiting` and the
resume claim continues it.

## Waits and reconciliation links

One open wait per run (unique partial index): `approval`, `customer_reply`, `time_window`, `connector`,
`dependency` (worker-created), plus `restart_recovery` and `reconciliation` (database-created). Each has a
reason, due time (≤ 90 days), owner (must be an active member), escalation time and target (`owner`/`manager`),
and a typed link (`pending_action`, `customer`, `command`) that is tenant-checked at creation.

- `park_agent_run_wait` releases the lease; it is refused while an attempt is in flight or a stop is pending.
- A wait is **ready** when it is due, when its linked pending action is decided (approved or rejected), or when
  it is a restart marker. A `reconciliation` wait is never ready.
- `claim_resumable_agent_run` is the resume claim: same lease/attempt compare-and-set, `attempt + 1` (this
  fences a zombie), honours the definition's concurrency ceiling, and **re-validates the exact binding**. A run
  whose binding broke while it waited becomes `failed` (`binding_not_current`, recorded in `binding_at_finish`);
  it never runs under another definition.
- Escalation is recorded once (`wait_escalated` event). Delivering a notification is not implemented.
- `resolve_agent_run_wait` lets an external event (for example a customer reply) satisfy a non-reconciliation wait.

Reconciliation (`resolve_agent_command_reconciliation`, owner or manager, written note required):
`effect_confirmed` → command `succeeded` (never repeated); `no_effect_confirmed` → `failed_before_effect`
(one new admitted attempt, same idempotency key); `cannot_determine` → recorded, still `unknown`. When no
unknown command remains the run becomes `waiting`/`paused`, or finishes the stop that was requested.

## Evidence

`agent_run_events` is an append-only ledger (claimed, command_registered, attempt_started, attempt_refused,
attempt_result, late_result_reported, lease_expired_unknown, stale_lease_recovered, resumed, resume_refused,
pause/cancel/kill requested and acknowledged, waiting, wait_escalated, reconciled, finished) with the actor
kind (`worker`, `human`, `system`, `recovery`, `database`). Steps, commands, attempts and waits carry their own
evidence. The only cascade that can remove any of it is tenant deletion.

## Tenancy and privileges

All tables have RLS enabled with **no** browser access; the service role has `SELECT` only. Every writer is a
`SECURITY DEFINER` function with `search_path = ''` that checks `auth.role() = 'service_role'` and is executable
by the service role only. Composite foreign keys tie every row to its run, shop, step, command and (for
approval links) pending action in the same shop. Human-initiated operations take `p_shop` and `p_actor` and
re-verify the live membership role in the database (`agent_definition_actor_role`); a run id from another
workspace is `not_found`, and another workspace's owner is `forbidden`.

## Compatibility and upgrade

- Only nullable columns were added to `custom_agent_runs`; the state CHECK was widened. No row is rewritten.
- Legacy claim, duplicate, lease-expiry-to-`unknown`, late-finish and `mark_scheduled_agent_run_unknown`
  behavior is unchanged (proved by an upgrade probe and the existing suites). A heartbeat also works for a
  legacy lease (additive); every ledger function refuses a legacy run (`run_not_governed`); the sweep ignores it.
- Existing operator copy (`agent-runs-sheet.tsx`, `custom-agent-card.tsx`) gained wording for the four new
  states so a waiting, paused, cancelled or stopped run is never labelled "Skipped". No other UI changed.
- The cron tick now runs `recoverStaleRuns` then `drainResumableGovernedRuns`. While the executor is off, a
  resumable run is finished truthfully (`skipped` with no commands; `failed` with evidence kept otherwise).

## Verification

Run on a disposable local stack only (no shared or production database):

- `eval/integration/agent-run-step-lifecycle.int.test.ts` (36): heartbeat and runtime ceiling; stale recovery
  both ways; 8-way concurrent sweeps racing a window claim; steps; command identity and dedupe; the gate
  (missing/failed/duplicate/not-applicable checks, 8-way concurrent begin admits one); replay; rejection retry
  with the same key; unknown never retried; reconciliation roles; budget; approval status/edit/consumption;
  revocation (moved policy, paused definition); pause/cancel/kill with and without an attempt in flight; role
  and revocation checks; waits (links, owners, due, escalation once, broken binding, 8-way resume admits one,
  concurrency ceiling); finish rules; privileges; cross-shop; append-only history; legacy compatibility.
- `eval/integration/agent-run-executor.int.test.ts` (16): the runner end to end with a fake provider: effect
  once and window replay; provider timeout → unknown → reconcile → resume with the same key; lease lost during
  the call; accepted-without-reference; pause then resume without repeating the finished effect; cancel and
  kill through the heartbeat; revocation between steps; failing and throwing rechecks; edited approval; zombie
  worker; approval wait then resume; production resolvers over real data.
- `eval/agent-run-step-lifecycle.test.ts` (19, runs in `npm test`): wrapper fail-closed behavior, recheck
  shape, call ordering (attempt durable before the effect, result recorded after, never finish over an
  unconfirmed attempt) and source locks (executor OFF, no direct ledger writes, no provider imports, writers
  service-only).
- `scripts/verify-agent-run-lifecycle-migration.py`: one rolled-back transaction on a stack still at the
  previous schema; 28 checks on historical rows, legacy behavior and privileges.
- Mutation checks (apply a broken function to the disposable stack, confirm the suite fails, restore): in-flight
  attempt not classified unknown; unknown command retried; resume without the attempt fence; late result
  believed; approval edit undetected; kill without unknown; finish over an in-flight attempt. Each was caught.

## Limitations (deliberate and explicit)

1. **The governed executor is still off.** `runPlaybook` is proven only with fake effects. No playbook
   registry, no provider adapter and no production effect uses this lifecycle yet. Enabling it needs its own
   reviewed change and live-provider decisions.
2. **The write-ahead guarantee is a protocol obligation.** The database enforces ordering inside its own
   functions, but it cannot stop code that performs an effect without calling `StepScope.command`. A governed
   run's recovery assumes every effect went through the ledger. Do not add effects outside it.
3. **Application-evaluated checks are evidence, not proof.** The database verifies binding, grants, budget,
   approval status and payload hash itself. Policy, consent, readiness and safety are evaluated by trusted
   server code and stored; the database requires them present and passing but cannot re-derive them.
   `safetyVerified` has no trusted classifier yet, so the production policy resolver blocks every
   consequential effect until one supplies it.
4. **A window remains between the gate and the provider call.** A pause, revoked consent or policy change can
   commit after admission; the effect then proceeds. Effects stay approval-first and downstream executors keep
   their own checks. Kill reaches the worker through the lease; it cannot reach into a provider.
5. **A lease lost during a provider call is `unknown` even if the provider succeeded.** This is deliberate.
   Workers must keep heartbeating while a call runs (the runner does, every third of the lease by default).
6. **One open wait per run, sequential steps only.** No parallel branches or multiple simultaneous waits.
7. **Limits are per lease, not cumulative.** `maximumRuntimeSeconds` restarts at each resume so a run waiting
   days for approval is possible. Step and credit limits are cumulative per run; daily and concurrent limits
   are per agent (a waiting run does not count as concurrent; the resume claim enforces the ceiling).
8. **Escalation is recorded, not delivered.** No notification, no queue entry, no operator screen for waits,
   control requests or reconciliation. Those are PR F/G work; the functions are the contract.
9. **Reconciliation evidence is a bounded written note** by an owner or manager. Gradia does not verify it
   against the provider.
10. **Only interval-scheduled governed runs** have a bound claim path (unchanged from Build 3). Event and manual
    governed triggers still refuse.
11. **No retention or pruning** is defined for the ledger tables yet.
12. **Migration ordering.** Created as `20261120103700` because a parallel session had already used
    `20261119120000`. `supabase db reset` could not be run in the authoring environment, so "from zero" is
    evidenced by applying it to disposable stacks already built from zero (127 and 122 migrations) plus the
    probe above. Re-check the ledger order if another migration lands first.
13. **Dedupe keys are per agent**, not per workspace, and free on `failed_before_effect` and `cancelled`.

## Next dependency

PR D (Call Copilot ingress) can rely on: stable command identity and the unknown-outcome rule for any
provider callback it initiates, `resolveReconciliation` for held outcomes, and `requestRunControl` for the
workspace kill path. It must not add a second claim or attempt table.

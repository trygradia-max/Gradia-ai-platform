# Whisper inbox presentation acceptance

Date: 2026-10-05. Branch: `codex/cursor-whisper-ui-polish`.
Scope is presentation and accessibility only. Server queries, command identity,
revisions, authorization, and approval staging were not changed.

## What changed

The existing `/conversations` list, thread page, loading state, and
`WhisperInboxControls` now use the current Gradia type, card, and status-pill
language. A presentational module, `whisper-inbox-presentation.tsx`, renders
the list and thread. Pages still load data and create command IDs.

- List and thread copy wraps, including long tokens, and the column stays
  within the viewport from a 320px phone width through a 1280px desktop width.
- Thread rows are one link each. The accessible name is the customer, channel,
  and work state. Preview and assignee are the description.
- Work state, unread, and new-handoff status use text, not color alone.
  Completed stays a neutral pill. It is not labeled delivered or sent.
- Message history shows Occurred time. Recorded time is added only when the
  stored copy arrived later. Newest recorded messages remain first.
- Controls use visible labels, described hints, 44px targets, and focus rings.
  Field errors and uncertain results use `role="alert"`. A confirmed result
  uses `role="status"`. Nothing retries with a new command ID.
- The handoff select starts on Held or Completed when that is already the
  settable state, and the existing reason is prefilled. Awaiting approval is
  not a settable handoff state, so that control still starts on Needs reply.
  The page states that saving does not pause queued delivery.
- Loading announces "Loading conversations" and does not look like an empty inbox.

## Behavior that stays in place

| Rule | Where it is enforced |
|---|---|
| Staff can mark their own read state only | `can_manage` / `can_reply` still hide handoff and reply controls |
| Managers with assignment permission can hand off and cannot stage replies | Reply form still requires `can_reply` |
| Voice has no reply composer | Channel check unchanged |
| Missing phone or email cannot queue a draft | Submit button stays disabled and the action is not called |
| Queue success means a draft in Approvals, not a send | Server message unchanged: "Draft queued in Approvals. Nothing was sent." |
| Email is a new outbound draft, not a provider-threaded reply | Composer copy unchanged |
| Marketing consent is still required | Composer copy unchanged |
| Completion is not delivery | Handoff copy unchanged |
| Handoff does not pause or cancel queued actions | Handoff copy unchanged |
| Held with no stored reason still says execution is unconfirmed and never to resend automatically | Same fallback string |
| Approved with no result still says to review and not resend | Same approval-link suffix, owner data only |
| Opening or refreshing does not send, mark read, or grant consent | List and thread copy |
| Unidentified interactions are not one shared thread | Same alert and intake link |
| Manager email delivery stays disabled | Same list sentence |
| Command IDs, revision, latest message, and payload shape | Still created in the server page and passed through |
| Controls only on the newest message page | `t && page === 1` |
| Paging window | Still 20 visible rows, with Next only when the read returns more than 20 |
| Ask Gradia stays separate and only for the active flagged shop | Same condition |

Customer and approval links still render only from owner-returned data
(`can_reply` and the actions array). Team conversations stay outside the
owner dashboard layout.

## Checks

Node 22 isolated runner, empty environment, outbound network denied:

| Check | Result |
|---|---|
| `scripts/isolated-check.mjs unit` | 1,169 passed, 4 skipped, 104 files |
| `scripts/isolated-check.mjs lint` | Passed |
| `scripts/isolated-check.mjs build` | Passed |
| `scripts/isolated-check.mjs types` | Passed after the build |
| `git diff --check` | Passed for the reviewed diff |

The prior baseline was 1,162 unit passes and the same four intentional live
skips. This slice adds seven presentation tests in `eval/whisper-inbox-ui.test.ts`.
Integration, migrations, and disposable Supabase were not run. No application
environment file was copied and the Next dev server was not started.

## Fixture browser pass

A fictional static render of the list, an owner email thread, an empty list,
and a failed load was opened locally with the production CSS. This was not an
authenticated owner, manager, or staff session, and no command was submitted.

| Width | Result |
|---|---|
| 320 | No horizontal overflow. Fields and buttons are 44px tall and sit inside the padded column. Long message text and the vehicle reference wrap. |
| 390 | No horizontal overflow. |
| 768 | No horizontal overflow. Actions shrink to their labels instead of stretching across the tablet. |
| 1280 | No horizontal overflow. The column is 896px and centered. Names, status, and previews sit on one card without colliding. |

The accessibility tree named each conversation link with customer, channel, and
state. The held reason, unconfirmed approval link, required reason, subject,
and reply fields were exposed. No control used a positive tabindex. The embedded
browser did not apply `:focus` while the window was unfocused, so the visible
focus ring was confirmed in the built CSS selector (`.focus:ring-3:focus` and
the control `focus-visible` utilities) rather than by a keyboard screenshot.

## Unresolved

- Live owner, manager, and staff sessions, including submit, toast, refresh,
  and a real keyboard-only pass, still need a disposable preview.
- A held thread that also has an operator reason shows that reason. The
  "never automatically resend" sentence still appears when the reason is empty
  and on owner approval rows whose execution result is missing. Those two holds
  remain one status value.
- In-app notifications still appear only after refresh. Manager email delivery
  is still disabled. Email replies are still not provider-threaded.
- Intake and approval references on a thread are still unbounded.
- An untouched save on an awaiting-approval thread still submits Needs reply.
  The copy says this does not pause the queued approval. The server remains
  the authority for whether that write is accepted.

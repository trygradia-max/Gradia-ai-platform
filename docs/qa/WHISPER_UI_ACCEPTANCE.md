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

## 2026-10-09 signed-in keyboard pass

Branch: `codex/cursor-component-polish`. Disposable Cursor preview only:
launcher `http://localhost:3128`, app `http://localhost:3127`. Codex demo
`3109`/`3110` was not used. Scope stayed presentation (markup, ARIA, focus,
CSS). No server actions, RPCs, migrations, or query semantics.

### Runtime

Reused the already-running preview (launcher PID listening on 3128, Next on
3127). `3128` returned 200; `3127` returned 307 then the signed-in inbox after
`/demo?role=…`. No second Next server was started.

### Roles

| Role | Inbox | Thread | Notes |
| --- | --- | --- | --- |
| Owner | Full list, unidentified alert, usage/setup pills, Ask Gradia pane | Alex: customer link, mark read, handoff, queue draft. Priya: long name, operator-hold alert, held select + required reason. Casey: queue disabled, no phone. Taylor: no composer, voice copy. Sam: unconfirmed-execution alert and approval link. Jordan email read returned the existing unavailable card (list still shows the row). | First focusable is Skip to main content. Combobox names are “Responsible operator” and “Work state”. |
| Manager | Full list. No unidentified alert, usage/setup pills, or Ask Gradia pane. Approvals nav has no owner count. | Alex: mark read + handoff. No queue draft, no customer record link. | `assignments.manage` / `crm.read` only. |
| Staff | Alex only. | Mark read only. No handoff, reply, or customer link. | Assignment fixture. |
| Revoked | Alert: “Conversation workspace unavailable.” Link to `/team`. | n/a | Shell skip link still first. |

Nothing was submitted. No command IDs were consumed.

### Keyboard and viewports

Tab/Shift-Tab DOM events in the embedded pane do not move `document.activeElement`
(same limit as the 2026-10-08 fixture pass). Order was confirmed from the
accessibility tree: Skip to main content, sidebar, top bar, inbox skip links,
then content. Skip-link CSS now matches `:focus` and `:focus-visible`; the
focused appearance is `position: fixed; top/left 1rem` with a 3px ring. The
unfocused embedded window still does not paint `:focus`, so the 2026-10-09
skip-link screenshot remains the visual proof.

Skip-to-main-content targets `#main-content` (`tabIndex={-1}`). After client
navigation, `RouteFocus` moves focus to `#whisper-thread-title` or
`#whisper-list-title`. Full page loads keep the browser start position.

Escape closed the Ask Gradia dialog and returned to the thread. Enter on a
conversation row did not navigate in this pane (click focused the link only);
direct navigation to the same href opened the thread.

| Width | Thread open | Overflow | Notes |
| --- | --- | --- | --- |
| 320 | List hidden | none | Title and long tokens wrap. Back link 44px. |
| 390 | List hidden | none | Back link 44px. Off-screen skip links are the only “clipped” hit. |
| 768 | List hidden (lg is 1024) | none | |
| 1440 | Two-pane | none | Existing list, skip-link, and Alex screenshots. |
| 1920 | Two-pane | none | |
| 200% zoom | not re-measured in this pane | — | Left for a focused-window pass. |

### Screenshots

`docs/qa/screenshots/2026-10-09/`

- `owner-1440-list.png`
- `owner-1440-skip-link-focused.png`
- `owner-1440-thread-sms-alex.png`
- `revoked-1440-unavailable.png`

### Presentation fixes in this slice

- Shell skip link to `#main-content`.
- Skip-link `:focus-visible` alongside `:focus`.
- Handoff selects sit beside their labels so the accessible name is the label,
  not the label plus every option.
- Focusable list/thread headings and `RouteFocus` after in-app navigation.
- Thread column scrolls when the controls pane would clip Refresh.

### Still open

- Live Tab/Shift-Tab paint of `:focus` needs a focused OS window.
- Jordan email `read_whisper_thread` still renders the unavailable card.
  Presentation is honest; the read is a server/fixture issue.
- Next.js hydration warning on `app-sidebar.tsx` `NavRow` (locale/time).
- Team pages still use their own chrome without the shell skip link.
- Contrast measurement, 200% zoom, and the later token/component slice are
  not part of this close-out.
- In-app notifications still appear only after refresh. Manager email
  delivery is still disabled. Email replies are still not provider-threaded.

## 2026-10-10 skip / focus / zoom / contrast

Branch: `codex/cursor-ui-a11y`. Same disposable preview (3128 / 3127).
Codex 3109/3110 left alone. Presentation only.

### Hydration

The NavRow mismatch was not locale/time. Framer Motion `layoutId` /
`useReducedMotion` changed the active-rail markup between server and
client. The rail is now a static span. After a full reload, the Next.js
hydration overlay did not return on Home.

### Keyboard

Tab events in this pane still do not move `document.activeElement`.
`element.focus()` on the skip link made it `position: fixed; top/left 16px;
height 36px` with a 3px outline. First focusable on Home, Conversations,
and Team is Skip to main content. Team uses `TeamChrome` (own chrome, same
skip + `#main-content`). Command bar remembers the opener and focuses it
on close. Ask Gradia click in this pane hit a zero-size (hidden `lg`)
instance; the visible 44px control is the compact top-bar button.

### 200% zoom

`Emulation.setDeviceMetricsOverride` width 960 / deviceScaleFactor 2
(1920 CSS px at 200%). Home and Conversations: `scrollWidth === clientWidth`,
no clipped primary actions. Customers table is a labelled, focusable
overflow region.

### Contrast

See `docs/qa/CONTRAST_2026-10-10.md`. Opaque text/status pairs pass.
Live compiled skip outline was still `ring/50` (2.62:1); source now uses
a solid `#A78BFA` ring (6.88:1).

### Still blocked

Jordan Lee email `read_whisper_thread` still shows the unavailable card.
List row is present. Not a presentation-only gap; no backend contract was
invented.

## 2026-10-10 Team / Settings presentation

Branch: `codex/cursor-ui-settings`. Same disposable preview (3128 / 3127).
Owner then manager spot-check. Nothing submitted. Billing copy still
`$20` / `+$29`.

| Surface | Result |
| --- | --- |
| Team (owner) | Skip link first. Workspace selector. Member/grant forms, assignments, delivery/intake links. |
| Team (manager) | Skip link. Manager workspace, assignments only. No owner membership editor. |
| `/team/approvals` (manager) | Honest “not been delegated” card. Same grant gate. |
| Delivery reviews (owner) | SectionHeader + empty “No held messages on this page.” |
| Settings | Control Center card, Channels/Your business without `/70`. |
| Control Center | Skip + StatusPill + 44px Save draft / Activate. |
| Receptionist | Shared SectionHeader. Compact Ask Gradia 44px. |
| Billing | Layout only. Prices unchanged. |

320 and 960 CSS px: Settings, Team, Receptionist had `scrollWidth === clientWidth`.
`browser_take_screenshot` timed out; verification is a11y snapshots + measured
overflow. Live `team-panel` client bundle stayed on the previous button classes
until the 3127 HMR cache is cleared; source already uses `min-h-11`.

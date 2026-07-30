# Flow — Communications Inbox

_Created 2026-07-27 by the Organizer (audit correction: the founder Communications parity section had no flow representation). Governs the E07 unified-inbox experience: Conversations becomes read AND write across voice + SMS + email. Consent/compliance gates remain code-enforced (D-012); connected-mailbox, transactional app email, and campaign email stay related-but-distinct systems (E07 §Integrations)._

**Maturity:** TARGET — today Conversations unifies calls + SMS read-side with SMS reply via operator quick-reply (policy question Q-05); email is read-only ingest, no in-thread composer, no templates/scheduled send/assignment/unread state.
**Phase/Epic:** E07 / P7 (assignment requires E01 roles; assignment UI may degrade gracefully to owner-only before that).

## Entry point
Conversations destination (sidebar); customer file → thread; Approvals card → View conversation; notification (new inbound, target).

## User objective
Every customer conversation — call, text, email, website lead — in one thread per person, answerable in place, nothing unread and forgotten.

## Required data
Unified thread (interactions spine, one brain), channel + direction per message, delivery status, consent state (SMS STOP / email unsubscribe), assignment (post-E01), unread markers, templates, scheduled-send queue.

## Exact steps
1. Owner opens Conversations → thread list with unread state, channel icons, one-line summary, outcome badge, needs-review flag.
2. Filters/search: by channel, unread, assigned-to-me (post-E01), needs-review; free-text search across thread content.
3. Open thread → full cross-channel history (calls with transcript links, SMS, email) in one timeline; consent state visible at the top (opted-out / unsubscribed banners — composer respects them).
4. Reply in place: composer picks the channel (default: the customer's last channel); templates insertable with variables filled from the customer record; send now or schedule (quiet-hours aware).
5. Sends execute through the standard send path — send policy, A2P, quiet hours, opt-out, metering all bind at execution; delivery status (queued → delivered / failed) renders on the message.
6. Failed sends alert visibly (thread + Activity), never silently drop.
7. Internal notes: teammate-visible notes inside the thread, never sent to the customer, visually unmistakable from outbound.
8. Assignment (post-E01): assign thread to a member; assignee sees it in "Mine"; unassigned inbound follows shop routing rules.
9. Mark read/unread; resolved threads archive out of the default view but stay searchable.

## System decisions
- One thread per customer identity, not per channel (unified memory spine — the existing cross-channel flag "also emailed 2h ago" surfaces here).
- Composer hard-blocks opted-out channels with the reason shown (STOP/unsubscribe is code-enforced, not advisory); operator quick-reply policy per Q-05 resolution.
- Scheduled sends are visible and cancelable until execution; they release per policy, never silently.
- Campaign/bulk messaging is NOT this surface (recovery/campaign flows own it, with their TCPA gates); the inbox is 1:1.
- Email replies thread on the original message (outbound threading — `aurinko.ts:356` fix in E07 scope).

## AI involvement
Suggest-HITL: drafted replies appear as suggestions in the composer (owner edits/sends); autopilot sends (Package 2) log to the thread with the AI flag. Inbound classification stays the existing pipeline; the inbox renders its outcomes.

## Permissions
Owner today. Post-E01: role-scoped — techs see assigned-job threads only (Q-17 matrix); export/bulk actions owner/admin.

## Error states
- Send failure → message marked failed with reason + retry affordance; Activity entry; alert if a pattern (P0-012 seam).
- Channel disconnected (mailbox OAuth lapsed) → thread banner + ConnectionTile state; composer disables that channel with a named reason.
- Template variable missing (no vehicle on file) → composer flags before send, never sends "Hi {vehicle}".

## Empty states
- "No conversations yet. Your number and inbox are connected — new calls and messages land here."
- No-results (filter): "Nothing matches. Clear filters."

## Success state
Reply delivered with visible status; unread count clears; the thread reads as one continuous relationship across channels.

## Next recommended action
Next unread; or convert an inbound into a lead/quote from the thread (quick-create pattern, 06 §7).

## Mobile behavior
Thread list and reply composer are core mobile surfaces (owner answers from their phone mid-job): one-column threads, tap-to-talk for Whisper drafts, scheduled-send picker usable on phone; unread badge on the tab bar.

## Analytics events
`Conversation replied` (channel, template-used, AI-drafted y/n), `Message send failed`, `Thread assigned` (post-E01), `Scheduled message sent`, `First reply from inbox` (activation).

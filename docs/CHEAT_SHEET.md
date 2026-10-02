# Gradia cheat sheet

For Harry, and for every AI session. Read this before editing. Append
`docs/AI_WORK_LOG.md` before you finish.

## Where the work lives

| Path | Use it for |
| --- | --- |
| `~/Gradia/platform` | The only app. GitHub `trygradia-max/Gradia-ai-platform`. |
| `~/Gradia/marketing` | The website. Do not edit it from a platform session unless Harry asks. |
| `~/Gradia/worktrees` | Active git checkouts. Do not move or delete them. |
| `~/Gradia/old-gradia-info` | Old screenshots and notes. Do not build from it. |
| `~/Gradia/platform` on local `main` | Stale checkout at `20e153a`, plus Harry's uncommitted `CONTEXT.md`. Do not reset it. |

Current documentation branch: `codex/mvp-documentation-reconciliation`, draft PR
[#49](https://github.com/trygradia-max/Gradia-ai-platform/pull/49). Do not merge
or deploy unless Harry says so in that session.

## What to read

1. This file.
2. `docs/AI_WORK_LOG.md`
3. `docs/product/GRADIA_MVP_VISION.md`
4. `docs/roadmap/MVP_IMPLEMENTATION_SEQUENCE.md`
5. `docs/architecture/GRADIA_AGENT_ARCHITECTURE.md`
6. `docs/architecture/AUTONOMY_APPROVAL_MODES.md`
7. `docs/architecture/GRADIA_MEMORY.md`
8. `docs/roadmap/POST_MVP_IDEAS.md` for anything that is not this MVP.

`CONTEXT.md` does not outrank those five documents. Older plans in
`docs/gradia-v2/` are history.

## AI tag

`[AI: cursor | claude-code | codex] [DATE: YYYY-MM-DD] [AREA: platform | marketing | docs | archive] [STATUS: done | in-progress | blocked]`

Say what changed, the branch or PR, and what you left alone.

## This MVP, in one pass

Gradia works the front of a detailing shop. One Gradia Agent files a new lead,
qualifies them, drafts the next text, quotes from the shop's menu, books a
time, updates the pipeline, and can send that same customer a confirmation,
reminder, or check-in.

First release is a controlled pilot for 5–10 shops on SMS, the website form,
and Meta. Email joins after inbox reply works. The phone receptionist is part
of the finished product and stays off until a real call, call forwarding, and
keeping the shop's own number are proven.

The owner approves customer-facing actions until they explicitly turn one
action on. The CRM still works with the AI off.

## Not this MVP

Do not build or claim these. They are future products unless noted.

- Payments and point of sale
- Full work orders
- Win-back campaigns
- “Please leave a Google review” texts
- On-the-go owner access: text a Gradia number, or an in-app chat like Meta Muse
- Fleet accounts (described only, not scheduled)
- A free trial
- A second named bot, or a separate Whisper brain

## Prices

Confirmed plan prices: Core $99, Pro $149, Operator $249. Live checkout still
charges the old $20 / $29 until billing is shipped. No free trial.

Seat counts are a guess, not a decision: Core includes the owner + 1 staff,
Pro includes the owner + 1 manager + 2 staff, Operator includes the owner + 2
managers + 5 staff. Extra staff $19, extra manager $29. Do not publish that
guess.

## What is actually built

Merged and still not “live”: team membership and a Control Center draft editor
(PR #48 on `main` `247bb50`). Saving a draft does not change what the Agent is
allowed to do. The next build is wiring that policy into real execution. Do
not start a second editor.

Also true: Chief of Staff exists. Services, prices, and hours can be entered
in onboarding. Voice code exists and has not passed a real call. Conflict
checks are built and switched off. Nothing yet tells the owner an approval is
waiting.

## Rules that keep sessions from drifting

- One ticket or one docs change. Do not start the next feature in the same session.
- Do not overwrite Harry's `CONTEXT.md` on the stale `platform` checkout.
- A merge, a green test, or a successful login is not a live channel.
- Customer texts, quotes, and bookings go through the existing approval path.
- Money, cards, and full jobs in the bay are future. Do not sneak them into MVP work.
- Record the decision in `POST_MVP_IDEAS.md` or this file. Do not leave it only in chat.

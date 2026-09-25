# Gradia platform

This directory is the only product repo: `trygradia-max/Gradia-ai-platform`.
The parent folder `~/Gradia` also contains the marketing repo, active git
worktrees, and `old-gradia-info/` for retired notes and screenshots. Do not
start a second platform checkout to “clean up” history.

Start with `docs/CHEAT_SHEET.md`. Sellable MVP authority is the five September
11, 2026 documents listed in `CLAUDE.md`. There is no free trial. Plan prices
are Core $99, Pro $149, Operator $249. Seat counts are still a guess.
Payments, work orders, win-back, review texts, and the on-the-go app are
future, not this MVP.

## AI handoff rule

Claude Code, Cursor, and Codex all read `docs/AI_WORK_LOG.md` before editing
and append one tagged entry before finishing:

`[AI: cursor | claude-code | codex] [DATE: YYYY-MM-DD] [AREA: platform | marketing | docs | archive] [STATUS: done | in-progress | blocked]`

Say what you changed, the branch or PR, and what you left alone. Do not claim
a merge or deploy you did not perform.

## Run locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Read
`node_modules/next/dist/docs/` before changing Next.js code. This app is not
the Next.js version assumed by older training data.

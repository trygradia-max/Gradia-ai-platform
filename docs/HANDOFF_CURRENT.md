# Current Gradia handoff — October 8, 2026

## Start here

Repository: `trygradia-max/Gradia-ai-platform`. This consolidation brings the
committed Control Center execution, MCP capability guards, lead intake, reviewed
customer/vehicle linking, Whisper handoff/reply/reconciliation, threaded email,
disabled manager notification worker, Cursor accessibility polish and current
MVP documentation onto one reviewable branch. It also retains historical reports
and the vehicle-size duration-range fix. This is code integration, not launch.

Read `AGENTS.md`, `docs/AI_WORK_LOG.md`, then the five governing documents:

1. `docs/product/GRADIA_MVP_VISION.md`
2. `docs/roadmap/MVP_IMPLEMENTATION_SEQUENCE.md`
3. `docs/architecture/GRADIA_AGENT_ARCHITECTURE.md`
4. `docs/architecture/AUTONOMY_APPROVAL_MODES.md`
5. `docs/architecture/GRADIA_MEMORY.md`

Those documents define scope. Their dated implementation snapshots are historical;
use this handoff and the implementation ledgers for newer code. `CONTEXT.md` and
older roadmap checkboxes do not select the next task.

## Local folders and ownership

All paths below are relative to `/Users/harryhatch/Gradia/`.

| Folder | Purpose |
| --- | --- |
| `worktrees/mvp-consolidation/` | Assembled, verified integration checkout for this merge |
| `worktrees/cursor-ui-next/` | Fresh post-merge UI checkout for Cursor; branch `codex/cursor-ui-next` |
| `worktrees/claude-backend-next/` | Fresh post-merge backend checkout for Claude Code; branch `codex/claude-backend-next` |
| `worktrees/mvp-layout-wip/` | Snapshot of unfinished inbox/app-shell layout work; `codex/wip-inbox-layout-2026-10-07` |
| `worktrees/platform-ui-wip/` | Snapshot of older navigation/pipeline/customer layout work and founder notes; `codex/wip-platform-ui-2026-10-07` |
| `worktrees/mvp-lead-intake/` | Original October backend checkout with uncommitted newer UI; preserved, do not reset |
| `worktrees/mvp-whisper-ui-polish/` | Original Cursor polish checkout; its committed work is included in consolidation |
| `platform/` | Stale founder checkout with local edits; preserved, do not pull/reset over it |
| `marketing/` | Separate marketing website repository, not the SaaS app |
| `_docs/` | Older shared business/reference material |
| `old-gradia-info/` | Archive; not a development baseline |

The two fresh next-work folders are created after the consolidation merges. Every
agent uses its own branch/check-out. Do not run two editors against one worktree.

## Cursor UI lane

- Screens: `src/app/(dashboard)/`, `src/app/conversations/`, `src/app/intake/`,
  `src/app/team/`, and `src/app/onboarding/`.
- Product components: `src/components/gradia/`; shared primitives: `src/components/ui/`.
- Styling: `src/app/globals.css`, `DESIGN.md`, `docs/BUILD_REFERENCE.md`.
- Existing Whisper UI: `whisper-inbox-controls.tsx`, `whisper-inbox-presentation.tsx`.
- UI checks: `eval/whisper-inbox-ui.test.ts`, `docs/qa/WHISPER_UI_ACCEPTANCE.md`.

First bounded task: reconcile the saved app-shell/two-pane inbox WIP onto the merged
baseline, preserving Cursor's focus, label, keyboard, touch-target and validation
work. The WIP replaces overlapping controls and predates newer email-thread wording;
do not bulk-copy it over current code. Preserve server-side permissions, exact reply
context, durable command IDs, uncertain-delivery holds and honest error states.
Then perform responsive, keyboard and accessibility acceptance on a disposable setup.

## Claude Code backend lane

- Server actions: `src/app/actions/`; provider ingress/cron routes: `src/app/api/`.
- Domain and provider boundaries: `src/lib/`; Control Center: `src/lib/control-center/`.
- Intake: `src/lib/lead-intake*`, `src/lib/intake*`, intake actions and migrations.
- Whisper: `src/lib/whisper-inbox.ts`, `src/app/actions/whisper-inbox.ts`,
  `src/lib/email-reply*`, `src/lib/manager-notification*`, `src/lib/notification-email-provider.ts`.
- Approval/permissions: `src/lib/approvals.ts`, `src/lib/shop.ts`, `src/lib/team-permissions.ts`.
- Schema: `supabase/migrations/`; database tests: `eval/integration/`.
- Unit tests: `eval/`; disposable tooling and catalog probes: `scripts/`, `tests/`.

Choose one bounded incomplete dependency from the sequence: public form/Meta contact
retrieval and shop binding; delegated manager operations; notification provider
acceptance; or persisted qualification/nurture. First inspect existing code and the
three ledgers below; do not rebuild intake, the policy editor, or a second executor.
Coordinate shared component/action contracts with Cursor before changing them.

## Implementation ledgers and remaining gates

- `docs/architecture/CONTROL_CENTER_IMPLEMENTATION.md`
- `docs/architecture/LEAD_INTAKE_REVIEW.md`
- `docs/architecture/WHISPER_INBOX.md`
- `docs/architecture/PUBLIC_FORM_INTAKE.md`
- `docs/AI_WORK_LOG.md`

Current known limits include delegated manager approvals (delivery review is
delegable as of October 8; approval execution is not), public
form setup/embed UI and browser/anti-bot acceptance, Meta Graph contact retrieval/connect UI, channel acceptance,
notification sender/delivery acceptance, qualification/nurture, complete guarded
quote-book-pipeline flow and reviewed memory publication. Full browser/a11y and
live model/provider evaluations are not replaced by deterministic tests.

`vercel.json` has `git.deploymentEnabled: false` so these merges do not deploy.
Do not re-enable deployment, apply shared/production migrations, activate providers,
remove production write guards or send real messages as part of a UI/backend task.
Those require their own release work. The current code includes 89 migrations;
the production ledger must be inspected separately before any release.

Public website intake now has an owner-configured backend and anonymous JSON endpoint
that records inquiry evidence for identity review. Its setup UI is still pending;
see `docs/architecture/PUBLIC_FORM_INTAKE.md` before building it. The implementation
lives in `worktrees/public-form-intake/` on `codex/public-form-intake`.

## Work intentionally not merged

- Billing PR #38 contains the superseded free-trial model and tier assumptions.
  Reconcile it with the approved no-free-trial decision before integrating it.
- The two saved WIP branches preserve unfinished overlapping UI and founder notes.
  They are recovery/review snapshots, not a second current product baseline.
- No marketing repository changes are included.

Append a dated, tagged entry to `docs/AI_WORK_LOG.md` for each completed task.

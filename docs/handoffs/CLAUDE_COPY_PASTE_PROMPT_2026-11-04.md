# Copy-paste prompt for Claude Code

Use this prompt to start Claude's next branch. It intentionally requests only the
first reviewable PR; later Agent OS, Call Copilot and quote work must not be mixed
into the same migration.

```text
You are implementing the next Gradia Agent OS backend slice.

Repository: https://github.com/trygradia-max/Gradia-ai-platform
Start from fresh origin/main in a new isolated worktree and branch. Do not use or
overwrite another agent's checkout. Suggested branch:
claude/onboarding-baseline-backend

Before editing, read completely:
- AGENTS.md
- docs/AI_WORK_LOG.md (latest entries)
- docs/product/GRADIA_MVP_VISION.md
- docs/roadmap/MVP_IMPLEMENTATION_SEQUENCE.md
- docs/architecture/GRADIA_AGENT_ARCHITECTURE.md
- docs/architecture/AUTONOMY_APPROVAL_MODES.md
- docs/architecture/GRADIA_MEMORY.md
- docs/roadmap/AGENTIC_OS_MASTER_BUILD.md
- docs/roadmap/NEXT_BUILD_ORDER_2026-11-04.md
- docs/product/ONBOARDING_BASELINE_ASSESSMENT.md
- docs/handoffs/CLAUDE_NEXT_BUILD_2026-11-04.md
- docs/architecture/AGENT_QUOTE_AND_JOB_CAPABILITIES.md

Implement PR A only: the backend-only onboarding baseline contract and persistence.

Required:
1. A finite, versioned question/answer schema with bounded values, units and an
   explicit unknown value distinct from zero.
2. Immutable tenant-bound assessment revisions and one baseline pointer that can
   advance atomically without mutating prior revisions.
3. Server-derived authority: owner submit/supersede; delegated manager may draft;
   staff, revoked, anonymous and cross-shop callers are denied.
4. Evidence classes owner_estimate, connected_evidence, gradia_observed, derived and
   unknown, with observation windows and formula versions.
5. Minimal starting-point and comparable-window DTOs for Cursor. Failed/unreadable
   data returns unavailable, never zeros. Do not include model-written narrative.
6. Disposable from-zero migration tests for immutability, concurrency, revocation,
   cross-shop denial, invalid units/ranges, unknown-versus-zero and non-comparable
   periods/definitions.

Constraints:
- Do not edit onboarding UI in this PR.
- Do not add an opaque efficiency score, invented ROI, analytics vendor, credentials
  or model-generated baseline values.
- Do not modify current onboarding records destructively or create a second shop.
- Do not implement Call Copilot, agent definitions, quote.create or repair orders in
  this PR. Those are later isolated slices.
- Do not change shared/production data, enable providers/crons/Stripe, deploy, merge
  or lift any production guard.
- Read the relevant Next 16.2.6 docs in node_modules before Next code.
- Append a tagged docs/AI_WORK_LOG.md entry when finished.

Validate with focused unit tests, full unit, TypeScript, lint, Next webpack build,
from-zero disposable migrations and focused integration. Push a reviewable PR and
hand back exact base/head commits, migration names, authority changes, commands and
totals, remaining limitations and the exact DTO Cursor may consume.

After PR A is reviewed and merged, stop and wait for the next assignment. The later
sequence is immutable definitions, lifecycle completion, Call Copilot ingress,
Call Copilot extraction/CRM proposals, then first-class quote.create integration
using the existing quote engine. Do not combine those into PR A.
```

## Fresh worktree commands

Run from the repository that owns the worktrees:

```bash
cd /Users/harryhatch/Gradia/platform
git fetch origin main
git worktree add /Users/harryhatch/Gradia/worktrees/claude-onboarding-baseline \
  -b claude/onboarding-baseline-backend origin/main
cd /Users/harryhatch/Gradia/worktrees/claude-onboarding-baseline
```

If that branch or directory already exists, Claude must inspect it and choose a new
explicit path/name rather than deleting or overwriting it.


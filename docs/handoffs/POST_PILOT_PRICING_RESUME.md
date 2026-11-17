# Resume handoff: post-pilot pricing proposal

_Created 2026-11-16. Documentation only. Delete or archive when the PR merges._

## Task

Write `docs/product/POST_PILOT_PRICING_AND_EXPANSION_2026-11-16.md`: founder-directional,
evidence-grounded post-pilot pricing, packaging, expansion and enterprise proposal
(Core 299 / Growth 799 / Scale 1999 / Custom 3000+, all labeled proposed, not approved or
sellable). Founder Pilot ($199, catalog `2026-11-03.v1`) stays the only approved catalog.
No code, migration, provider, Stripe, deploy, shared-data or production change. Append
`docs/AI_WORK_LOG.md`. Commit, push, open a **non-draft** docs PR. **Do not merge.**

- Branch: `claude/post-pilot-pricing-strategy` (worktree `~/Gradia/worktrees/claude-post-pilot-pricing`),
  based on `origin/main` `a56a150`.

## State at checkpoint

- [x] Read AGENTS.md, AI_WORK_LOG, CHEAT_SHEET, five governing docs, approved catalog,
  agent-builder pricing, hybrid model, settlement, GTM master, production readiness.
- [x] Fetched primary pricing 2026-11-16: Vapi, Twilio voice/SMS, Stripe, Intercom, Gorgias,
  Jobber, Salesforce Agentforce, Zendesk, HubSpot Service Hub, Smith.ai.
- [x] Model script (python, not committed) reproduced the catalog's formulas and added Stripe
  Billing 0.7%. Recommended allowances all pass the gates:
  - Core 299: 180 outcomes, 125 voice min, 300 SMS, 1 number, 4 seats, 3 agents → 83.9 / 79.8 / 67.8
  - Growth 799: 500, 350, 1000, 2 numbers, 8 seats, 6 agents → 83.3 / 79.0 / 66.5
  - Scale 1999: 1300, 900, 2000, 3 numbers, 20 seats, 15 agents → 83.3 / 78.9 / 65.9
  - (target / minimum-planning / stress contribution %)
  - Voice retail floor cost/0.30 (≈ $0.46 at $0.1374); SMS cost/0.30 (≈ 3.33x).
- [x] Proposal doc written, work log appended, pushed.
- [x] PR #149 opened (non-draft): https://github.com/trygradia-max/Gradia-ai-platform/pull/149. **Not merged.**
- Remaining: founder review only. Re-confirm vendor prices on live pages before external use.

## Resume steps

1. `git status` in the worktree; if the proposal doc exists, review it against this file.
2. Finish the doc, append the `AI_WORK_LOG.md` entry (tag line first).
3. `git add docs/ && git commit`, `git push -u origin HEAD`, `gh pr create` (no `--draft`).
4. Do not merge. Report the PR URL.

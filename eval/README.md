# Eval harness

A small golden set you re-run after any change, so an agent regression shows up
as a failing test instead of something you notice weeks later. Deliberately not
exhaustive — add cases when a real bug slips through.

## Two tiers (they fail differently)

**Tier 1 — pure assertions.** Deterministic, free, fast. No network. The safety
properties that must never silently regress. **Run on every change.**
- `guardrails.test.ts` — HITL floor (book/charge always stage, even in
  autonomous mode), autonomy default/override resolution, and a source scan
  proving the BI tool layer has no write calls.

**Tier 2 — golden cases (LLM-backed, exact/structural assertions).** Real inputs
→ expected structured output. Cheap-ish, mildly nondeterministic; assertions are
tolerant on substance (contains/regex/digits) and strict on the empty-string
contract.
- `extraction.eval.test.ts` — the Haiku lead extractor (`ai-service.ts`).
- `classification.eval.test.ts` — the SMS + email classifiers, including
  noise → `is_lead: false` and empty fields.
- BI exact half in `bi.eval.test.ts` — right number + runtime read-only tool use.

**Tier 3 — LLM-as-judge (sparing).** For open-ended output with no single right
string. A second model scores against a rubric. Costs tokens + adds
nondeterminism — keep it to a few cases.
- BI answer tone in `bi.eval.test.ts`.

## Running

```bash
npm test          # Tier 1 only — pure, no API key, run constantly
npm run eval      # all tiers (EVAL_LIVE=1) — costs Anthropic tokens
```

Live tests self-skip unless `EVAL_LIVE=1` and `ANTHROPIC_API_KEY` is set
(loaded from `.env.local` by `eval/_setup.ts`).

## Adding a case

Most additions are just a row in a JSON file under `eval/cases/`:

- **Extraction / classification** — add `{ input, expect }`. Field specs:
  `{ "empty": true }` (strict ""), `{ "contains": "..." }` (case-insensitive),
  `{ "matches": "regex" }` (case-insensitive), `{ "digits": "5035550188" }`
  (compares digits only). When you find a real miss in production, paste the
  exact inbound text in as a new case — that's the whole point.
- **Judge** — call `judge({ output, rubric })` and assert `verdict.pass`. Keep
  rubrics as a short list of must-haves.

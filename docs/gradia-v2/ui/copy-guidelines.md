# UI — Copy Guidelines

_Created 2026-07-25 by the Organizer. Condenses `_docs/redesign/GRADIA-LANGUAGE-PACK.md` (binding) and `platform/docs/BUILD_REFERENCE.md` §1 voice rules. Claims discipline for anything marketing-adjacent: `_docs/WHAT_GRADIA_DOES.md` (D-028)._

## The two voices — never mix them

**NARRATOR (UI chrome).** Third person, plain, specific, brief. Says "your receptionist" / "Gradia" — never "the AI" (Language Pack §1). This is every label, empty state, toast, tooltip, settings description, and section header.

**CHARACTER (agent-authored content).** Chat bubbles, outbound previews, drafts, transcripts — anything the agent itself wrote. Keeps its **eval-locked we/us voice from `persona.ts`. Untouchable.** Chrome never rewrites, paraphrases, or "cleans up" character content; persona text is locked by tests (audit doc 07).

## Narrator rules

1. **Numbers over adjectives.** "Handled 12 calls," never "Great day!"
2. **No exclamation marks** except first-ever success moments. **No emoji** in chrome.
3. **Human units for usage:** "~200 texts · ~20 calls" — credits in fine print, never the headline.
4. **Confidence is qualitative, never a percentage:** "Review this" / "Needs you" (Language Pack §3).
5. **No vendor names, env vars, or raw enums** anywhere an owner can see (UX spec rename map). "Does it answer my calls?" — not "Twilio subaccount status."
6. **Under-claim on purpose.** Every figure traces to a real row; upcoming revenue is ALWAYS split ("$X booked · $Y quotes out"), never blended; "captured," never "saved," for leads (HOME_REDESIGN_PLAN locked decisions).
7. **All chrome strings live in `src/lib/strings.ts`** — no hardcoded UI copy in components.

## Empty states — written, never blank

Three kinds, all authored:

| Situation | The copy's job | Example register |
|---|---|---|
| First use | Teach what will appear here and how to cause it | "Calls your receptionist answers will appear here." |
| No results | Offer the way out | "No customers match. Clear filters" |
| All done | Reassure | "Nothing waiting on you." |

## Status & badge copy

Status is icon + text. Text names the state in owner language: handled, booked, needs review, escalated, sending. Never bare color, never internal enum strings.

## Stale-copy debt (current, tracked)

Audit doc 08 found chrome that lies: the `/receptionist` agent-catalog prose described the retired Slack approval flow and linked `/chat`; `data/customers.ts` docstring claimed IG/FB search it doesn't do. **Rewrites shipped 2026-08-28 in P0-010 (PR #27)** — catalog now describes in-app Approvals and Conversations; the docstring matches the code (name/phone/email only). Rule going forward: copy describing a flow changes in the same PR that changes the flow.

## Claims discipline (chrome that sells)

Anything that states what Gradia does (onboarding, upgrade surfaces, connection tiles) must pass `_docs/WHAT_GRADIA_DOES.md`: live / beta / planned functionality clearly distinguished (D-028); never claim voice capabilities pre-acceptance-run; never "fully autonomous" / "set and forget"; retired framings ("front office," "AI office") stay retired.

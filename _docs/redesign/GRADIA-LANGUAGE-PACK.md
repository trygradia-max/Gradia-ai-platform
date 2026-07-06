# Gradia Language Pack

Every string in the product, one voice. Companion to `GRADIA-REDESIGN-SPEC.md`. Implement as a strings module (e.g., `src/lib/strings.ts` or i18n messages file) — no hardcoded UI copy in components, same rule as no hardcoded hex.

> **⚠️ SCOPED by `GRADIA-REDESIGN-SPEC.md` §8-A3 (2026-07-02) — narrator vs character:** this pack's voice governs **UI chrome only**. Anything the agent itself authored (chat bubbles, outbound message previews, transcripts) stays in its eval-locked **we/us** voice — `persona.ts` is no-touch. Also **§8-A8:** the nudge *engine* (§4 triggers/caps/persistence) is deferred post-alpha; only the `NudgeCard` component ships this phase.
>
> **AMENDMENT (2026-07-05, founder-decided):** approval buttons are **"Send it / Tweak it / Drop it"** — the shipped copy beats this pack's generic `Approve / Edit & approve / Dismiss` (§2). Same three-action HITL shape (never binary), equal visual weight on all three still applies.

## 1. Voice rules

Gradia talks like a competent employee giving a shift report: plain, specific, brief. Concretely:

1. **Numbers over adjectives.** "Handled 12 calls, booked 3 appointments" — never "Great day!"
2. **Plain English, zero jargon.** "Caller" not "inbound contact." "Booked" not "conversion event." Shop owners, not SaaS people.
3. **Gradia reports, it doesn't perform.** No exclamation marks except one allowed place: first-ever success moments ("Your receptionist is live!"). No emoji in product copy.
4. **Own errors in active voice.** "We couldn't send that message" — not "Message delivery failure occurred."
5. **Every state says what to do next.** No dead ends.
6. **The agent is "your receptionist" or "Gradia" — never "the AI"** in routine copy. Exception: the disclosure setting and anywhere honesty about AI-ness is the point.

## 2. Core microcopy

**Buttons:** verb + object, 1–3 words. `Save changes` · `Add number` · `Approve` · `Edit & approve` · `Dismiss` · `Try it` · `Not now` (never "No thanks, I'll stay slow" — confirmshaming is an FTC-flagged deceptive pattern).

**Empty states** (teach, never blank — NN/g):
- Conversations, first use: "No calls yet. Forward your number and your receptionist starts answering." → [Set up forwarding]
- Conversations, no results: "Nothing matches those filters." → [Clear filters]
- Review queue, empty: "Nothing needs you right now. Gradia will flag anything it's unsure about."
- Customers, first use: "Customers appear here automatically after their first call or text."

**Toasts:** past-tense fact + undo where reversible. "Greeting updated · Undo" · "Number added" · "Couldn't save — check your connection. Your edits are still here. [Retry]"

**Errors:** what happened + what we did + what you can do. "The follow-up text to (555) 201-4437 didn't send. We'll retry twice over the next 10 minutes. [Send now] [Cancel]"

**Glass-box "because" lines** (decision log format, spec §5.1): one sentence, past tense, cites the rule or data used. Pattern: *[action] because [setting/data source]*.
- "Offered Friday 10am because Thursday was fully booked in your calendar."
- "Escalated to your cell because the caller asked for a price we don't have listed."
- "Didn't book — the caller wanted Sunday and your hours show closed. [Fix hours]"

## 3. Confidence & review language

Never percentages (spec §5.4). Three levels only:
- (silent) — handled, logs normally
- "Review this" — amber, low confidence
- "Needs you" — queued approval, agent won't act without you

## 4. The nudge system (contextual upsells done honestly)

Your instinct is right — behavior-triggered suggestions convert far better than pricing-page banners, and the moment of felt need is the right trigger (this is how Grammarly, Loom, and Notion run PLG upsells). But the example phrasing needs surgery, and the delivery needs guardrails, or this becomes the feature users screenshot to complain about.

### 4.1 Why "Gradia noticed you have been reviewing dead leads non stop" fails

Three problems, all fixable:
- **"Gradia noticed" + vague behavior = surveillance framing.** Personalization research: nearly two-thirds of "that was too personal" reactions come from a product referencing information the user didn't knowingly share or can't see. Fix: cite the exact, visible, in-product count — the user can verify it.
- **"Non stop" is judgmental.** It editorializes about the user's behavior. State the number; let the number make the argument.
- **No named benefit.** "Make it faster" is the feature's claim about itself. Say what the user gets: hours back, leads requalified.

### 4.2 The template

> **[Specific observable fact with a number] → [what the feature does about it] → [one-tap try] [equal-weight decline]**

Your example, rewritten:

> **"You've reviewed 23 dead leads by hand this week."**
> Agentic mode can requalify and follow up on them automatically — you approve anything it wants to send.
> [Try agentic mode] [Not now] [Don't suggest this again]

Note "you approve anything it wants to send" — the nudge for MORE automation must lean on the glass box. Trust is what you're selling; the upsell should point at the transparency layer, not away from it.

### 4.3 Starter nudge catalog

| ID | Trigger (must be measurable in-product) | Copy | CTA |
|---|---|---|---|
| `dead-leads-agentic` | ≥15 manual dead-lead reviews in 7 days | "You've reviewed {n} dead leads by hand this week. Agentic mode can requalify and follow up automatically — you approve every message." | Try agentic mode |
| `missed-after-hours` | ≥5 missed calls outside business hours in 14 days | "{n} calls came in after hours this month. Your receptionist can answer 24/7 on your current plan — turn on after-hours answering?" | Turn it on |
| `sms-followup` | ≥10 calls ended without booking, SMS follow-up off | "{n} callers didn't book this week. Automatic follow-up texts recover some of these — every text goes to your review queue first." | Enable follow-ups |
| `credits-low` | Credits < projected 7-day usage | "At this week's pace you'll run out of credits in {d} days. Top up now to avoid your receptionist pausing." | Top up |
| `approve-streak` | 50 consecutive approvals, zero edits, on one action type | "You've approved the last 50 {type} without changes. Want Gradia to handle these automatically? You can review them anytime in Activity." | Automate these |

`credits-low` isn't an upsell — it's fail-closed billing protection and it outranks every other nudge. `approve-streak` is the best money-maker in the list: it's earned automation, backed by the user's own visible track record.

### 4.4 Guardrails (non-negotiable, build into the nudge engine)

1. **One nudge visible at a time, max 2/week, ≥24h apart.** (Industry caps: 1–2 in-app messages per session; showing four trains users to dismiss everything unread.)
2. **"Not now" = 30-day snooze for that nudge. "Don't suggest this again" = permanent, stored server-side.** Repeated prompts with no permanent decline is "nagging" — a named deceptive pattern the FTC has litigated (Amazon Prime, 2023).
3. **Equal visual weight on decline.** No bright-accent Accept next to pale-gray decline (FTC "false hierarchy").
4. **Triggers reference only in-product behavior the user can see and verify.** Never inferred traits, never data from outside Gradia.
5. **Placement: inline card in the relevant context** (dead-leads nudge appears in the leads view, not as a modal over the dashboard). Never modal, never blocking, never on the review queue — that surface is for trust, not sales.
6. **Every nudge event logged** (shown/dismissed/converted) so weak nudges get killed with data.

### 4.5 What we never do

No countdown timers on offers. No fake scarcity. No guilt-copy declines. No nudges in the first 7 days (let the product earn trust first). No nudge for a feature the user's plan can't actually access without a sales call.

## 5. Sources

Grammarly/Loom/Notion usage-triggered upsell patterns (ProductGrowth, Userpilot, Monetizely) · frequency caps (Knock, Braze, CleverTap) · nagging/confirmshaming/false-hierarchy definitions (deceptive.design; FTC "Bringing Dark Patterns to Light" 2022; FTC v. Amazon 2023) · personalization-creepiness research (Greenbook declared-data paradox; perceived-surveillance studies, Intl. J. HCI 2026). Note: microcopy-level rules in §4.1–4.2 are informed synthesis from this literature, not a citable standard.

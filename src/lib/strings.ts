/**
 * Gradia UI chrome copy — one voice, one module (GRADIA-LANGUAGE-PACK).
 *
 * SCOPE (spec §8-A3, narrator vs character): these strings are the
 * NARRATOR — the UI chrome describing the agent in third person
 * ("your receptionist", "Gradia"). Anything the agent itself authors
 * (chat bubbles, outbound message previews, transcripts) is the
 * CHARACTER and speaks its eval-locked we/us voice from persona.ts —
 * never sourced from here.
 *
 * Voice rules (Language Pack §1):
 *  1. Numbers over adjectives — "Handled 12 calls", never "Great day!"
 *  2. Plain English, zero jargon — "caller", not "inbound contact".
 *  3. Report, don't perform — no exclamation marks (one exception:
 *     first-ever success moments), no emoji.
 *  4. Own errors in active voice — "We couldn't send that message."
 *  5. Every state says what to do next. No dead ends.
 *  6. The agent is "your receptionist" or "Gradia" — never "the AI"
 *     (exception: the disclosure setting, where AI-ness is the point).
 *
 * Screens migrate their chrome copy here as they're touched (Layer 1+).
 * No new hardcoded UI copy in components — same rule as no raw hex.
 */

export const STRINGS = {
  /** Buttons: verb + object, 1–3 words. Declines get equal weight —
   *  never confirmshame. */
  actions: {
    saveChanges: "Save changes",
    addNumber: "Add number",
    addLead: "Add lead",
    approve: "Approve",
    editAndApprove: "Edit & approve",
    dismiss: "Dismiss",
    tryIt: "Try it",
    notNow: "Not now",
    dontSuggestAgain: "Don't suggest this again",
    undo: "Undo",
    retry: "Retry",
    sendNow: "Send now",
    cancel: "Cancel",
    clearFilters: "Clear filters",
    setUpForwarding: "Set up forwarding",
    fixHours: "Fix hours",
    topUp: "Top up",
  },

  /** Empty states teach, never blank (Language Pack §2). Distinguish
   *  first-use vs no-results vs all-done. */
  empty: {
    conversationsFirstUse:
      "No calls yet. Forward your number and your receptionist starts answering.",
    conversationsNoResults: "Nothing matches those filters.",
    reviewQueueEmpty:
      "Nothing needs you right now. Gradia will flag anything it's unsure about.",
    customersFirstUse:
      "Customers appear here automatically after their first call or text.",
    activityFirstUse:
      "Everything your receptionist does shows up here — calls answered, texts staged, bookings proposed.",
    approvalsEmpty:
      "Nothing waiting on you. Anything your receptionist wants to send lands here first.",
  },

  /** Toasts: past-tense fact + undo where reversible. */
  toasts: {
    greetingUpdated: "Greeting updated",
    numberAdded: "Number added",
    saved: "Saved",
    couldntSave:
      "Couldn't save — check your connection. Your edits are still here.",
  },

  /** Confidence & review — three levels ONLY, never percentages
   *  (Language Pack §3 / spec §5.4). Silent = handled, logs normally. */
  review: {
    reviewThis: "Review this",
    needsYou: "Needs you",
  },

  /** Shared chrome labels (narrator voice — replaces we/us chrome). */
  chrome: {
    waitingOnReceptionist: "Waiting on your receptionist",
    waitingOnYou: "Waiting on you",
    handledByReceptionist: "Handled by your receptionist",
    handledByYou: "Handled by you",
    yourReceptionist: "Your receptionist",
  },

  /** Error pattern: what happened + what we did + what you can do.
   *  Compose per-surface; this is the canonical example shape. */
  errors: {
    sendFailedPattern: (to: string) =>
      `The follow-up text to ${to} didn't send. We'll retry twice over the next 10 minutes.`,
  },
} as const

export type Strings = typeof STRINGS

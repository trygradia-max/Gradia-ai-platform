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
    approvalSent: "Sent — it's on its way.",
    approvalDropped: "Dropped. Nothing went out.",
    approvalRestored: "Restored to the queue.",
    alreadyDecided: "Already decided.",
    decisionFailed:
      "That didn't go through — check your connection. The card is back in the queue.",
  },

  /** Confidence & review — three levels ONLY, never percentages
   *  (Language Pack §3 / spec §5.4). Silent = handled, logs normally. */
  review: {
    reviewThis: "Review this",
    needsYou: "Needs you",
  },

  /** Schedule conflicts (P0-004). Warnings are icon + text, never color
   *  alone; overrides always ask for a reason — it's recorded. */
  conflicts: {
    warningTitle: "Schedule conflict",
    advisoryTitle: "Worth a look",
    unverified:
      "Availability couldn't be verified — Gradia's schedule check didn't complete. Approving re-checks first; nothing books until the schedule can be verified.",
    bookAnyway: "Book it anyway",
    moveAnyway: "Move it anyway",
    blockAnyway: "Block it anyway",
    overrideReasonLabel: "Reason (recorded with the override)",
    overrideReasonPlaceholder: "Why book over this?",
    overrideReasonRequired:
      "Give a short reason — it's recorded with the override.",
    overrideRecorded: "Booked — the override is recorded.",
    keepSlot: "Keep the slot",
    refusedAutomatic:
      "Held back — that slot is already taken. The card is waiting in Approvals.",
  },

  /** Shared chrome labels (narrator voice — replaces we/us chrome). */
  chrome: {
    waitingOnReceptionist: "Waiting on your receptionist",
    waitingOnYou: "Waiting on you",
    handledByReceptionist: "Handled by your receptionist",
    handledByYou: "Handled by you",
    yourReceptionist: "Your receptionist",
    receptionistReplied: "Receptionist replied",
    callerSpokeLast: "Caller spoke last",
    unknownCaller: "Unknown caller",
    noCallsYetTitle: "No calls yet.",
    nothingLoggedTitle: "Nothing logged yet.",
  },

  /** Page-level chrome for the A4 shell. */
  pages: {
    home: {
      receiptEyebrow: "This week",
      receiptTitle: "What your receptionist got done",
      receiptSubtitle:
        "A running receipt of the work caught and handled for you — counted conservatively, traced to your own records.",
      kpisEyebrow: "Today",
      kpiCalls: "Calls handled",
      kpiLeads: "Leads captured",
      kpiBooked: "Appointments booked",
      kpiNeedsReview: "Needs your review",
      bookedEyebrow: "On the books",
      bookedTitle: "Today's appointments",
      bookedEmpty: "Nothing on the books today.",
      bookedViewAll: "Full schedule",
      activityEyebrow: "Recent activity",
      activityTitle: "What just happened",
      activityViewAll: "See all activity",
    },
    approvals: {
      eyebrow: "Approvals",
      titleAllClear: "All clear",
      titleWaiting: "Waiting on you",
      subtitleEmpty:
        "Nothing needs your eyes right now — anything that does lands here the moment it's staged.",
      subtitleWaiting: (pending: number, edits: number) =>
        `A quick yes or no before anything leaves the shop — ${pending} pending${
          edits > 0 ? ` · ${edits} need a tweak` : ""
        }.`,
    },
    welcome: {
      title: "Welcome to Gradia",
      body: "Your receptionist answers calls, texts, and emails — every inquiry becomes a drafted reply waiting in Approvals. Connect the channels below and it starts catching leads.",
      setUpLater: "I'll set up later",
      startConnecting: "Start connecting",
      progress: (live: number, total: number) =>
        `${live} of ${total} live — this card gets out of your way once you're going.`,
    },
    activity: {
      eyebrow: "Activity",
      title: "Everything your receptionist did",
      subtitle:
        "Calls answered, texts staged, bookings proposed — routine wins log quietly, anything unsure gets flagged.",
      filters: { needsReview: "Needs review", handled: "Handled", escalated: "Escalated", all: "All" },
      escalatedUnavailable:
        "Escalation tracking arrives with call transfers — nothing to filter yet.",
      whyLabel: "Why",
      outcome: { handled: "Handled", needsYou: "Needs you", dropped: "Dropped" },
      viewCall: "View call",
    },
    call: {
      eyebrow: "Call record",
      titleFallback: "Call",
      summaryHeading: "Summary",
      transcriptHeading: "Transcript",
      actionsHeading: "From this call",
      recordingHeading: "Recording",
      noSummary:
        "No summary was captured for this call — the full transcript below is the record.",
      backToActivity: "Back to Activity",
      caller: "Caller",
      receptionist: "Receptionist",
    },
    conversations: {
      eyebrow: "Conversations",
      title: "Calls, texts, and questions",
      subtitle:
        "Customer threads on one side, straight answers about the shop on the other.",
      threadsHeading: "Threads",
      /** Honest interim copy while the thread list ships (L4): shown
       *  when the shop already HAS call/text history. */
      threadsInterim:
        "Call and text threads land here next. Until then, every conversation lives on the customer's file.",
      threadsInterimCta: "View customers",
      askHeading: "Ask Gradia",
    },
    receptionist: {
      eyebrow: "Receptionist",
      title: "What your receptionist runs",
      subtitle:
        "Answering, follow-ups, reminders — each one shows its status and stages everything for your approval.",
    },
  },

  /** Error pattern: what happened + what we did + what you can do.
   *  Compose per-surface; this is the canonical example shape. */
  errors: {
    sendFailedPattern: (to: string) =>
      `The follow-up text to ${to} didn't send. We'll retry twice over the next 10 minutes.`,
    /** Dashboard route error boundary (P0-010) — honest, no invented excuse. */
    dashboardTitle: "This page hit an error on our side.",
    dashboardBody:
      "Your data is safe — the page just failed to load. Trying again usually fixes it; the error report is already with us.",
    dashboardRetry: "Try again",
    dashboardHome: "Back to Home",
    /** Dashboard not-found (P0-010) — stale links after the IA consolidation. */
    notFoundTitle: "That page isn't in the dashboard.",
    notFoundBody:
      "The link may be old — a few pages moved when the dashboard was reorganized. Everything still exists; start from Home.",
    notFoundHome: "Go to Home",
  },

  /** Connection truth (UX-001). Three tile states — Connected / Connect /
   *  NOT AVAILABLE. The unavailable line names what is missing in owner terms:
   *  never an env var, never a vendor, never "coming soon" for something that
   *  is a server setting rather than a roadmap item. */
  connections: {
    connected: "Connected",
    notAvailable: "Not available yet",
    connect: "Connect",
    manage: "Manage",
    notAvailableReason: {
      email:
        "Email isn't set up for this workspace yet — we're finishing the connection on our side.",
      calendar:
        "Calendar comes with email, which isn't set up for this workspace yet.",
      sms:
        "Texting isn't set up for this workspace yet — we're finishing the connection on our side.",
      voice:
        "Voice isn't set up for this workspace yet — we're finishing the connection on our side.",
      crm:
        "The Jobber connection isn't set up for this workspace yet — we're finishing it on our side.",
      payments:
        "Payments aren't set up for this workspace yet — we're finishing the connection on our side.",
    },
    /** Shown in place of an identity when connected but the provider returned
     *  no display value (the founder repro shape) — truth stays "Connected". */
    identityFallback: {
      email: "Gmail",
      calendar: "Google Calendar",
      sms: "Business number",
      crm: "Jobber",
    },
  },

  /** Inline help (UX-001; reference board ADOPT §3). One or two narrator
   *  sentences per card, approval type, and builder field: what it does and
   *  what happens when you act. Numbers over adjectives, no vendor names. */
  help: {
    settings: {
      voice:
        "Answers your calls with your greeting, hours and prices. Any booking it takes waits for your approval.",
      email:
        "Reads new emails to your connected inbox and drafts a reply for each one. Nothing sends until you approve it.",
      sms:
        "Catches texts to your business number and drafts a reply. You approve before anything goes out.",
      calendar:
        "Approved bookings land on this calendar. Connecting email connects the calendar with it.",
      crm:
        "Pushes approved leads and bookings into Jobber so it stays your system of record.",
      services:
        "Your menu is the one price list. Phone quotes, text drafts and the quote builder all read from it.",
      hours:
        "Sets when a day counts as full on the Calendar and what your receptionist says about opening hours.",
      automations:
        "Follow-ups that run on a schedule. In approval mode each one stages a draft for you first.",
      knowledge:
        "Facts your receptionist can use when answering: policies, FAQs, what makes the shop different.",
      reviews:
        "The link customers get when your receptionist asks for a review after a finished job.",
      usage:
        "What this month's plan covers and how much of it is used, counted in texts and calls.",
      developer:
        "Tokens that let outside tools read this workspace through Gradia. Only create one if you asked for it.",
      autonomy:
        "The default for how much your receptionist acts on its own. Bookings and money always wait for you.",
      shadow:
        "Reads and drafts as usual but sends nothing. Use it while you set up.",
      demoData:
        "Removes the sample records added for demos. Real customers and history are untouched.",
      carrier:
        "US carriers verify every business that texts. Until they approve, calls work and texting waits.",
    },
    approvals: {
      create_lead:
        "Approve saves this person as a lead in Customers. Nothing is sent to them.",
      add_note:
        "Approve saves this note on the customer's file. Nothing is sent.",
      book_appointment:
        "Approve puts this on your calendar and marks the lead booked.",
      reschedule_appointment:
        "Approve moves the booking to the new time on your calendar.",
      cancel_appointment: "Approve removes the booking from your calendar.",
      send_sms:
        "Approve sends this text from your business number, exactly as shown. Tweak it to change the wording first.",
      send_email:
        "Approve sends this email from your connected inbox, exactly as shown.",
      create_quote:
        "Approve creates a draft quote you can review and send. Nothing goes to the customer yet.",
    },
    builder: {
      greeting:
        "The first sentence callers hear. Keep it short; your receptionist adds the rest.",
      voice:
        "How your receptionist sounds on the phone. Use the test call to hear it.",
      tone: "How formal the wording is. It changes phrasing, not what it can do.",
      hours:
        "Said to callers who ask when you're open, and used to decide when it's after hours.",
      afterHours:
        "What happens on calls outside your hours: take a message, or just say when you reopen.",
      bookings:
        "Collect the request and stage it for your approval, or text callers a booking link instead.",
      bookingLink:
        "The link texted to callers when bookings go through your own scheduler.",
      escalation:
        "A number to transfer to when a caller asks for a person. Optional.",
      goingLive:
        "Three steps before calls are answered: save it, connect a number, hear it once yourself.",
      budget:
        "A monthly cap on answered minutes. At the cap your receptionist takes messages instead.",
    },
  },

  /** Public quote page (/q/[token]) — P0-009. The expired state is the
   *  MINIMAL honest one; a richer re-quote CTA awaits decision Q-04. */
  quotePublic: {
    validThrough: (date: string) => `Good through ${date}.`,
    expiredNotice: (date: string) =>
      `This quote expired on ${date}. Reach out and we'll price it fresh.`,
    /** Server refusal when a response arrives past valid_until (covers the
     *  page-open-before-expiry, submit-after case). */
    expiredRefusal: "This quote has expired — reach out and we'll price it fresh.",
    invalidLink: "This quote link isn't valid.",
    alreadyDecided: "This quote can't be responded to anymore.",
    rateLimited: "Too many tries — wait a minute and try again.",
    saveFailed: "We couldn't save your response. Try again.",
  },
} as const

export type Strings = typeof STRINGS

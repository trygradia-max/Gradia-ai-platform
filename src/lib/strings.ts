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
  communicationPurpose: {
    guidance: "Held or edited message? Save and review its purpose before approving. Replies require a verified customer message within 48 hours.",
    marketing: "Review as marketing",
    reply: "Verify recent reply",
    reviewed: "Purpose reviewed. Consent checks still apply when you approve.",
  },
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
    conversationsFirstUseTitle: "Your customer conversations will appear here.",
    conversationsFirstUse:
      "Texts, emails, and calls from customers land here after they write in.",
    conversationsPageEmpty: "No visible conversations on this page.",
    conversationsChoose: "Choose a conversation",
    conversationsChooseBody:
      "The list stays on the left. Opening a thread does not send, mark it read, or grant consent.",
    conversationsNoResults: "Nothing matches those filters.",
    reviewQueueEmpty:
      "Nothing needs you right now. Gradia will flag anything it's unsure about.",
    customersFirstUseTitle: "Your customers will appear here.",
    customersFirstUse:
      "People land here after a text, form, or call — or you can import them.",
    activityFirstUse:
      "Calls, drafts, and bookings show up here as they happen.",
    approvalsEmpty:
      "Nothing waiting on you. Drafts that need a yes land here first.",
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

  /** Who a voice proposal is about — read from the staged caller-identity
   *  evidence, never inferred. Icon + text; honest about legacy cards. */
  callerIdentity: {
    verified: (phone: string) =>
      `Caller ID verified: ${phone}. Staged for the number that called, not a number the caller read out.`,
    edited: (callerId: string, current: string) =>
      `Phone edited since the call: the card now says ${current}, but the call came from ${callerId}. Check who this is before approving.`,
    unrecorded:
      "This call's caller ID wasn't recorded with the proposal. Confirm who this is before approving.",
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
      /** Real count. Approvals are drafted customer messages unless noted. */
      repliesNeedReview: (count: number) =>
        count === 1
          ? "1 reply needs your review."
          : `${count} replies need your review.`,
      nothingNeedsReview: "Nothing needs your review.",
      channelsConnected: (live: number, total: number) =>
        `${live} of ${total} channels connected`,
      bookedEyebrow: "On the books",
      bookedTitle: "Today's appointments",
      bookedEmpty: "Nothing on the books today.",
      bookedViewAll: "Full schedule",
      activityEyebrow: "Recent activity",
      activityTitle: "What just happened",
      activityViewAll: "See all activity",
      /** PERF-001: Home shows the newest few leads and links to the rest. */
      leadFeedSeeAll: (total: number) => `See all ${total} in Customers`,
    },
    customers: {
      /** PERF-001: a pipeline column past its cap says how many older cards
       *  it is not drawing — the count is real, the rows are one search away. */
      pipelineOlder: (n: number) => `${n} older — search in Customers`,
    },
    approvals: {
      eyebrow: "Approvals",
      titleAllClear: "Nothing needs your review",
      titleWaiting: "Waiting on you",
      subtitleEmpty:
        "Nothing needs your eyes right now — anything that does lands here the moment it's staged.",
      subtitleWaiting: (pending: number, edits: number) =>
        `A quick yes or no before anything leaves the shop — ${pending} pending${
          edits > 0 ? ` · ${edits} need a tweak` : ""
        }.`,
      /** PERF-001: the queue draws a page at a time; the count is exact. */
      showMore: (n: number) => `Show ${n} more`,
    },
    operationsBrief: {
      eyebrow: "Operations brief",
      title: "Work that needs a decision",
      subhead:
        "A read-only view of permitted work. Open the source record to review it.",
      observedLabel: "Observed",
      observedUnknown: "time unavailable",
      unavailableTitle: "Work status could not be verified.",
      unavailableBody:
        "Nothing is assumed clear. Refresh the page before acting on this view.",
      emptyTitle: "No permitted work is waiting in this view.",
      emptyBody:
        "This view was checked successfully. New work will appear after its source record is ready for review.",
      loadedWindowNote:
        "Counts describe this loaded window, not all work for the business.",
      needsReviewCount: "Needs review in this loaded window",
      unconfirmedCount: "Outcome unconfirmed in this loaded window",
      partialStatus: "Partial view",
      partialBody: "More permitted work exists beyond this view.",
      needsReviewSection: "Needs review",
      unconfirmedSection: "Outcome unconfirmed",
      itemEyebrow: "Source work",
      needsReviewTitle: "A source record needs review",
      unconfirmedTitle: "A source outcome needs evidence review",
      needsReviewStatus: "Needs review",
      unconfirmedStatus: "Outcome unconfirmed",
      itemObserved: "Observed",
      sources: {
        intake: "Review intake evidence",
        deliveryEvidence: "Open outcome evidence",
        actions: {
          update_customer: "Review customer update",
          resolve_customer: "Review customer match",
          record_interaction: "Review interaction",
          create_lead: "Review lead",
          add_note: "Review note",
          book_appointment: "Review booking",
          reschedule_appointment: "Review reschedule",
          cancel_appointment: "Review cancellation",
          send_sms: "Review text message",
          send_email: "Review email",
          create_quote: "Review quote",
        },
      },
    },
    welcome: {
      title: "Welcome to Gradia",
      named: (shopName: string) => `Welcome to Gradia, ${shopName}.`,
      hint: "You can continue whenever you're ready.",
      continue: "Continue",
      body: "Your dashboard is ready. Channels still need their own setup, and nothing sends until you approve it.",
      setUpLater: "I'll set up later",
      startConnecting: "Open Settings",
      progress: (live: number, total: number) =>
        `${live} of ${total} connected — setup is still yours to finish.`,
    },
    onboarding: {
      eyebrowStart: "A short setup",
      eyebrowResume: "Pick up where you left off",
      eyebrowFresh: "Add another business",
      headlineStart: "Your business, then what you'd like help with first.",
      headlineFresh: "Another business, same setup.",
      body: "Four short steps. You can leave and come back — your place is saved. Services and hours stay in Settings.",
      stepStatus: (current: number, total: number) => `Step ${current} of ${total}`,
      steps: {
        business: "Your business",
        startingPoint: "Starting point",
        number: "Your number",
        help: "Your help",
      },
      helpTitle: "What would you like help with first?",
      businessBlurb:
        "Name, place, and what you do. You can change this later in Settings.",
      saveAndContinue: "Save and continue",
      numberBlurb:
        "This is the number customers call and text. Carriers must approve texting. Calls can work before that approval.",
      skipNumber: "Skip number for now",
      continueToHelp: "Continue to help",
      helpBlurb:
        "Start with drafted replies, or add phone help later. Nothing sends until you approve it.",
      finish: "Finish setup",
      quoteNote:
        "Before Gradia can quote or book, add your services and working hours in Settings. Finishing setup does not activate a channel.",
      phoneOptionalTitle: "Phone help is optional.",
      phoneOptionalBody:
        "Phone answering is an optional +$29/month add-on. Review the plan and setup before turning it on.",
    },
    startingPoint: {
      eyebrow: "Starting point",
      title: "Where your shop starts today",
      intro:
        "Gradia is the AI operations system for automotive service businesses. This short assessment establishes where your shop starts, so Gradia can measure operational change honestly over time.",
      effort: "About five minutes. “I’m not sure” is always a fine answer. Gradia keeps it as unknown and never turns it into a number.",
      notAScore:
        "It is a record, not a grade or a promise. Gradia will only compare against it when a later measurement covers a comparable period and uses the same definition.",
      notAsked: "Gradia does not ask for revenue, payroll, customer lists or passwords.",
      periodNote:
        "Answer for a normal period over about the last three months. Estimates are fine. Gradia labels them as your estimates.",
      saveNote: "Your answers are saved to your workspace each time you continue, so you can leave and come back.",
      start: "Start",
      resume: "Continue where you left off",
      introDraft: "Answers you saved earlier are waiting. Pick up where you left off.",
      saveDraftForOwner: "Save draft for the owner",
      back: "Back",
      next: "Save and continue",
      review: "Review answers",
      saveLater: "Save and finish later",
      skip: "Skip for now",
      skipNote: "You can do this later from Settings or Home. Nothing else in setup depends on it.",
      continueSetup: "Continue setup",
      stepOf: (n: number, total: number) => `Page ${n} of ${total}`,
      answered: (done: number, total: number) => `${done} of ${total} questions answered`,
      notSure: "I’m not sure",
      notSureHint: "Saved as unknown. Gradia will not guess.",
      rangeToggle: "It varies. Give a range",
      singleToggle: "Give one number",
      rangeFrom: "From",
      rangeTo: "To",
      mixTotal: (total: number) => `Total so far: ${total}%`,
      mixTotalOk: "Total: 100%",
      noteCount: (n: number, max: number) => `${n} of ${max} characters`,
      optional: "Optional",
      required: "Needs an answer",
      errorSummary: (n: number) => (n === 1 ? "1 answer needs attention" : `${n} answers need attention`),
      goTo: "Go to this question",
      saving: "Saving…",
      savedAt: (time: string) => `Saved to your workspace at ${time}`,
      unsaved: "Not saved yet. Changes are only on this screen.",
      saveFailed: "We couldn’t save your answers. Nothing was lost on this screen. Try again.",
      conflictTitle: "This starting point changed somewhere else",
      conflictBody:
        "Another browser, or a teammate’s draft, saved a newer version. Reload to see it. Answers you have not saved on this screen will be replaced.",
      conflictAction: "Reload the latest",
      reviewTitle: "Review your starting point",
      reviewBlurb: "Check each answer. Anything left blank is not counted as zero and not counted as unknown.",
      reviewEdit: "Change",
      reviewBlank: "Needs an answer",
      reviewMissing: (n: number) => (n === 1 ? "1 question still needs an answer or “I’m not sure”." : `${n} questions still need an answer or “I’m not sure”.`),
      submit: "Save starting point",
      submitting: "Saving…",
      submitFirst: "This records your starting point as revision 1. Gradia uses it as the comparison point for your first pilot review.",
      submitRevision: (next: number, current: number) =>
        `This saves revision ${next}. Revision ${current} stays on file and nothing is overwritten. Revision ${next} becomes the one Gradia compares against.`,
      managerNote:
        "Only the shop owner can save the starting point. Your answers are saved as a draft for the owner to review and submit.",
      managerSaved: "Draft saved for the owner.",
      submitted: (revision: number) => `Starting point saved as revision ${revision}.`,
      reportEyebrow: "Starting point report",
      reportTitle: "Where your shop started",
      reportFacts: (revision: number, saved: string, version: string) => `Revision ${revision}, saved ${saved}. Question set ${version}.`,
      reportPeriod: (range: string) => `Your answers describe ${range}.`,
      replaces: (n: number) => `Replaces revision ${n}, which stays on file.`,
      ownerOnlyNote:
        "Every figure below is your own estimate or calculated from your answers. Gradia has not measured any of it yet. Connected and observed figures appear here, labelled, once Gradia has comparable evidence.",
      measuredNote: "Some figures below are measured. Each one shows its evidence label and the exact window it covers.",
      legendTitle: "What the labels mean",
      noComparison:
        "This report makes no claim about improvement, savings or revenue. A comparison appears only when a later measurement covers a comparable period and uses the same definition. Otherwise it says not comparable.",
      systemsTitle: "Tools and goals",
      goalPrimary: "Most important to improve",
      goalSecondary: "Also on your mind",
      goalNote: "Your note",
      update: "Update starting point",
      updateNote: "Updating saves a new revision. The earlier one stays on file.",
      howWorkedOut: "How this was worked out",
      draftBanner: "You have an unfinished update saved as a draft.",
      draftContinue: "Continue the draft",
      completedTitle: "Your starting point is saved",
      completedBody: (revision: number) => `Revision ${revision} is on file. You can review it or save an updated revision at any time.`,
      loadingLabel: "Loading your starting point",
      unavailableTitle: "We couldn’t load your starting point",
      unavailableBody: "This is not an empty result and nothing was changed. Try again in a moment.",
      retry: "Try again",
      forbiddenTitle: "You don’t have access to this",
      forbiddenBody:
        "Only the shop owner, or a manager the owner has delegated, can see the starting point. Ask the owner for access.",
      backHome: "Back to Home",
      homeNotStarted: "Set your starting point",
      homeNotStartedBody: "Five minutes, so Gradia can measure operational change against where you really start.",
      homeDraft: "Finish your starting point",
      homeDraftBody: "You have a saved draft. Pick it up where you left off.",
      homeReady: (revision: number) => `Starting point, revision ${revision}`,
      homeReadyBody: "Where your shop started, with the evidence behind each figure.",
      homeUnavailable: "Starting point status isn’t available right now",
      homeUnavailableBody: "Open it to try again.",
      open: "Open",
      settingsTitle: "Starting point",
      settingsBody: "Where your shop starts today, so Gradia can measure operational change honestly over time.",
      agentsNotice: "Before you set an agent’s goals, record where your shop starts today. Pilot reviews compare against it.",
      agentsNoticeCta: "Open your starting point",
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
      outcome: { handled: "Handled", needsYou: "Needs you", dropped: "Dropped", unresolved: "Not confirmed" },
      viewCall: "View call",
      reviewResult: "Review what happened",
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
        "Candidate facts stay inert until you review and publish an exact revision. Revoking a publication removes it from future Gradia retrieval.",
      reviews:
        "The link customers get when your receptionist asks for a review after a finished job.",
      queueForApproval:
        "Queues the reviewed question as a pending approval. Nothing sends from here — approval and send-time checks still apply.",

      websiteIntake:
        "Forms on your website send inquiries into intake review, from the exact origin you configure. Submissions are unverified text — not consent and not identity proof.",
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
      dataExport:
        "Downloads this shop's customers, vehicles, leads, appointments or conversations as CSV or JSON. Only this shop's rows — never another shop's.",
      carrier:
        "US carriers verify every business that texts. Until they approve, calls work and texting waits.",
    },
    approvals: {
      update_customer: "Approve applies the displayed record changes only if the reviewed record is still current.",
      resolve_customer: "Resolve one identity without merging records or granting consent.",
      record_interaction: "Save reported history without treating it as verified inbound evidence.",
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

  /** Voice test call (audit finding #6) — why a test call is or isn't available. */
  voiceTestCall: {
    needsVerifiedPhone:
      "Test calls only ring a phone you've verified on your own sign-in. No verified phone is on your account yet, so test calls are off.",
    needsVoiceAddon: "Turn on the Voice add-on in Billing to place a test call.",
    notReady: "Save the receptionist and connect your business number first.",
    stale: "Your receptionist has unsaved changes. Save it, then place the test call.",
    budgetExhausted: "This month's voice minutes are used up. Add minutes, then try again.",
    inProgress: "A test call is already ringing. Give it a minute.",
    tooSoon: "You just placed a test call. Wait a minute and try again.",
    rateLimited: "That's the limit for test calls right now. Try again later.",
    unavailable: "We couldn't check this just now, so no call was placed. Try again shortly.",
    placeFailed: "We couldn't place the test call. Try again.",
    ringing: "Ringing your verified phone now. Pick up and say hi.",
    callMe: "Call my verified phone",
    callingLabel: (masked: string) => `We call ${masked}, you meet the receptionist.`,
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

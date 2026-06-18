/**
 * Customer Recovery pre-filter (P8 / NEXT-3, GRADIA_CUSTOMER_RECOVERY_SPEC
 * §1.2). Runs in CODE before any LLM call — a cost AND accuracy filter that
 * keeps newsletters, no-reply/automated senders, and threads the shop never
 * touched from ever reaching the extraction worker. Also dedupes by Message-ID.
 *
 * Pure + deterministic so it's fully unit-tested without a model or DB.
 */

export type PrefilterInput = {
  /** RFC Message-ID of the thread's latest message (for dedupe). */
  messageId: string | null
  /** Sender address of the inbound message (the customer side). */
  fromEmail: string
  subject: string
  /** True when the message carried a List-Unsubscribe header (bulk/marketing). */
  hasListUnsubscribe: boolean
  /** True when the shop actually replied/participated — a human service thread. */
  ownerParticipated: boolean
}

export type PrefilterVerdict = { keep: true } | { keep: false; reason: string }

/**
 * Local-parts that signal an automated/non-human sender. Conservative on
 * purpose — we'd rather a borderline thread reach the worker (which scores it
 * low-confidence) than silently drop a real customer.
 */
const AUTOMATED_LOCALPART =
  /^(no-?reply|do-?not-?reply|donotreply|mailer-?daemon|postmaster|bounce[sd]?|notifications?|newsletters?|mailer|automated|alerts?|updates?|info|hello|support|billing|receipts?|noreply)$/i

/** Domains that are bulk/marketing infrastructure or obvious non-customers. */
const BULK_DOMAIN =
  /(^|\.)(mailchimp|mailchimpapp|sendgrid|sendgrid\.net|mailgun|constantcontact|hubspot|marketo|sparkpostmail|amazonses|salesforce|intercom|customeriomail)\./i

function localPart(email: string): string {
  const at = email.lastIndexOf("@")
  return at === -1 ? email : email.slice(0, at)
}

function domainPart(email: string): string {
  const at = email.lastIndexOf("@")
  return at === -1 ? "" : email.slice(at + 1)
}

/** Decide whether one thread is worth an LLM extraction call. */
export function classifyThreadForFilter(t: PrefilterInput): PrefilterVerdict {
  if (t.hasListUnsubscribe) {
    return { keep: false, reason: "bulk/marketing (List-Unsubscribe header)" }
  }
  if (!t.ownerParticipated) {
    return { keep: false, reason: "no shop participation in the thread" }
  }
  const from = t.fromEmail.trim().toLowerCase()
  if (!from || !from.includes("@")) {
    return { keep: false, reason: "no usable sender address" }
  }
  if (AUTOMATED_LOCALPART.test(localPart(from).trim())) {
    return { keep: false, reason: "automated/no-reply sender" }
  }
  if (BULK_DOMAIN.test(domainPart(from))) {
    return { keep: false, reason: "bulk email infrastructure domain" }
  }
  return { keep: true }
}

export type PrefilterResult<T extends PrefilterInput> = {
  kept: T[]
  dropped: { thread: T; reason: string }[]
}

/**
 * Filter a batch: drop non-customer/automated threads, then dedupe by
 * Message-ID (first occurrence wins; null/blank IDs are always kept, never
 * collapsed together). The kept set is what we pay the LLM to extract.
 */
export function prefilterThreads<T extends PrefilterInput>(
  threads: T[]
): PrefilterResult<T> {
  const kept: T[] = []
  const dropped: { thread: T; reason: string }[] = []
  const seenIds = new Set<string>()

  for (const thread of threads) {
    const verdict = classifyThreadForFilter(thread)
    if (!verdict.keep) {
      dropped.push({ thread, reason: verdict.reason })
      continue
    }
    const id = thread.messageId?.trim()
    if (id) {
      if (seenIds.has(id)) {
        dropped.push({ thread, reason: "duplicate Message-ID" })
        continue
      }
      seenIds.add(id)
    }
    kept.push(thread)
  }

  return { kept, dropped }
}

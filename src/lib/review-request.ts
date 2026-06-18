/**
 * Review-request drafters (NEXT-1). A first-class review ask, not generic
 * freeform: it carries the shop's real review link (appended deterministically)
 * and is written in the shop's voice.
 *
 * COMPLIANCE LOCK (FTC + Google/Yelp policy, baked in code not a prompt): the
 * ask is NEUTRAL and identical for every eligible customer. There is no
 * sentiment/rating input and no way to tailor or gate the ask by a customer's
 * past experience — you send to the whole eligible segment or not at all. The
 * locking test scans this module for any such gating path.
 */

import { draftCustomEmailForCustomer, type EmailDraft } from "@/lib/email-drafter"
import { draftCustomSmsForCustomer } from "@/lib/sms-drafter"
import { appendReviewLinkToEmail, appendReviewLinkToSms } from "@/lib/review-link"

// Intent copy is deliberately written WITHOUT any experience/quality wording so
// the model can't steer the ask toward only-happy-customers. The link is added
// by us afterward, so the drafter is told not to write a URL.
const SMS_INTENT =
  "Ask the customer to leave a quick public review of the shop. Keep it one short, warm, genuine sentence. Send the same neutral ask to everyone — do not tailor it to their past experience and do not include any link or URL (it is added automatically)."

const EMAIL_INTENT =
  "Invite the customer to leave a public review of the shop in a couple of warm sentences. Send the same neutral invitation to everyone — do not tailor it to their past experience and do not include any link or URL (it is added automatically)."

export async function draftReviewRequestSms(input: {
  shopName: string
  customerName: string
  reviewLink: string
  vehicle?: string | null
  knowledge?: string | null
}): Promise<string | null> {
  const body = await draftCustomSmsForCustomer({
    shopName: input.shopName,
    customerName: input.customerName,
    vehicle: input.vehicle ?? null,
    service: null,
    intent: SMS_INTENT,
    knowledge: input.knowledge ?? null,
  })
  if (!body) return null
  return appendReviewLinkToSms(body, input.reviewLink)
}

export async function draftReviewRequestEmail(input: {
  shopName: string
  customerName: string
  reviewLink: string
  knowledge?: string | null
}): Promise<EmailDraft | null> {
  const draft = await draftCustomEmailForCustomer({
    shopName: input.shopName,
    customerName: input.customerName,
    service: null,
    when: null,
    intent: EMAIL_INTENT,
    knowledge: input.knowledge ?? null,
  })
  if (!draft) return null
  return { subject: draft.subject, body: appendReviewLinkToEmail(draft.body, input.reviewLink) }
}

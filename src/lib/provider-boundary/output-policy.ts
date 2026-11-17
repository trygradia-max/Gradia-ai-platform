/**
 * Provider boundary — output policy.
 *
 * Model output is untrusted data validated against Gradia schemas. These checks
 * run AFTER schema validation and decide whether a structurally valid result may
 * be used at all. Nothing here repairs output: an unsafe result is held whole.
 *
 * What a model result can never carry (the route attaches these in code):
 * tenant, recipient address/number, channel, consent, service purpose, policy,
 * tool, execution authority. Text claims about price, booking or consent inside
 * a draft are checked against what the shop's own knowledge actually states.
 */

import { preflight, type HoldReason } from "./preflight"
import { countInvisible, normalizeForProposal } from "./text"

const URL_LIKE = /\b(?:https?:\/\/|ftp:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|co|app|dev|ru|cn|xyz|top|info|biz|ly|me|us)\b\/?/i
const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/
const PHONE_DIGITS = /\d(?:[\s().-]*\d){9,}/
const PLACEHOLDER = /\[(?:email|phone|link|id|secret|header removed)\]/i
const TOOLISH = /\b(?:tool_use|function_call|tool_call)\b|<\/?[a-z][^>]*>|```|\bsystem prompt\b/i

const BOOKING_CLAIM = [
  /\b(?:you(?:'re| are)|we(?:'ve| have)|you(?:'ve| have)|it(?:'s| is))\b[^.\n]{0,15}\b(?:all )?(?:booked|scheduled|confirmed|locked in|set for|reserved)\b/i,
  /\b(?:booking|appointment|reservation)\b[^.\n]{0,15}\b(?:is |has been |was )?(?:confirmed|booked|scheduled|set|approved)\b/i,
  /\bsee you (?:on |at |this |next |tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
  /\byour (?:spot|slot|time) is (?:held|reserved|yours)\b/i,
]
const CONSENT_CLAIM = [
  /\bopted[\s-]?in\b/i,
  /\b(?:you(?:'ve| have)|we have your)\b[^.\n]{0,12}\b(?:consent(?:ed)?|agreed|authori[sz]ed|opted)\b/i,
  /\bby (?:replying|texting|responding)\b[^.\n]{0,30}\b(?:you )?(?:agree|consent|opt)\b/i,
]

const DOLLAR_AMOUNT = /\$\s?\d[\d,]*(?:\.\d{1,2})?/g
const PERCENT_OFF = /\b\d{1,3}\s?%\s?off\b/gi
const FREE_CLAIM = /\b(?:free of charge|no charge|on the house|complimentary|for free|totally free)\b/gi

function amounts(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(DOLLAR_AMOUNT)) out.add(m[0].replace(/[\s,]/g, ""))
  return out
}

function phrases(text: string, re: RegExp): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(re)) out.add(m[0].toLowerCase().replace(/\s+/g, ""))
  return out
}

/** Common checks for any model-authored free text. Returns a hold reason or null. */
function commonTextProblem(text: string): HoldReason | null {
  if (URL_LIKE.test(text) || EMAIL.test(text) || PHONE_DIGITS.test(text)) return "unsafe_output"
  if (PLACEHOLDER.test(text) || TOOLISH.test(text)) return "unsafe_output"
  // Model text that itself reads like an instruction/override/secret request is not usable.
  if (preflight([{ field: "output", text, limit: 100_000 }]).verdict === "hold") return "unsafe_output"
  return null
}

export type ShortFieldSpec = { max: number; allowDigitsRun?: boolean }

/**
 * Validate and sanitize one short extracted field (name, vehicle, service,
 * summary). Returns the sanitized string, or null when the value is unsafe.
 * Single line, normalized at the proposal boundary.
 */
export function checkShortField(value: string, spec: ShortFieldSpec): string | null {
  if (value.length > spec.max * 2) return null // wildly over-long even before normalization
  const invisible = countInvisible(value)
  if (invisible.bidiOverrides > 0 || invisible.controls > 0) return null // smuggling shape in model output
  const clean = normalizeForProposal(value, spec.max, { singleLine: true })
  if (commonTextProblem(clean)) return null
  if (!spec.allowDigitsRun && /\d{5,}/.test(clean)) return null
  return clean
}

export type DraftCheckContext = {
  /** The (redacted) shop knowledge that was given to the model; the only source a price may come from. */
  knowledge: string
}

/**
 * Validate a drafted customer reply. A draft may not carry contact details or
 * links, placeholders, tool/markup text, claims of a booking or consent, or a
 * price / discount / free claim the shop knowledge does not itself state.
 */
export function checkDraftText(
  text: string,
  maxLength: number,
  ctx: DraftCheckContext,
  options: { singleLine?: boolean } = {},
): { ok: true; text: string } | { ok: false; reason: HoldReason } {
  const clean = normalizeForProposal(text, maxLength, { singleLine: options.singleLine })
  if (!clean) return { ok: false, reason: "malformed_output" }
  if (text.trim().length > maxLength * 2) return { ok: false, reason: "malformed_output" }
  const problem = commonTextProblem(clean)
  if (problem) return { ok: false, reason: problem }
  if (BOOKING_CLAIM.some((re) => re.test(clean)) || CONSENT_CLAIM.some((re) => re.test(clean))) {
    return { ok: false, reason: "unsafe_output" }
  }
  const knowledge = ctx.knowledge
  const allowedAmounts = amounts(knowledge)
  for (const a of amounts(clean)) if (!allowedAmounts.has(a)) return { ok: false, reason: "unsafe_output" }
  const allowedPercent = phrases(knowledge, PERCENT_OFF)
  for (const p of phrases(clean, PERCENT_OFF)) if (!allowedPercent.has(p)) return { ok: false, reason: "unsafe_output" }
  const allowedFree = phrases(knowledge, FREE_CLAIM)
  for (const p of phrases(clean, FREE_CLAIM)) if (!allowedFree.has(p)) return { ok: false, reason: "unsafe_output" }
  return { ok: true, text: clean }
}

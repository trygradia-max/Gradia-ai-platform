/**
 * Call Copilot content hygiene (PR E): payment-card and other sensitive redaction, plus a
 * deterministic classifier for text that tries to instruct Gradia.
 *
 * Transcript text is untrusted EVIDENCE, never instructions. These checks are belt and braces
 * around the structural defences (a closed proposal vocabulary, Gradia-owned mapping, no tool or
 * policy field anywhere in the extractor contract):
 *
 *   redactTranscriptText   removes card numbers (Luhn-checked, digits or spelled-out), card security
 *                          codes, national ids, bank account/routing numbers and spoken credentials
 *                          BEFORE a segment is stored. The database independently refuses a Luhn-valid
 *                          card number, so a bypass cannot persist one.
 *   containsSensitive      true when a proposed VALUE still carries any of the above.
 *   looksLikeInstruction   true for text addressed to an assistant or system rather than describing the
 *                          customer's request ("ignore previous instructions", "approve this", ...).
 *                          A proposal cited from such a span is refused, never staged.
 */

export type RedactionKind = "payment_card" | "national_id" | "bank_account" | "credential"
const MARK: Record<RedactionKind, string> = {
  payment_card: "[redacted: payment card]",
  national_id: "[redacted: national id]",
  bank_account: "[redacted: bank account]",
  credential: "[redacted: credential]",
}

export function luhnValid(raw: string): boolean {
  const d = raw.replace(/\D/g, "")
  if (d.length < 13 || d.length > 19) return false
  let total = 0
  let alt = false
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    total += n
    alt = !alt
  }
  return total % 10 === 0
}

const DIGIT_WORDS: Record<string, string> = {
  zero: "0", oh: "0", o: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
}
const DIGIT_WORD = "(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)"
const SPELLED_RUN = new RegExp(`\\b${DIGIT_WORD}(?:[\\s,.-]+${DIGIT_WORD}){12,18}\\b`, "gi")
/**
 * Card layouts only: 13-19 contiguous digits, 4-4-4-x, or 4-6-5 (spaces, dashes, dots or commas between groups).
 * Structural on purpose: a phone number followed by a zip code is a long run of digits too, and must never be
 * mistaken for (and removed as) a card just because its Luhn sum happens to work out.
 */
const DIGIT_RUN = /(?<![0-9A-Za-z])(?:\d{13,19}|\d{4}[ ,.-]{1,2}\d{4}[ ,.-]{1,2}\d{4}[ ,.-]{1,2}\d{1,7}|\d{4}[ ,.-]{1,2}\d{6}[ ,.-]{1,2}\d{4,5})(?![0-9A-Za-z])/g
const CARD_CODE = /\b(?:cvv2?|cvc2?|cid|security code|card verification(?: code| value)?)\b[^.\n]{0,24}?\b\d{3,4}\b/gi
const NATIONAL_ID = /\b\d{3}-\d{2}-\d{4}\b|\b(?:social security(?: number)?|ssn)\b[^.\n]{0,24}?\d[\d -]{6,}\d/gi
const BANK_ACCOUNT = /\b(?:routing|account|iban)\s*(?:number|no\.?|#)?\s*(?:is|:)?\s*\d[\d -]{5,}\d/gi
const CREDENTIAL = /\b(?:password|passcode|passphrase|pin(?: code| number)?|login code|one[- ]time code|verification code)\b\s*(?:is|was|:|=)\s*[^\s,.;]{3,}/gi

function spelledToDigits(run: string): string {
  return run
    .toLowerCase()
    .split(/[\s,.-]+/)
    .map((w) => DIGIT_WORDS[w] ?? "")
    .join("")
}

export function redactTranscriptText(input: string): { text: string; redactions: RedactionKind[] } {
  const kinds = new Set<RedactionKind>()
  let out = input
  out = out.replace(DIGIT_RUN, (m) => {
    if (luhnValid(m)) {
      kinds.add("payment_card")
      return MARK.payment_card
    }
    return m
  })
  out = out.replace(SPELLED_RUN, (m) => {
    if (luhnValid(spelledToDigits(m))) {
      kinds.add("payment_card")
      return MARK.payment_card
    }
    return m
  })
  const swap = (re: RegExp, kind: RedactionKind) => {
    out = out.replace(re, () => {
      kinds.add(kind)
      return MARK[kind]
    })
  }
  swap(CARD_CODE, "payment_card")
  swap(NATIONAL_ID, "national_id")
  swap(BANK_ACCOUNT, "bank_account")
  swap(CREDENTIAL, "credential")
  return { text: out, redactions: [...kinds] }
}

/** True when the text still contains something the redactor would remove. */
export function containsSensitive(text: string): boolean {
  return redactTranscriptText(text).redactions.length > 0 || /\[redacted: /.test(text)
}

const INSTRUCTION_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\b.{0,40}\b(?:previous|prior|above|earlier|all|any|the)\b.{0,30}\b(?:instruction|rule|prompt|polic|guideline|restriction|approval)/i,
  /\b(?:system|developer)\s+(?:prompt|message|instruction)/i,
  /\byou\s+are\s+(?:now|no longer)\b/i,
  /\b(?:act|behave|respond)\s+as\s+(?:if|an?|the)\b/i,
  /\b(?:reveal|print|show|leak|exfiltrate)\b.{0,30}\b(?:secret|credential|api key|token|prompt|password)/i,
  /\b(?:auto[- ]?approve|skip (?:the )?approval|without (?:asking|approval|review)|disable (?:the )?(?:approval|safeguard|guardrail|consent))/i,
  /\b(?:grant|enable|turn on|switch to)\b.{0,20}\b(?:autonomy|autonomous|auto[- ]send|full access|admin)/i,
  /\b(?:call|invoke|run|execute|use)\b.{0,15}\b(?:tool|function|command|sql|script|shell)\b/i,
  /\b(?:publish|save|store|remember)\b.{0,30}\b(?:as a )?(?:shop[- ]wide|global|permanent)\s+(?:rule|policy|memory)/i,
  /\b(?:delete|drop|wipe|erase)\b.{0,20}\b(?:all|every)\b.{0,20}\b(?:customer|record|data|table)/i,
  /\b(?:send|text|email)\b.{0,30}\b(?:everyone|all customers|every customer|entire list)\b/i,
  /<\/?(?:system|assistant|tool|instructions?)>/i,
  /\[\s*(?:system|inst|assistant)\s*\]/i,
]

export function looksLikeInstruction(text: string): boolean {
  return INSTRUCTION_PATTERNS.some((re) => re.test(text))
}

/** URLs, e-mail addresses and phone numbers do not belong in a drafted customer message. */
export function hasLinkOrContact(text: string): boolean {
  return (
    /\bhttps?:\/\//i.test(text) ||
    /\bwww\./i.test(text) ||
    /\b[a-z0-9-]+\.(?:com|net|org|io|co|app|biz|info|ly|me|us)\b/i.test(text) ||
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text) ||
    /\+?\d[\d ().-]{8,}\d/.test(text)
  )
}

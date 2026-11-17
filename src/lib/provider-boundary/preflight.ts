/**
 * Provider boundary — deterministic risk preflight.
 *
 * A small, finite, versioned rule set run on untrusted text BEFORE any model
 * call. It is not a classifier and makes no attempt to be complete: it holds
 * input that clearly tries to give instructions to the agent (role/tool/policy
 * override, secret exfiltration, alternate recipient, claimed consent / price /
 * booking authority) or that is shaped like smuggling (bidi overrides, control
 * characters, runs of invisible characters, oversized input). The structural
 * defenses — recipient, tenant, channel, consent, policy, price and booking
 * authority are chosen by code, never by model output — hold even when this
 * list misses a phrasing. A hold is not a rejection: raw evidence is kept and a
 * human reviews it; nothing is drafted, proposed, written to the CRM or sent.
 */

import { countInvisible, foldForScan, squashForScan } from "./text"

export const PREFLIGHT_RULESET_VERSION = "2026-11-16.1"

export const HOLD_REASONS = [
  "override_role",
  "override_policy",
  "tool_instruction",
  "secret_request",
  "alternate_recipient",
  "claimed_authority",
  "obfuscated_input",
  "oversized_input",
  "knowledge_flagged",
  "provider_failure",
  "provider_timeout",
  "malformed_output",
  "unsafe_output",
] as const
export type HoldReason = (typeof HOLD_REASONS)[number]

export type InboundChannel = "sms" | "email"

/** Raw-length ceilings. SMS: carrier maximum. Email: far above any real inquiry. */
export const INPUT_LIMITS = {
  sms: { body: 1_600 },
  email: { body: 50_000, subject: 300, displayName: 200 },
  knowledge: 12_000,
} as const

type Rule = { code: HoldReason; patterns: RegExp[]; squashed?: string[] }

const PHONE_OR_EMAIL = String.raw`(?:@|\b\d{3}[\s.\-)]*\d{3}[\s.\-]*\d{4}\b)`

/** Patterns run on the folded form: NFKC, invisible characters removed, look-alikes folded, lower-case, single line. */
const RULES: Rule[] = [
  {
    code: "override_role",
    patterns: [
      /\b(ignore|disregard|forget|override|bypass|discard|drop|skip)\b[^.\n]{0,40}\b(previous|prior|above|earlier|preceding|all|any|your|the|these|those|every)\b[^.\n]{0,30}\b(instructions?|prompts?|rules?|guidelines?|polic(?:y|ies)|directives?|constraints?|guardrails?|programming|training)\b/,
      /\b(you are now|you will now|from now on,? you|act as|pretend (?:to be|you are|that you)|role-?play as|simulate being|developer mode|debug mode|dan mode|jailbreak|do anything now)\b/,
      /\b(system|developer|assistant|admin(?:istrator)?)\s*(?:prompt|message|instruction|override|role)\b/,
      /\b(?:new|updated|revised|override) (?:instructions?|rules?|directives?)\s*:/,
      /(?:^|\n|\s)(?:system|assistant|developer)\s*:\s*\S/,
      /<\|?\/?(?:system|assistant|user|im_start|im_end|endoftext)\|?>|\[\/?inst\]|<<\/?sys>>|###\s*(?:instruction|system)\b/,
    ],
    squashed: ["ignorepreviousinstructions", "ignoreallpreviousinstructions", "ignoretheaboveinstructions", "disregardpreviousinstructions", "systemprompt", "youarenowdan", "developermode"],
  },
  {
    code: "override_policy",
    patterns: [
      /\b(approve|auto-?approve|skip|bypass|disable|turn off|waive|override|suppress)\b[^.\n]{0,30}\b(approval|approvals|review|human|policy|guardrails?|consent|checks?|verification|safeguards?|opt-?out|stop)\b/,
      /\bwithout\b[^.\n]{0,20}\b(approval|asking|review|confirmation|checking|the owner|a human)\b/,
      /\b(do not|don'?t|never)\b[^.\n]{0,15}\b(ask|wait for|require|need)\b[^.\n]{0,20}\b(approval|review|permission|the owner|a human)\b/,
    ],
    squashed: ["bypassapproval", "skipapproval", "disableguardrails"],
  },
  {
    code: "tool_instruction",
    patterns: [
      /\b(call|invoke|execute|trigger|fire)\b[^.\n]{0,25}\b(tool|function|api|endpoint|webhook|sql|shell|script)\b/,
      /\b(tool|function)_?(?:name|call|use|calls)\b|\bfunction_call\b|<tool_call>|\btool_use\b/,
      /\b(drop|delete|truncate)\s+(?:table|database|all (?:customers|records|data|leads|appointments))\b/,
      /\b(?:curl|wget)\s+https?:|\brm\s+-rf\b|\bsudo\s+\w/,
    ],
    squashed: ["calltheapi", "executethecommand"],
  },
  {
    code: "secret_request",
    patterns: [
      /\b(reveal|show|print|output|display|tell|give|send|share|repeat|leak|dump|expose|disclose|return|list|read|what(?:'s| is| are))\b[^.\n]{0,40}\b(api[\s_-]?keys?|secret[\s_-]?keys?|access[\s_-]?tokens?|auth(?:entication)?[\s_-]?tokens?|bearer|private[\s_-]?keys?|service[\s_-]?role|credentials?|passwords?|passphrase|env(?:ironment)?[\s_-]?var(?:iable)?s?|\.env|secrets?)\b/,
      /\b(reveal|show|print|output|display|tell|repeat|leak|dump|expose|disclose|return|what(?:'s| is| are))\b[^.\n]{0,30}\b(your|the|my)\b[^.\n]{0,15}\b(system |initial |original |hidden |secret |full )?(prompt|instructions|rules|guidelines|configuration|config)\b/,
      /\b(begin|start)\s+(?:your|the)\s+(?:reply|response|answer)\s+with\b/,
      /-----begin [a-z ]*private key-----|\bsk-ant-[a-z0-9_-]{10,}|\bsk_(?:live|test)_[a-z0-9]{8,}|\beyj[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.|\bakia[0-9a-z]{12,}/,
    ],
    squashed: ["revealthesystemprompt", "printyourinstructions", "showyoursystemprompt", "whatisyourapikey"],
  },
  {
    code: "alternate_recipient",
    patterns: [
      new RegExp(String.raw`\b(instead|rather than|not to|don'?t (?:send|reply|text|email)|do not (?:send|reply|text|email)|stop (?:sending|replying))\b[^.\n]{0,60}${PHONE_OR_EMAIL}`),
      new RegExp(String.raw`${PHONE_OR_EMAIL}[^.\n]{0,40}\binstead\b`),
      new RegExp(String.raw`\b(forward|bcc|cc|redirect|reroute|route|copy)\b[^.\n]{0,50}\b(to|all)\b[^.\n]{0,40}${PHONE_OR_EMAIL}`),
      new RegExp(String.raw`\b(send|forward|deliver|route|copy|cc)\b[^.\n]{0,25}\b(?:replies|responses|reply|messages|drafts|conversation|thread|everything|copies|copy|confirmations?|quotes?|invoices?)\b[^.\n]{0,25}\b(to|at)\b[^.\n]{0,25}${PHONE_OR_EMAIL}`),
      /^[ \t]*(?:bcc|reply-to)[ \t]*:/m,
      /\b(new|different|another|alternate|alternative|updated)\b[^.\n]{0,20}\b(recipient|address|number|destination|contact)\b[^.\n]{0,40}(?:@|\b\d{3}[\s.\-)]*\d{3}[\s.\-]*\d{4}\b)/,
    ],
  },
  {
    code: "claimed_authority",
    patterns: [
      /\b(mark|record|set|log|treat|consider|update|flag|register)\b[^.\n]{0,30}\b(?:as|to)\b[^.\n]{0,20}\b(consent(?:ed)?|opted[\s-]?in|approved|authori[sz]ed|confirmed|booked|paid|vip|free|verified)\b/,
      /\b(?:consent|opt[\s-]?in|authori[sz]ation)\b[^.\n]{0,15}\b(?:granted|given|on file|recorded|verified|confirmed|already)\b/,
      /\b(?:has|have|had)\b[^.\n]{0,10}\b(?:consented|opted[\s-]?in|authori[sz]ed everything)\b/,
      /\b(owner|manager|boss|management|admin)\b[^.\n]{0,25}\b(approved|authori[sz]ed|agreed|confirmed|promised|signed off)\b[^.\n]{0,40}(?:\$\s?\d|\bfree\b|\bno charge\b|\bdiscount\b|\bbooked\b|\bappointment\b)/,
      /\b(?:book|schedule|confirm|reserve|charge|bill|refund|quote)\b[^.\n]{0,30}\b(?:automatically|immediately and|without (?:approval|asking|review|confirmation))\b/,
      /\b(?:price|quote|total|cost|rate)\b[^.\n]{0,15}\b(?:is|=|should be|must be|will be)\b[^.\n]{0,10}\$\s?0(?:\.00)?\b/,
      /\b(?:tell|say|reply|respond|write|confirm)\b[^.\n]{0,20}\b(?:that|to (?:me|them|the customer))\b[^.\n]{0,30}\b(?:booked|confirmed|approved|free of charge|no charge|\$\s?\d+)/,
    ],
  },
]

export type PreflightFinding = { code: HoldReason; field: string }

export type PreflightResult =
  | { verdict: "clear"; rulesetVersion: string }
  | { verdict: "hold"; rulesetVersion: string; reasons: HoldReason[]; findings: PreflightFinding[] }

export type UntrustedField = {
  /** Stable label used for findings and tests; never logged with content. */
  field: string
  /** Raw text exactly as received. */
  text: string
  /** Raw-length ceiling for this field; longer input holds as oversized. */
  limit: number
}

function scanFolded(field: string, text: string): PreflightFinding[] {
  const findings: PreflightFinding[] = []
  const folded = foldForScan(text)
  const squashed = squashForScan(text)
  for (const rule of RULES) {
    const hit =
      rule.patterns.some((re) => re.test(folded)) ||
      (rule.squashed?.some((s) => squashed.includes(s)) ?? false)
    if (hit) findings.push({ code: rule.code, field })
  }
  return findings
}

/** True when the text carries smuggling-shaped characters (decided on RAW text). */
function looksObfuscated(text: string): boolean {
  const c = countInvisible(text)
  return c.bidiOverrides > 0 || c.controls > 0 || c.invisible >= 3
}

/**
 * Run the preflight over every untrusted field of one inbound message (body,
 * subject, display name) or one retrieved knowledge block. Any finding holds.
 */
export function preflight(fields: readonly UntrustedField[]): PreflightResult {
  const findings: PreflightFinding[] = []
  for (const f of fields) {
    const text = typeof f.text === "string" ? f.text : ""
    if (text.length > f.limit) {
      findings.push({ code: "oversized_input", field: f.field })
      continue // do not run pattern scans on unbounded input
    }
    if (looksObfuscated(text)) findings.push({ code: "obfuscated_input", field: f.field })
    findings.push(...scanFolded(f.field, text))
  }
  if (findings.length === 0) return { verdict: "clear", rulesetVersion: PREFLIGHT_RULESET_VERSION }
  const reasons = [...new Set(findings.map((x) => x.code))]
  return { verdict: "hold", rulesetVersion: PREFLIGHT_RULESET_VERSION, reasons, findings }
}

export type InboundMessage =
  | { channel: "sms"; body: string }
  | { channel: "email"; body: string; subject: string; displayName: string }

/** Preflight for one public inbound message (the fields a sender controls). */
export function preflightInbound(message: InboundMessage): PreflightResult {
  if (message.channel === "sms") {
    return preflight([{ field: "body", text: message.body, limit: INPUT_LIMITS.sms.body }])
  }
  return preflight([
    { field: "body", text: message.body, limit: INPUT_LIMITS.email.body },
    { field: "subject", text: message.subject, limit: INPUT_LIMITS.email.subject },
    { field: "display_name", text: message.displayName, limit: INPUT_LIMITS.email.displayName },
  ])
}

/** Retrieved shop knowledge is evidence, not instructions: scan it like inbound text. */
export function preflightKnowledge(knowledge: string): PreflightResult {
  return preflight([{ field: "knowledge", text: knowledge, limit: INPUT_LIMITS.knowledge }])
}

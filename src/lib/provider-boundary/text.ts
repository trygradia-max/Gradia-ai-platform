/**
 * Provider boundary — text primitives.
 *
 * Stored source evidence (interactions, intake envelopes) is NEVER passed through
 * these helpers: it stays byte-for-byte what the sender supplied. They run only
 * where text leaves the evidence store — when building a model request, when
 * scanning model output, and when building a proposal (pending action, draft,
 * customer name) from external text.
 */

/** Bidi embedding/override/isolate controls. A legitimate message never needs these. */
const BIDI_OVERRIDES = /[‪-‮⁦-⁩]/g
/** Bidi marks (LRM/RLM/ALM) — legitimate in RTL text, still stripped at the boundary. */
const BIDI_MARKS = /[؜‎‏]/g
/** Zero-width and invisible formatting characters (ZWJ is handled separately). */
const ZERO_WIDTH = /[​‌⁠-⁤﻿­᠎͏ᅟᅠㅤﾠ]/g
const ZWJ = /‍/g
/** C0/C1 controls except TAB, LF, CR. */
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g
/** Unicode tag characters (invisible ASCII smuggling) and variation selectors. */
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu
const VARIATION_SELECTORS = /[︀-️\u{E0100}-\u{E01EF}]/gu

export type InvisibleCounts = {
  bidiOverrides: number
  invisible: number
  controls: number
}

function count(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0
}

/** Counts smuggling-relevant characters in RAW text (before any normalization). */
export function countInvisible(text: string): InvisibleCounts {
  return {
    bidiOverrides: count(text, BIDI_OVERRIDES),
    invisible:
      count(text, BIDI_MARKS) +
      count(text, ZERO_WIDTH) +
      count(text, ZWJ) +
      count(text, TAG_CHARS),
    controls: count(text, CONTROLS),
  }
}

function stripInvisible(text: string): string {
  return text
    .replace(BIDI_OVERRIDES, "")
    .replace(BIDI_MARKS, "")
    .replace(ZERO_WIDTH, "")
    .replace(TAG_CHARS, "")
    .replace(VARIATION_SELECTORS, "")
    .replace(ZWJ, "")
    .replace(CONTROLS, "")
}

/** Small closed set of look-alike letters that survive NFKC (Cyrillic/Greek → Latin). */
const CONFUSABLES: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", х: "x", у: "y", і: "i", ј: "j", ѕ: "s",
  ԁ: "d", һ: "h", ӏ: "l", ԛ: "q", ԝ: "w",
  α: "a", ε: "e", ι: "i", ο: "o", ρ: "p", υ: "u", ν: "v", κ: "k", τ: "t", χ: "x",
}

function foldConfusables(text: string): string {
  let out = ""
  for (const ch of text) out += CONFUSABLES[ch] ?? ch
  return out
}

export type NormalizeOptions = {
  /** Collapse every newline to a space (single-line fields: names, subjects, SMS drafts). */
  singleLine?: boolean
}

/**
 * Proposal-boundary normalization: NFKC, drop control/bidi/zero-width/tag
 * characters, unify newlines, collapse runs of blanks, trim, and cap length.
 * Returns "" for non-string input.
 */
export function normalizeForProposal(
  text: unknown,
  maxLength: number,
  options: NormalizeOptions = {},
): string {
  if (typeof text !== "string") return ""
  let t = stripInvisible(text.normalize("NFKC"))
  t = t.replace(/\r\n?/g, "\n")
  t = options.singleLine
    ? t.replace(/\s+/g, " ")
    : t.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n")
  t = t.trim()
  if (t.length > maxLength) t = t.slice(0, maxLength).trimEnd()
  return t
}

/**
 * Detection form: normalized, look-alikes folded, lower-cased, newlines kept as
 * spaces. Used ONLY for scanning; never stored, never sent to a model.
 */
export function foldForScan(text: string): string {
  return foldConfusables(normalizeForProposal(text, Number.MAX_SAFE_INTEGER, { singleLine: true }))
    .toLowerCase()
}

/** Same as foldForScan but with leetspeak digits mapped and every non-alphanumeric removed. */
export function squashForScan(text: string): string {
  const leet: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s" }
  let out = ""
  for (const ch of foldForScan(text)) out += leet[ch] ?? ch
  return out.replace(/[^a-z0-9]+/g, "")
}

/** Bounded excerpt from the start of the text (no ellipsis games; the model gets a prefix). */
export function boundedExcerpt(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : text.slice(0, maxLength)
}

/**
 * Remove angle brackets so untrusted text can never close or spoof the data
 * fences the prompts wrap around it.
 */
export function defang(text: string): string {
  return text.replace(/[<>]/g, " ")
}

/**
 * Shared CSV cell encoder for every user-downloadable CSV (data export, import
 * error report). Applied at the export boundary only — canonical data in the
 * database is never altered.
 *
 * Two jobs, in this order:
 *  1. Formula neutralization (OWASP "CSV injection"). Many cells carry text an
 *     outsider controls (inbound SMS/email, public-form fields, imported
 *     contacts, notes). A cell whose first meaningful character is `=`, `+`,
 *     `-` or `@` is executed as a formula by Excel / Google Sheets /
 *     LibreOffice. We prefix such cells with an apostrophe, which every one of
 *     them treats as a "text" marker (hidden when displayed, not part of the
 *     value the user sees).
 *     "Meaningful" skips leading whitespace and invisible/control characters,
 *     because spreadsheets ignore those before parsing (` =1+1`, `\u0000=...`,
 *     zero-width spaces). A cell that STARTS with tab / CR / LF is also
 *     prefixed — those are the classic Excel bypass/injection forms.
 *  2. RFC 4180 quoting: wrap in double quotes and double any embedded quote
 *     when the cell contains a comma, quote, CR or LF.
 *
 * Ordinary values are untouched: a plain finite number or a string that is
 * only digits with an optional sign/decimal (`-5`, `+15551234567`, `3.14`)
 * cannot form a formula, so it is not prefixed — phone numbers and amounts
 * keep round-tripping.
 */

/** Characters spreadsheets skip before deciding whether a cell is a formula:
 *  all whitespace (incl. NBSP, line/paragraph separators), C0/C1 controls,
 *  zero-width and bidi formatting characters, BOM. */
const LEADING_IGNORABLE =
  /^[\s\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁤⁦-⁩﻿]*/

/** ASCII triggers plus their fullwidth look-alikes (defence in depth). */
const FORMULA_TRIGGERS = new Set([
  "=", "+", "-", "@",
  "＝", "＋", "－", "＠",
])

/** Digits only (optional sign, optional decimal part): never a formula. */
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/

/** Returns the cell text with a formula-neutralizing apostrophe if needed. */
export function neutralizeFormula(text: string): string {
  if (text === "" || PLAIN_NUMBER.test(text)) return text
  const first = text[0]
  if (first === "\t" || first === "\r" || first === "\n") return `'${text}`
  const rest = text.slice(LEADING_IGNORABLE.exec(text)?.[0].length ?? 0)
  return rest !== "" && FORMULA_TRIGGERS.has(rest[0]) ? `'${text}` : text
}

/** Encode one cell: stringify, neutralize formulas, RFC-quote. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ""
  let text: string
  if (typeof value === "string") {
    text = neutralizeFormula(value)
  } else if (typeof value === "number" || typeof value === "bigint") {
    // Numbers cannot be attacker-shaped text; keep negatives/exponents as-is.
    text = String(value)
  } else if (typeof value === "boolean") {
    text = value ? "true" : "false"
  } else {
    // Objects/arrays serialize to JSON (starts with { or [ — not a trigger).
    text = neutralizeFormula(JSON.stringify(value) ?? "")
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function csvRow(cells: readonly unknown[]): string {
  return cells.map(csvCell).join(",")
}

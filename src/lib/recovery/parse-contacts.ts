/**
 * Contacts parsers for Customer Recovery (P8 / NEXT-3,
 * GRADIA_CUSTOMER_RECOVERY_SPEC §1.1): Google Contacts CSV (+ a generic
 * column-mapping fallback) and vCard .vcf. Pure + deterministic → unit-tested
 * without a file or DB. No new dependencies — hand-rolled RFC-4180 CSV + a
 * minimal vCard reader.
 */

export type ContactRecord = {
  name: string | null
  emails: string[]
  phones: string[]
}

// --- CSV --------------------------------------------------------------------

/** RFC-4180-ish tokenizer: handles quoted fields, "" escapes, and commas /
 *  newlines inside quotes. Returns rows of string fields. */
export function parseCsv(content: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  const text = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n")

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
    } else if (ch === ",") {
      row.push(field)
      field = ""
    } else if (ch === "\n") {
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else {
      field += ch
    }
  }
  // Flush the trailing field/row (no final newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((f) => f.trim().length > 0))
}

/** Google packs multiple values into one cell separated by " ::: ". */
function splitMulti(cell: string): string[] {
  return cell
    .split(/\s*:::\s*/)
    .map((v) => v.trim())
    .filter(Boolean)
}

function cleanEmail(v: string): string {
  return v.trim().toLowerCase()
}

export function parseContactsCsv(content: string): ContactRecord[] {
  const rows = parseCsv(content)
  if (rows.length < 2) return []
  const header = rows[0].map((h) => h.trim().toLowerCase())

  const idxOf = (pred: (h: string) => boolean): number[] =>
    header.flatMap((h, i) => (pred(h) ? [i] : []))

  const nameCols = idxOf(
    (h) => h === "name" || h === "full name" || h === "display name"
  )
  const givenCol = header.indexOf("given name")
  const familyCol = header.indexOf("family name")
  const emailCols = idxOf((h) => /e-?mail/.test(h) && !/type|label/.test(h))
  const phoneCols = idxOf(
    (h) => /(phone|mobile|^tel)/.test(h) && !/type|label/.test(h)
  )

  const records: ContactRecord[] = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    const at = (i: number) => (i >= 0 && i < row.length ? row[i].trim() : "")

    let name = nameCols.map(at).find(Boolean) ?? ""
    if (!name) {
      name = [at(givenCol), at(familyCol)].filter(Boolean).join(" ").trim()
    }

    const emails = dedupe(
      emailCols.flatMap((i) => splitMulti(at(i))).map(cleanEmail)
    )
    const phones = dedupe(phoneCols.flatMap((i) => splitMulti(at(i))))

    if (!name && emails.length === 0 && phones.length === 0) continue
    records.push({ name: name || null, emails, phones })
  }
  return records
}

// --- vCard ------------------------------------------------------------------

export function parseVcard(content: string): ContactRecord[] {
  // Unfold: continuation lines begin with a space or tab.
  const unfolded = content
    .replace(/\r\n/g, "\n")
    .replace(/\n[ \t]/g, "")
  const records: ContactRecord[] = []

  // Split into individual cards.
  const cards = unfolded.split(/BEGIN:VCARD/i).slice(1)
  for (const card of cards) {
    const body = card.split(/END:VCARD/i)[0]
    let fn = ""
    let nFallback = ""
    const emails: string[] = []
    const phones: string[] = []

    for (const line of body.split("\n")) {
      const colon = line.indexOf(":")
      if (colon === -1) continue
      const rawProp = line.slice(0, colon)
      const value = line.slice(colon + 1).trim()
      if (!value) continue
      // Property name is up to the first ';' (params follow).
      const prop = rawProp.split(";")[0].trim().toUpperCase()

      if (prop === "FN") fn = value
      else if (prop === "N") {
        // N is Family;Given;Middle;Prefix;Suffix
        const [family = "", given = ""] = value.split(";")
        nFallback = [given, family].filter(Boolean).join(" ").trim()
      } else if (prop === "EMAIL") emails.push(cleanEmail(value))
      else if (prop === "TEL") phones.push(value)
    }

    const name = fn || nFallback
    const e = dedupe(emails)
    const p = dedupe(phones)
    if (!name && e.length === 0 && p.length === 0) continue
    records.push({ name: name || null, emails: e, phones: p })
  }
  return records
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    const key = v.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(v)
    }
  }
  return out
}

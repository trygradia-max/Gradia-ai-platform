/**
 * C7 structured-CSV import (GRADIA_CRM_FOUNDATION_SPEC §C7) — the DETERMINISTIC
 * mapping core. A spreadsheet export (Urable/Jobber/GHL/Google Sheets/…)
 * becomes review-ready extractions with NO model call except the one narrow
 * case the spec allows: a combined vehicle string the regex can't read.
 *
 * Everything here is pure and unit-tested against fixture CSVs:
 *   detectHeaderRow → autoMapColumns (header AND content-based) → applyMapping
 *   → recordToExtraction. Per-column remap = the owner editing CsvMapping
 *   before confirm. Unmapped columns land in notes — never dropped silently.
 *
 * Deterministic cleanup lives here too: E.164-ish phone normalization,
 * SHOUTED/lowercased name casing, first+last name join, date parsing.
 */

import { normalizePhone } from "@/lib/customers"
import { parseVehicle, type ParsedVehicle } from "@/lib/vehicle"
import { parseCsv } from "@/lib/recovery/parse-contacts"
import type { RecoveryExtraction } from "@/lib/recovery/extract"
import type { CrmStage } from "@/lib/types/database"

export { parseCsv }

// --- roles -------------------------------------------------------------------

export const CSV_COLUMN_ROLES = [
  "name",
  "first_name",
  "last_name",
  "phone",
  "email",
  "vehicle",
  "vehicle_year",
  "vehicle_make",
  "vehicle_model",
  "vehicle_color",
  "services",
  "stage",
  "source",
  "last_transaction_at",
  "notes",
] as const

export type CsvColumnRole = (typeof CSV_COLUMN_ROLES)[number]

export type CsvColumnMapping = {
  index: number
  /** Original header cell (or "Column N" when headerless) — for the remap UI. */
  header: string
  role: CsvColumnRole
  /** True when content sniffing (not the header name) decided the role. */
  byContent?: boolean
}

export type CsvMapping = {
  /** Row index of the header, or null for a headerless sheet. */
  headerRowIndex: number | null
  columns: CsvColumnMapping[]
}

// --- header detection ---------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const YEAR_RE = /^(19|20)\d{2}$/

function looksLikePhone(cell: string): boolean {
  const digits = cell.replace(/\D/g, "")
  return digits.length >= 7 && digits.length <= 15 && /^[\d\s()+\-.]+$/.test(cell.trim())
}

function looksLikeDate(cell: string): boolean {
  const t = cell.trim()
  if (!t || YEAR_RE.test(t)) return false
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return true
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(t)) return true
  return false
}

function normHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

/** Header keyword → role, checked in order (first match wins). */
const HEADER_RULES: Array<[RegExp, CsvColumnRole]> = [
  [/last (service|visit|job|transaction|appointment|serviced)|date of last|last date|last seen/, "last_transaction_at"],
  [/^(first|first name|given name|fname)$/, "first_name"],
  [/^(last|last name|surname|family name|lname)$/, "last_name"],
  [/^(name|full name|customer( name)?|client( name)?|contact( name)?|display name)$/, "name"],
  [/phone|mobile|cell|^tel/, "phone"],
  [/e ?mail/, "email"],
  [/(vehicle|car) year|^year$/, "vehicle_year"],
  [/(vehicle|car) make|^make$|^brand$/, "vehicle_make"],
  [/(vehicle|car) model|^model$/, "vehicle_model"],
  [/colou?r/, "vehicle_color"],
  [/^(vehicle|car|car info|automobile|ymm|vehicle info)$/, "vehicle"],
  [/^(service|services|package|job type)$/, "services"],
  [/stage|status|pipeline/, "stage"],
  [/^(source|lead source|referral|channel|how heard.*)$/, "source"],
  [/note|comment|description|memo/, "notes"],
]

function roleFromHeader(header: string): CsvColumnRole | null {
  const h = normHeader(header)
  if (!h) return null
  for (const [re, role] of HEADER_RULES) {
    if (re.test(h)) return role
  }
  return null
}

/**
 * Find the header row in the first few rows (real exports carry title rows).
 * Returns null for a headerless sheet (first row already looks like data).
 */
export function detectHeaderRow(rows: string[][]): number | null {
  const scan = Math.min(rows.length, 5)
  let best: { index: number; score: number } | null = null
  for (let i = 0; i < scan; i++) {
    const cells = rows[i].map((c) => c.trim()).filter(Boolean)
    if (cells.length < 2) continue
    // A row containing data-shaped cells is not a header.
    if (cells.some((c) => EMAIL_RE.test(c) || looksLikePhone(c) || looksLikeDate(c))) {
      continue
    }
    const score = cells.filter((c) => roleFromHeader(c) !== null).length
    if (score >= 2 && (!best || score > best.score)) best = { index: i, score }
  }
  return best?.index ?? null
}

// --- auto-mapping -------------------------------------------------------------

function sniffRole(samples: string[]): CsvColumnRole | null {
  const filled = samples.map((s) => s.trim()).filter(Boolean)
  if (filled.length === 0) return null
  const share = (pred: (c: string) => boolean) =>
    filled.filter(pred).length / filled.length

  if (share((c) => EMAIL_RE.test(c)) >= 0.6) return "email"
  if (share(looksLikePhone) >= 0.6) return "phone"
  if (share((c) => YEAR_RE.test(c.trim())) >= 0.6) return "vehicle_year"
  if (share(looksLikeDate) >= 0.5) return "last_transaction_at"
  if (share((c) => parseVehicle(c).make !== null) >= 0.5) return "vehicle"
  return null
}

/**
 * Auto-map every column: header name first, then content sniffing for opaque
 * headers ("Cell 2", "Field 7" — real exports have them). Anything still
 * unknown maps to notes so no column is dropped silently. The owner can remap
 * any column before confirming (the wizard edits this structure in place).
 */
export function autoMapColumns(
  rows: string[][],
  headerRowIndex: number | null,
  sampleLimit = 20
): CsvMapping {
  const width = Math.max(0, ...rows.map((r) => r.length))
  const headers =
    headerRowIndex !== null ? rows[headerRowIndex] : new Array(width).fill("")
  const dataStart = headerRowIndex !== null ? headerRowIndex + 1 : 0
  const sample = rows.slice(dataStart, dataStart + sampleLimit)

  const columns: CsvColumnMapping[] = []
  for (let i = 0; i < width; i++) {
    const header = (headers[i] ?? "").trim() || `Column ${i + 1}`
    const byHeader = roleFromHeader(headers[i] ?? "")
    if (byHeader) {
      columns.push({ index: i, header, role: byHeader })
      continue
    }
    const byContent = sniffRole(sample.map((r) => r[i] ?? ""))
    columns.push({
      index: i,
      header,
      role: byContent ?? "notes",
      byContent: byContent !== null,
    })
  }
  return { headerRowIndex, columns }
}

// --- mapping application ------------------------------------------------------

export type StructuredCsvRecord = {
  rowIndex: number
  name: string | null
  phones: string[]
  emails: string[]
  /** Combined display string ("2019 Honda Civic, Blue") when anything known. */
  vehicle: string | null
  vehicleParsed: ParsedVehicle | null
  /** Combined string present but the regex found no make → LLM cleanup. */
  vehicleNeedsLlm: boolean
  services: string[]
  stageRaw: string | null
  stage: CrmStage | null
  source: string | null
  lastTransactionAt: string | null
  notes: string[]
}

/** "JANE DOE" / "jane doe" → "Jane Doe"; mixed case passes through untouched. */
export function cleanName(raw: string): string {
  const t = raw.replace(/\s+/g, " ").trim()
  if (!t) return t
  if (t !== t.toUpperCase() && t !== t.toLowerCase()) return t
  return t
    .toLowerCase()
    .replace(/(^|[\s\-'])(\p{L})/gu, (m, sep: string, ch: string) => sep + ch.toUpperCase())
}

/** Best-effort YYYY-MM-DD from ISO or US-style dates; null when unreadable. */
export function cleanDate(raw: string): string | null {
  const t = raw.trim()
  if (!t) return null
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const us = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/)
  if (us) {
    const year = us[3].length === 2 ? `20${us[3]}` : us[3]
    const mm = us[1].padStart(2, "0")
    const dd = us[2].padStart(2, "0")
    if (Number(mm) >= 1 && Number(mm) <= 12 && Number(dd) >= 1 && Number(dd) <= 31) {
      return `${year}-${mm}-${dd}`
    }
  }
  const parsed = Date.parse(t)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null
}

/** Value mapping for pipeline-stage columns ("Estimate Given" → quote_sent). */
export function mapStageValue(raw: string | null | undefined): CrmStage | null {
  const v = (raw ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  if (!v) return null
  if (/(closed )?lost|dead|no response|cold|declined|cancell?ed/.test(v)) return "lost"
  if (/booked|scheduled|won|appointment|confirmed|completed|done|paid/.test(v)) return "booked"
  if (/follow|nurture|waiting|pending/.test(v)) return "follow_up"
  if (/needs? (a )?(quote|estimate)|to quote|(quote|estimate) needed/.test(v)) return "needs_quote"
  if (/quote|estimate|proposal|bid/.test(v)) return "quote_sent"
  if (/new|lead|open|uncontacted|prospect/.test(v)) return "new"
  return null
}

function splitCell(cell: string): string[] {
  return cell
    .split(/\s*(?::::|[;,/])\s*/)
    .map((v) => v.trim())
    .filter(Boolean)
}

function firstFilled(row: string[], indexes: number[]): string | null {
  for (const i of indexes) {
    const v = (row[i] ?? "").trim()
    if (v) return v
  }
  return null
}

/** Apply a (possibly owner-remapped) mapping to every data row. */
export function applyMapping(
  rows: string[][],
  mapping: CsvMapping
): StructuredCsvRecord[] {
  const byRole = new Map<CsvColumnRole, number[]>()
  for (const col of mapping.columns) {
    const list = byRole.get(col.role) ?? []
    list.push(col.index)
    byRole.set(col.role, list)
  }
  const idx = (role: CsvColumnRole): number[] => byRole.get(role) ?? []
  const headerFor = (i: number): string =>
    mapping.columns.find((c) => c.index === i)?.header ?? `Column ${i + 1}`

  const dataStart = mapping.headerRowIndex !== null ? mapping.headerRowIndex + 1 : 0
  const records: StructuredCsvRecord[] = []

  for (let r = dataStart; r < rows.length; r++) {
    const row = rows[r]
    if (!row.some((c) => c.trim())) continue

    // Name: dedicated column first, else first+last joined.
    let name = firstFilled(row, idx("name"))
    if (!name) {
      name =
        [firstFilled(row, idx("first_name")), firstFilled(row, idx("last_name"))]
          .filter(Boolean)
          .join(" ") || null
    }
    if (name) name = cleanName(name)

    const phones = dedupeStrings(
      idx("phone")
        .flatMap((i) => splitCell(row[i] ?? ""))
        .map((p) => normalizePhone(p))
        .filter((p): p is string => Boolean(p))
    )
    const emails = dedupeStrings(
      idx("email")
        .flatMap((i) => splitCell(row[i] ?? ""))
        .map((e) => e.toLowerCase())
        .filter((e) => EMAIL_RE.test(e))
    )

    // Vehicle: parse any combined column, then let structured part columns
    // (owner truth — no regex, no MAKES whitelist) override field by field.
    // The LLM cleanup is queued only when a combined string exists and
    // NEITHER source produced a make.
    const partYearRaw = firstFilled(row, idx("vehicle_year"))
    const partYear = partYearRaw && YEAR_RE.test(partYearRaw.trim())
      ? Number.parseInt(partYearRaw, 10)
      : null
    const partMake = firstFilled(row, idx("vehicle_make"))
    const partModel = firstFilled(row, idx("vehicle_model"))
    const partColor = firstFilled(row, idx("vehicle_color"))
    const combined = firstFilled(row, idx("vehicle"))

    const fromCombined = combined ? parseVehicle(combined) : null
    const mergedVehicle: ParsedVehicle = {
      make: (partMake ? cleanName(partMake) : null) ?? fromCombined?.make ?? null,
      model: partModel ?? fromCombined?.model ?? null,
      year: partYear ?? fromCombined?.year ?? null,
      color: (partColor ? cleanName(partColor) : null) ?? fromCombined?.color ?? null,
    }
    const hasStructured = Boolean(
      mergedVehicle.make || mergedVehicle.model || mergedVehicle.year || mergedVehicle.color
    )
    const vehicleParsed =
      hasStructured && (mergedVehicle.make || mergedVehicle.model)
        ? mergedVehicle
        : null
    const vehicleNeedsLlm = Boolean(combined) && !mergedVehicle.make
    const vehicle = vehicleParsed ? composeVehicleString(vehicleParsed) : combined

    const stageRaw = firstFilled(row, idx("stage"))
    const services = dedupeStrings(idx("services").flatMap((i) => splitCell(row[i] ?? "")))
    const lastTransactionAt = (() => {
      const raw = firstFilled(row, idx("last_transaction_at"))
      return raw ? cleanDate(raw) : null
    })()

    const notes: string[] = []
    for (const i of idx("notes")) {
      const v = (row[i] ?? "").trim()
      if (v) notes.push(`${headerFor(i)}: ${v}`)
    }

    records.push({
      rowIndex: r,
      name,
      phones,
      emails,
      vehicle,
      vehicleParsed,
      vehicleNeedsLlm,
      services,
      stageRaw,
      stage: mapStageValue(stageRaw),
      source: firstFilled(row, idx("source")),
      lastTransactionAt,
      notes,
    })
  }
  return records
}

export function composeVehicleString(v: ParsedVehicle): string | null {
  const main = [v.year, v.make, v.model].filter(Boolean).join(" ")
  if (!main && !v.color) return null
  return v.color ? `${main || "vehicle"}, ${v.color}` : main
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    const k = v.toLowerCase()
    if (!seen.has(k)) {
      seen.add(k)
      out.push(v)
    }
  }
  return out
}

// --- record → extraction --------------------------------------------------------

/**
 * The deterministic counterpart of the P8 LLM worker: a mapped row IS the
 * owner's own customer list, so confidence is 1 and extraction happens at
 * ingest — zero model spend except vehicleNeedsLlm rows, whose vehicle string
 * gets the metered Haiku cleanup at the extract step (extraction stays set;
 * only the vehicle fields are patched).
 */
export function recordToExtraction(rec: StructuredCsvRecord): RecoveryExtraction {
  const direction = rec.lastTransactionAt
    ? "completed"
    : rec.stage === "booked"
      ? "booked"
      : rec.stage === "quote_sent" || rec.stage === "follow_up"
        ? "quote"
        : "inquiry"
  return {
    name: rec.name,
    phones: rec.phones,
    emails: rec.emails,
    vehicle: rec.vehicle,
    services_mentioned: rec.services,
    last_interaction_at: rec.lastTransactionAt,
    direction,
    confidence: 1,
    vehicle_parsed: rec.vehicleParsed,
    vehicle_needs_llm: rec.vehicleNeedsLlm || undefined,
    stage: rec.stage,
    source: rec.source,
    notes: rec.notes.length ? rec.notes.join("\n") : null,
  }
}

/** True when a staged extraction still awaits the Haiku vehicle cleanup. */
export function extractionNeedsVehicleLlm(e: RecoveryExtraction): boolean {
  return e.vehicle_needs_llm === true
}

import { describe, it, expect } from "vitest"

import {
  applyMapping,
  autoMapColumns,
  cleanDate,
  cleanName,
  detectHeaderRow,
  mapStageValue,
  parseCsv,
  recordToExtraction,
  type CsvMapping,
} from "@/lib/recovery/structured-csv"
import { buildUnits, countLlmUnits } from "@/lib/recovery/ingest"
import { buildErrorReportCsv, buildMergeUndo } from "@/lib/recovery/review"
import { DEFAULT_PRICING } from "@/lib/pricing"

/**
 * C7 structured-CSV wizard (spec §C7) — pure mapping core, tested against
 * three realistic fixtures: a Google Contacts export, a Jobber-shaped CRM
 * export, and a messy 15-column sheet with a title row and opaque headers.
 * The P8 acceptance suite is untouched — this is a NEW source type on the
 * same pipeline.
 */

// --- fixtures ----------------------------------------------------------------

const GOOGLE_CONTACTS = [
  "Name,Given Name,Family Name,E-mail 1 - Value,Phone 1 - Value,Phone 2 - Value,Notes",
  'Marcus Webb,Marcus,Webb,marcus@gmail.com,(415) 555-0142,,Repeat ceramic customer',
  'sarah j. lin,Sarah,Lin,sarah.lin@yahoo.com,415-555-0199 ::: 415-555-0200,,',
  ",,,,,,", // fully empty row → skipped
].join("\n")

const JOBBER_EXPORT = [
  "Client Name,Phone,Email,Vehicle Year,Vehicle Make,Vehicle Model,Vehicle Color,Status,Lead Source,Last Job Date,Job Notes",
  "TONY ALVAREZ,+14155550111,tony@x.com,2019,Honda,Civic,Blue,Estimate Given,Google,2026-01-15,Wants full correction",
  "Bo Chen,4155550122,,2021,McLaren,720S,Orange,Scheduled,Referral,03/02/2026,",
  "No Contact Row,,,2020,Ford,F-150,,,,,", // no phone/email → dropped
].join("\n")

// Title row above the header, opaque "F2" phone column (content-sniffed),
// combined vehicle strings (one regex-parseable, one not), a stage column,
// 15 columns wide.
const MESSY_SHEET = [
  "My Shop Customers Export 2026,,,,,,,,,,,,,,",
  "Customer,F2,Email Address,Car,Stage,Src,Last Visit,Fav Color,X1,X2,X3,X4,X5,X6,X7",
  'jane doe,(415) 555-0101,jane@x.com,"2022 Tesla Model Y, white",Estimate Given,IG,6/1/2026,teal,a,b,c,d,e,f,g',
  "Rick Ortiz,415 555 0102,,bimmer m3 comp lifted,New Lead,,,,,,,,,,",
].join("\n")

// --- header detection + auto-mapping -------------------------------------------

describe("detectHeaderRow", () => {
  it("finds the header under a title row", () => {
    expect(detectHeaderRow(parseCsv(MESSY_SHEET))).toBe(1)
  })

  it("finds row 0 on a clean export", () => {
    expect(detectHeaderRow(parseCsv(JOBBER_EXPORT))).toBe(0)
  })
})

describe("autoMapColumns", () => {
  it("maps Google Contacts headers by name", () => {
    const rows = parseCsv(GOOGLE_CONTACTS)
    const mapping = autoMapColumns(rows, 0)
    const roleOf = (h: string) =>
      mapping.columns.find((c) => c.header === h)?.role
    expect(roleOf("Name")).toBe("name")
    expect(roleOf("Given Name")).toBe("first_name")
    expect(roleOf("Family Name")).toBe("last_name")
    expect(roleOf("E-mail 1 - Value")).toBe("email")
    expect(roleOf("Phone 1 - Value")).toBe("phone")
    expect(roleOf("Notes")).toBe("notes")
  })

  it('maps an opaque "F2" column by content and unmapped columns to notes', () => {
    const rows = parseCsv(MESSY_SHEET)
    const mapping = autoMapColumns(rows, 1)
    const byHeader = (h: string) => mapping.columns.find((c) => c.header === h)!
    expect(byHeader("F2").role).toBe("phone")
    expect(byHeader("F2").byContent).toBe(true)
    expect(byHeader("Car").role).toBe("vehicle")
    expect(byHeader("Stage").role).toBe("stage")
    expect(byHeader("Last Visit").role).toBe("last_transaction_at")
    // "Fav Color" matches the color rule by header — a mis-map the owner
    // fixes in the wizard; the X columns fall to notes (never dropped).
    expect(byHeader("X1").role).toBe("notes")
  })
})

// --- deterministic cleanup ------------------------------------------------------

describe("deterministic cleanup", () => {
  it("cleanName fixes SHOUTED and lowercased names, leaves mixed case alone", () => {
    expect(cleanName("TONY ALVAREZ")).toBe("Tony Alvarez")
    expect(cleanName("jane doe")).toBe("Jane Doe")
    expect(cleanName("Sarah J. Lin")).toBe("Sarah J. Lin")
    expect(cleanName("o'brien")).toBe("O'Brien")
  })

  it("cleanDate reads ISO and US dates", () => {
    expect(cleanDate("2026-01-15")).toBe("2026-01-15")
    expect(cleanDate("03/02/2026")).toBe("2026-03-02")
    expect(cleanDate("6/1/26")).toBe("2026-06-01")
    expect(cleanDate("not a date")).toBeNull()
  })
})

describe("mapStageValue", () => {
  it("maps real-world stage values onto crm_stage", () => {
    expect(mapStageValue("Estimate Given")).toBe("quote_sent")
    expect(mapStageValue("Needs Quote")).toBe("needs_quote")
    expect(mapStageValue("Scheduled")).toBe("booked")
    expect(mapStageValue("Follow-Up")).toBe("follow_up")
    expect(mapStageValue("New Lead")).toBe("new")
    expect(mapStageValue("Closed Lost")).toBe("lost")
    expect(mapStageValue("banana")).toBeNull()
    expect(mapStageValue(null)).toBeNull()
  })
})

// --- applyMapping over the fixtures ---------------------------------------------

describe("applyMapping — Google Contacts", () => {
  const rows = parseCsv(GOOGLE_CONTACTS)
  const records = applyMapping(rows, autoMapColumns(rows, 0))

  it("splits multi-value phone cells and normalizes numbers", () => {
    expect(records).toHaveLength(2)
    expect(records[1].phones).toEqual(["4155550199", "4155550200"])
    expect(records[0].phones).toEqual(["4155550142"])
  })

  it("keeps notes columns as notes with their header", () => {
    expect(records[0].notes).toEqual(["Notes: Repeat ceramic customer"])
  })
})

describe("applyMapping — Jobber-shaped export", () => {
  const rows = parseCsv(JOBBER_EXPORT)
  const records = applyMapping(rows, autoMapColumns(rows, 0))

  it("builds structured vehicles from separate columns — no MAKES whitelist", () => {
    expect(records[0].vehicleParsed).toEqual({
      make: "Honda",
      model: "Civic",
      year: 2019,
      color: "Blue",
    })
    // McLaren isn't in the regex whitelist — owner columns are trusted as-is.
    expect(records[1].vehicleParsed?.make).toBe("McLaren")
    expect(records[0].vehicleNeedsLlm).toBe(false)
  })

  it("maps stage/source/date values", () => {
    expect(records[0].stage).toBe("quote_sent")
    expect(records[0].source).toBe("Google")
    expect(records[0].lastTransactionAt).toBe("2026-01-15")
    expect(records[1].stage).toBe("booked")
    expect(records[1].lastTransactionAt).toBe("2026-03-02")
  })

  it("title-cases the shouted name", () => {
    expect(records[0].name).toBe("Tony Alvarez")
  })
})

describe("applyMapping — messy 15-column sheet", () => {
  const rows = parseCsv(MESSY_SHEET)
  const records = applyMapping(rows, autoMapColumns(rows, 1))

  it("parses a clean combined vehicle string deterministically", () => {
    expect(records[0].vehicleParsed?.make).toBe("Tesla")
    expect(records[0].vehicleParsed?.year).toBe(2022)
    expect(records[0].vehicleNeedsLlm).toBe(false)
  })

  it("flags a regex-defeating vehicle string for the LLM cleanup", () => {
    expect(records[1].vehicleParsed).toBeNull()
    expect(records[1].vehicleNeedsLlm).toBe(true)
    expect(records[1].vehicle).toBe("bimmer m3 comp lifted")
  })

  it("carries unmapped columns into notes", () => {
    expect(records[0].notes).toEqual(
      expect.arrayContaining(["X1: a", "X7: g"])
    )
  })
})

// --- per-column remap ------------------------------------------------------------

describe("per-column remap", () => {
  it("the owner's remap wins over the auto-map", () => {
    const rows = parseCsv(MESSY_SHEET)
    const auto = autoMapColumns(rows, 1)
    const remapped: CsvMapping = {
      ...auto,
      columns: auto.columns.map((c) =>
        c.header === "Fav Color" ? { ...c, role: "notes" as const } : c
      ),
    }
    const records = applyMapping(rows, remapped)
    expect(records[0].vehicleParsed?.color).not.toBe("Teal")
    expect(records[0].notes).toEqual(expect.arrayContaining(["Fav Color: teal"]))
  })
})

// --- record → extraction + ingest branch -----------------------------------------

describe("recordToExtraction + buildUnits(structured_csv)", () => {
  const units = buildUnits({
    sourceType: "structured_csv",
    fileContent: MESSY_SHEET,
    ownerEmails: [],
    pricing: DEFAULT_PRICING,
  })

  it("stages deterministic extractions with no bodies", () => {
    expect(units).toHaveLength(2)
    expect(units[0].keep).toBe(true)
    expect(units[0].body).toBe("")
    expect(units[0].extraction?.confidence).toBe(1)
    expect(units[0].extraction?.stage).toBe("quote_sent")
    expect(units[0].extraction?.name).toBe("Jane Doe")
  })

  it("counts only regex-defeated vehicle rows as LLM units", () => {
    expect(countLlmUnits(units)).toBe(1)
    expect(units[1].extraction?.vehicle_needs_llm).toBe(true)
  })

  it("drops unreachable rows with a reason (error report)", () => {
    const jobberUnits = buildUnits({
      sourceType: "structured_csv",
      fileContent: JOBBER_EXPORT,
      ownerEmails: [],
      pricing: DEFAULT_PRICING,
    })
    const dropped = jobberUnits.filter((u) => !u.keep)
    expect(dropped).toHaveLength(1)
    expect(dropped[0].dropReason).toBe("no contact info")
    const csv = buildErrorReportCsv(
      dropped.map((u) => ({ subject: u.subject, drop_reason: u.dropReason }))
    )
    expect(csv).toContain("no contact info")
  })

  it("direction derives from recency and stage", () => {
    const rows = parseCsv(JOBBER_EXPORT)
    const records = applyMapping(rows, autoMapColumns(rows, 0))
    // Has a last-job date → a past customer.
    expect(recordToExtraction(records[0]).direction).toBe("completed")
  })
})

// --- undo pre-image ---------------------------------------------------------------

describe("buildMergeUndo", () => {
  it("captures the prior value of every patched key", () => {
    const prev = buildMergeUndo(
      { email: null, last_transaction_at: "2025-01-01", name: "Bo" },
      { email: "bo@x.com", last_transaction_at: "2026-03-02" }
    )
    expect(prev).toEqual({ email: null, last_transaction_at: "2025-01-01" })
  })
})

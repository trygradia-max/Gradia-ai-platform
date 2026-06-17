import { describe, it, expect } from "vitest"

import {
  parseContactsCsv,
  parseCsv,
  parseVcard,
} from "@/lib/recovery/parse-contacts"

/**
 * Contacts parsing (GRADIA_CUSTOMER_RECOVERY_SPEC §1.1): Google Contacts CSV,
 * a generic column-mapping fallback, and vCard.
 */

describe("parseCsv", () => {
  it("handles quoted fields with commas and escaped quotes", () => {
    const rows = parseCsv('a,"b,c","d""e"\n1,2,3\n')
    expect(rows[0]).toEqual(["a", "b,c", 'd"e'])
    expect(rows[1]).toEqual(["1", "2", "3"])
  })

  it("handles newlines inside quotes", () => {
    const rows = parseCsv('name,note\n"Greg","line1\nline2"\n')
    expect(rows).toHaveLength(2)
    expect(rows[1][1]).toBe("line1\nline2")
  })
})

describe("parseContactsCsv — Google Contacts shape", () => {
  const csv = `Name,Given Name,Family Name,E-mail 1 - Value,Phone 1 - Value,Phone 2 - Value
Marcus Webb,Marcus,Webb,Marcus.Webb88@Gmail.com,(415) 555-0142,
,Dana,Reyes,dana@outlook.com,,510-555-0123
`
  it("maps name, email (lowercased), and phones", () => {
    const recs = parseContactsCsv(csv)
    expect(recs).toHaveLength(2)
    expect(recs[0]).toEqual({
      name: "Marcus Webb",
      emails: ["marcus.webb88@gmail.com"],
      phones: ["(415) 555-0142"],
    })
  })

  it("falls back to Given + Family when Name is blank", () => {
    const recs = parseContactsCsv(csv)
    expect(recs[1].name).toBe("Dana Reyes")
    expect(recs[1].phones).toEqual(["510-555-0123"])
  })
})

describe("parseContactsCsv — generic fallback + multi-value cells", () => {
  it("detects email/phone columns by header keyword and splits ::: values", () => {
    const csv = `Full Name,Email,Mobile
"Sofia Mendez","sofia@x.com ::: sofia.work@x.com","415-555-0188 ::: 415-555-0190"
`
    const recs = parseContactsCsv(csv)
    expect(recs[0].name).toBe("Sofia Mendez")
    expect(recs[0].emails).toEqual(["sofia@x.com", "sofia.work@x.com"])
    expect(recs[0].phones).toEqual(["415-555-0188", "415-555-0190"])
  })

  it("skips rows with no usable identity", () => {
    const csv = `Name,Email,Phone\n,,\nReal Person,real@x.com,\n`
    const recs = parseContactsCsv(csv)
    expect(recs).toHaveLength(1)
    expect(recs[0].name).toBe("Real Person")
  })
})

describe("parseVcard", () => {
  const vcf = `BEGIN:VCARD
VERSION:3.0
FN:Mike Sandoval
N:Sandoval;Mike;;;
TEL;TYPE=CELL:+1 (650) 555-0133
EMAIL;TYPE=HOME:Mike.Sandoval.Cars@gmail.com
END:VCARD
BEGIN:VCARD
VERSION:3.0
N:Reyes;Dana;;;
TEL:510-555-0123
END:VCARD
`
  it("parses FN/TEL/EMAIL with params and lowercases email", () => {
    const recs = parseVcard(vcf)
    expect(recs).toHaveLength(2)
    expect(recs[0]).toEqual({
      name: "Mike Sandoval",
      emails: ["mike.sandoval.cars@gmail.com"],
      phones: ["+1 (650) 555-0133"],
    })
  })

  it("falls back to N when FN is absent", () => {
    const recs = parseVcard(vcf)
    expect(recs[1].name).toBe("Dana Reyes")
    expect(recs[1].phones).toEqual(["510-555-0123"])
  })
})

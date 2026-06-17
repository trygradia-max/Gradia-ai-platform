import { describe, it, expect } from "vitest"

import {
  buildCandidates,
  contactToText,
  CONFIDENCE_THRESHOLD,
  type ExtractedRow,
} from "@/lib/recovery/candidates"
import { buildUnits } from "@/lib/recovery/ingest"
import { DEFAULT_PRICING } from "@/lib/pricing"
import type { RecoveryExtraction } from "@/lib/recovery/extract"

/**
 * Pure seams of the orchestrator (NEXT-3): the confidence gate, contact→text,
 * and the parse/prefilter branching per source type. The DB/storage/LLM paths
 * are exercised live once the migration + bucket exist.
 */

const ext = (over: Partial<RecoveryExtraction>): RecoveryExtraction => ({
  name: "Marcus Webb",
  phones: ["(415) 555-0142"],
  emails: ["marcus@gmail.com"],
  vehicle: null,
  services_mentioned: [],
  last_interaction_at: null,
  direction: "quote",
  confidence: 0.9,
  ...over,
})

describe("contactToText", () => {
  it("renders a card the worker can read", () => {
    const t = contactToText({
      name: "Mike Sandoval",
      phones: ["+1 650 555 0133"],
      emails: ["mike@gmail.com"],
    })
    expect(t).toContain("Name: Mike Sandoval")
    expect(t).toContain("Phones: +1 650 555 0133")
    expect(t).toContain("Emails: mike@gmail.com")
  })
})

describe("buildCandidates — the confidence + reachability gate", () => {
  it("keeps a confident, reachable extraction", () => {
    const rows: ExtractedRow[] = [{ id: "r1", extraction: ext({}) }]
    const c = buildCandidates(rows)
    expect(c).toHaveLength(1)
    expect(c[0].provenance).toBe("r1")
  })

  it("drops low-confidence (vendor/spam that slipped the filter)", () => {
    const rows: ExtractedRow[] = [
      { id: "r1", extraction: ext({ confidence: CONFIDENCE_THRESHOLD - 0.01 }) },
    ]
    expect(buildCandidates(rows)).toHaveLength(0)
  })

  it("drops a confident extraction with no phone and no email (unreachable)", () => {
    const rows: ExtractedRow[] = [
      { id: "r1", extraction: ext({ phones: [], emails: [] }) },
    ]
    expect(buildCandidates(rows)).toHaveLength(0)
  })
})

describe("buildUnits — source-type branching", () => {
  const MBOX = `From 1@x Tue Mar 04 14:22:00 2026
From: Marcus <marcus@gmail.com>
To: hello@pristinedetail.com
Subject: Ceramic quote
Date: Tue, 4 Mar 2026 14:22:00 -0800
Message-ID: <m1@mail>

Interested in ceramic.

From 2@x Tue Mar 04 16:00:00 2026
From: Pristine <hello@pristinedetail.com>
Subject: Re: Ceramic quote
Date: Tue, 4 Mar 2026 16:00:00 -0800
Message-ID: <m2@mail>

$1,200.

From 3@x Wed Dec 02 06:00:00 2025
From: Deals <promo@autopartswholesale.com>
Subject: Sale
Date: Tue, 2 Dec 2025 06:00:00 -0800
List-Unsubscribe: <mailto:u@x.com>

Buy now.
`

  it("keeps human threads and drops bulk/no-reply from an mbox", () => {
    const units = buildUnits({
      sourceType: "mbox",
      fileContent: MBOX,
      ownerEmails: ["hello@pristinedetail.com"],
      pricing: DEFAULT_PRICING,
    })
    const kept = units.filter((u) => u.keep)
    const dropped = units.filter((u) => !u.keep)
    expect(kept).toHaveLength(1)
    expect(kept[0].body).toContain("ceramic")
    expect(dropped).toHaveLength(1)
    expect(dropped[0].body).toBe("") // dropped units never carry a body
  })

  it("turns each CSV contact into a kept unit", () => {
    const units = buildUnits({
      sourceType: "contacts_csv",
      fileContent: `Name,Email,Phone\nMarcus Webb,marcus@gmail.com,(415) 555-0142\n`,
      ownerEmails: [],
      pricing: DEFAULT_PRICING,
    })
    expect(units).toHaveLength(1)
    expect(units[0].keep).toBe(true)
    expect(units[0].body).toContain("Marcus Webb")
  })
})

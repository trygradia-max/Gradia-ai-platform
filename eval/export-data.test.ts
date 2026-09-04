import { describe, it, expect } from "vitest"

import type { SupabaseClient } from "@supabase/supabase-js"

import { mockSupabase } from "./_lib"
import {
  EXPORT_ENTITIES,
  columnsFor,
  exportFilename,
  fetchExportRows,
  isExportEntity,
  rowsToCsv,
  rowsToJson,
} from "@/lib/export-data"

/**
 * B-01 — data export. Tier 1: pure serialization + the tenant-scoped fetch
 * (mocked Supabase, no network). The route's auth/rate-limit gate is covered
 * separately in eval/export-route.test.ts.
 */

describe("isExportEntity", () => {
  it("accepts every documented entity", () => {
    for (const e of EXPORT_ENTITIES) {
      expect(isExportEntity(e)).toBe(true)
    }
  })

  it("rejects anything else, including a table name from another tenant surface", () => {
    expect(isExportEntity("shops")).toBe(false)
    expect(isExportEntity("")).toBe(false)
    expect(isExportEntity("all")).toBe(false)
  })
})

describe("rowsToCsv", () => {
  it("escapes commas, quotes and newlines the same way lib/recovery/review.ts does", () => {
    const csv = rowsToCsv(
      [{ id: "1", name: 'Smith, "Bob"', notes: "line one\nline two" }],
      "customers"
    )
    const lines = csv.split("\n")
    expect(lines[0]).toBe("id,name,notes")
    expect(lines[1]).toContain('"Smith, ""Bob"""')
    expect(csv).toContain('"line one\nline two"')
  })

  it("renders null/undefined fields as empty, not the string 'null'", () => {
    const csv = rowsToCsv([{ id: "1", email: null }], "customers")
    expect(csv.split("\n")[1]).toBe("1,")
  })

  it("falls back to the documented header when there are zero rows", () => {
    const csv = rowsToCsv([], "leads")
    expect(csv.split("\n")).toHaveLength(1)
    expect(csv).toContain("customer_name")
  })
})

describe("rowsToJson", () => {
  it("round-trips rows as pretty-printed JSON", () => {
    const rows = [{ id: "1", name: "Ada" }]
    expect(JSON.parse(rowsToJson(rows))).toEqual(rows)
  })
})

describe("columnsFor", () => {
  it("uses the real row's keys when data exists (schema drift shows up automatically)", () => {
    const rows = [{ id: "1", brand_new_column: "x" }]
    expect(columnsFor("customers", rows)).toEqual(["id", "brand_new_column"])
  })
})

describe("exportFilename", () => {
  it("names the file by entity, date and format", () => {
    const name = exportFilename("appointments", "json")
    expect(name).toMatch(/^gradia-appointments-\d{4}-\d{2}-\d{2}\.json$/)
  })
})

describe("fetchExportRows", () => {
  it("strips the embedding vector from conversations (interactions) rows", async () => {
    const supabase = mockSupabase({
      data: [
        {
          id: "1",
          shop_id: "shop-1",
          content: "hi",
          embedding: [0.1, 0.2, 0.3],
          embedding_model: "text-embedding-3",
        },
      ],
      error: null,
    }) as SupabaseClient

    const rows = await fetchExportRows(supabase, "shop-1", "conversations")
    expect(rows).toEqual([{ id: "1", shop_id: "shop-1", content: "hi" }])
  })

  it("passes other entities through unshaped", async () => {
    const supabase = mockSupabase({
      data: [{ id: "1", shop_id: "shop-1", name: "Ada" }],
      error: null,
    }) as SupabaseClient

    const rows = await fetchExportRows(supabase, "shop-1", "customers")
    expect(rows).toEqual([{ id: "1", shop_id: "shop-1", name: "Ada" }])
  })

  it("throws on a query error rather than returning an empty/partial export silently", async () => {
    const supabase = mockSupabase({
      data: undefined,
      error: { message: "boom" },
    }) as SupabaseClient

    await expect(fetchExportRows(supabase, "shop-1", "leads")).rejects.toThrow(
      /export fetch failed \(leads\)/
    )
  })

  it("returns an empty array, not undefined, when a shop has no rows yet", async () => {
    const supabase = mockSupabase({ error: null }) as SupabaseClient
    const rows = await fetchExportRows(supabase, "shop-1", "vehicles")
    expect(rows).toEqual([])
  })
})

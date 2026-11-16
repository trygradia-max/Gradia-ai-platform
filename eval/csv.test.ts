import { describe, it, expect } from "vitest"

import { csvCell, csvRow, neutralizeFormula } from "@/lib/csv"
import { rowsToCsv } from "@/lib/export-data"
import { buildErrorReportCsv } from "@/lib/recovery/review"

/** Security audit run-1 #7 — spreadsheet formula injection in CSV exports. */

describe("csvCell: direct formula triggers", () => {
  it.each([
    "=1+1",
    "+SUM(A1:A9)",
    "-2+3",
    "@SUM(1)",
    '=HYPERLINK("http://evil.example","x")',
    "=cmd|' /C calc'!A0",
    "＝1+1",
    "＋1+1",
    "－1+1",
    "＠SUM(1)",
  ])("prefixes %j with an apostrophe", (v) => {
    expect(neutralizeFormula(v)).toBe(`'${v}`)
  })
})

describe("csvCell: leading whitespace / control bypasses", () => {
  it.each([
    " =1+1",
    "   +cmd",
    " =1+1",
    "\u0000=1+1",
    "\u0001@x",
    "\u001f-x",
    "​=1+1",
    "﻿=1+1",
    " =1+1",
    "‮=1+1",
    "\u0085=1+1",
    "\t=1+1",
    "\r=1+1",
    "\n=1+1",
    "\n\t \r=1+1",
    "\tplain",
    "\rplain",
  ])("neutralizes %j", (v) => {
    expect(neutralizeFormula(v).startsWith("'")).toBe(true)
  })

  it("keeps the original bytes after the apostrophe", () => {
    expect(neutralizeFormula("  =A1")).toBe("'  =A1")
  })
})

describe("csvCell: RFC quoting preserved", () => {
  it("quotes commas, quotes, LF and CR", () => {
    expect(csvCell("a,b")).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell("l1\nl2")).toBe('"l1\nl2"')
    expect(csvCell("l1\r\nl2")).toBe('"l1\r\nl2"')
    expect(csvCell("a\rb")).toBe('"a\rb"')
  })

  it("neutralizes then quotes a formula containing commas and quotes", () => {
    expect(csvCell('=HYPERLINK("x","y")')).toBe('"\'=HYPERLINK(""x"",""y"")"')
  })

  it("quotes a leading-newline formula after prefixing", () => {
    expect(csvCell("\n=1+1")).toBe("\"'\n=1+1\"")
  })

  it("does not alter text after an embedded newline inside a quoted cell", () => {
    expect(csvCell("hello\n=1+1")).toBe('"hello\n=1+1"')
  })
})

describe("csvCell: ordinary values untouched", () => {
  it.each([
    "Jane Smith",
    "O'Brien",
    "jane@example.com",
    "2026-11-14T10:00:00Z",
    "Ceramic coating - full car",
    "a=b",
    "1 + 1",
    "",
    "Zoë 日本語 🚗",
    "École",
    "+15551234567",
    "-5",
    "3.14",
    "'already text",
  ])("passes %j through", (v) => {
    expect(csvCell(v)).toBe(v)
  })

  it("handles null, undefined, numbers, booleans, objects", () => {
    expect(csvCell(null)).toBe("")
    expect(csvCell(undefined)).toBe("")
    expect(csvCell(-12.5)).toBe("-12.5")
    expect(csvCell(0)).toBe("0")
    expect(csvCell(true)).toBe("true")
    expect(csvCell({ a: "=1" })).toBe('"{""a"":""=1""}"')
    expect(csvCell(["=1"])).toBe('"[""=1""]"')
  })

  it("does not exempt look-alike numbers that carry a payload", () => {
    expect(csvCell("+1+1")).toBe("'+1+1")
    expect(csvCell("-1e3")).toBe("'-1e3")
    expect(csvCell("+1 (555) 123-4567")).toBe("'+1 (555) 123-4567")
  })
})

describe("csvRow", () => {
  it("joins encoded cells", () => {
    expect(csvRow(["a", "=x", null, "b,c"])).toBe('a,\'=x,,"b,c"')
  })
})

describe("export boundaries use the safe encoder", () => {
  it("rowsToCsv neutralizes externally sourced fields in every column", () => {
    const csv = rowsToCsv(
      [
        {
          id: "1",
          name: "=cmd|' /C calc'!A0",
          phone: "+15551234567",
          content: "\t@SUM(1)",
          notes: ' =HYPERLINK("http://e","x")',
          meta: { k: "=1" },
        },
      ],
      "customers"
    )
    const [header, line] = csv.split("\n")
    expect(header).toBe("id,name,phone,content,notes,meta")
    expect(line).toContain("'=cmd|' /C calc'!A0")
    expect(line).toContain(",+15551234567,")
    expect(line).toContain("'\t@SUM(1)")
    expect(line).toContain("\"' =HYPERLINK(")
  })

  it("rowsToCsv fallback header (empty export) is intact", () => {
    expect(rowsToCsv([], "customers").split("\n")[0]).toMatch(/^id,name,phone/)
  })

  it("rowsToCsv leaves raw row objects unmodified", () => {
    const rows = [{ id: "1", name: "=1+1" }]
    rowsToCsv(rows, "customers")
    expect(rows[0].name).toBe("=1+1")
  })

  it("buildErrorReportCsv neutralizes subject and reason", () => {
    const csv = buildErrorReportCsv([
      { subject: "=1+1", drop_reason: "@bad, reason" },
      { subject: null, drop_reason: null },
    ])
    expect(csv.split("\n")).toEqual([
      "row,reason",
      "'=1+1,\"'@bad, reason\"",
      "(unnamed row),unknown",
    ])
  })
})

describe("no hand-rolled CSV escaping outside the shared encoder", () => {
  it("only src/lib/csv.ts doubles quotes for CSV", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs")
    const { join } = await import("node:path")
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(name) && readFileSync(p, "utf8").includes(`'""'`)) hits.push(p)
      }
    }
    walk(join(process.cwd(), "src"))
    expect(hits.map((h) => h.split("/src/")[1])).toEqual(["lib/csv.ts"])
  })
})

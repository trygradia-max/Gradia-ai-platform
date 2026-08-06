import { afterEach, describe, expect, it, vi } from "vitest"

import { listCalendarEvents, wallTimeToInstant } from "@/lib/aurinko"

/**
 * P0-004 entry gates 1–3 — Aurinko event datetimes. The provider's event
 * model is `{ dateTime, timezone }` and `dateTime` is NOT guaranteed to
 * carry a UTC offset. The seam must (a) pass through anchored values,
 * (b) convert offsetless wall times using the DECLARED timezone, and
 * (c) drop — never guess, never read in server-local time — offsetless
 * values with no resolvable timezone.
 */

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("wallTimeToInstant — declared-timezone conversion", () => {
  it("converts summer wall time (PDT, UTC-7)", () => {
    expect(wallTimeToInstant("2026-08-10T10:00:00", "America/Los_Angeles")).toBe(
      "2026-08-10T17:00:00.000Z"
    )
  })

  it("converts winter wall time (PST, UTC-8) — DST-aware", () => {
    expect(wallTimeToInstant("2026-01-10T10:00:00", "America/Los_Angeles")).toBe(
      "2026-01-10T18:00:00.000Z"
    )
  })

  it("handles UTC and eastern-hemisphere zones", () => {
    expect(wallTimeToInstant("2026-08-10T10:00:00", "UTC")).toBe(
      "2026-08-10T10:00:00.000Z"
    )
    expect(wallTimeToInstant("2026-08-10T10:00:00", "Asia/Tokyo")).toBe(
      "2026-08-10T01:00:00.000Z"
    )
  })

  it("returns a defined instant even for a DST spring-forward gap (no crash)", () => {
    // 02:30 on 2026-03-08 does not exist in LA — conversion must settle on
    // a nearby real instant rather than loop or throw.
    const instant = wallTimeToInstant("2026-03-08T02:30:00", "America/Los_Angeles")
    expect(instant).not.toBeNull()
    expect(Number.isNaN(Date.parse(instant as string))).toBe(false)
  })

  it("returns null for an unknown timezone or garbage input — caller drops, never guesses", () => {
    expect(wallTimeToInstant("2026-08-10T10:00:00", "Not/A_Zone")).toBeNull()
    expect(wallTimeToInstant("garbage", "UTC")).toBeNull()
  })
})

describe("listCalendarEvents — normalization at the provider seam", () => {
  function stubFetch(records: unknown[]): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        text: async () => JSON.stringify({ records }),
      }))
    )
  }

  const range = {
    timeMin: "2026-08-10T00:00:00Z",
    timeMax: "2026-08-11T00:00:00Z",
  }

  it("anchored datetimes (Z or offset) pass through untouched", async () => {
    stubFetch([
      {
        id: "ev-1",
        subject: "Anchored",
        start: { dateTime: "2026-08-10T10:00:00Z", timezone: "America/Los_Angeles" },
        end: { dateTime: "2026-08-10T12:00:00-07:00", timezone: "America/Los_Angeles" },
      },
    ])
    const [event] = await listCalendarEvents("token", "primary", range)
    expect(event.start).toBe("2026-08-10T10:00:00Z")
    expect(event.end).toBe("2026-08-10T12:00:00-07:00")
  })

  it("offsetless datetime + declared timezone → converted to a UTC instant (gate 2)", async () => {
    stubFetch([
      {
        id: "ev-2",
        subject: "Offsetless",
        start: { dateTime: "2026-08-10T10:00:00", timezone: "America/Los_Angeles" },
        end: { dateTime: "2026-08-10T12:00:00", timezone: "America/Los_Angeles" },
      },
    ])
    const [event] = await listCalendarEvents("token", "primary", range)
    // 10:00 PDT = 17:00Z — NOT the server's local reading of "10:00".
    expect(event.start).toBe("2026-08-10T17:00:00.000Z")
    expect(event.end).toBe("2026-08-10T19:00:00.000Z")
  })

  it("offsetless datetime with no timezone → dropped with a warning, never server-local (gate 3)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    stubFetch([
      {
        id: "ev-3",
        subject: "Naked",
        start: { dateTime: "2026-08-10T10:00:00" },
        end: "2026-08-10T12:00:00",
      },
    ])
    const [event] = await listCalendarEvents("token", "primary", range)
    expect(event.start).toBeNull()
    expect(event.end).toBeNull()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("no UTC offset")
    )
  })
})

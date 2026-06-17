import { describe, it, expect } from "vitest"

import {
  winbackChannel,
  isSmsEligibleForWinback,
  withinEbrWindow,
  EBR_WINDOW_MONTHS,
  type WinbackCustomer,
} from "@/lib/recovery/winback-eligibility"

/**
 * TCPA / CAN-SPAM win-back gate (GRADIA_CUSTOMER_RECOVERY_SPEC §3.2). Same
 * style as the isAutonomyAllowed locking tests: this guardrail lives in code
 * and these tests are its contract. Extend them, never weaken them.
 */

// A fixed "now" so the EBR math is deterministic.
const NOW = Date.parse("2026-06-16T00:00:00Z")
const monthsAgo = (n: number): string => {
  const d = new Date(NOW)
  d.setMonth(d.getMonth() - n)
  return d.toISOString()
}

const base: WinbackCustomer = {
  phone: "+14155550142",
  email: "marcus@gmail.com",
  last_transaction_at: monthsAgo(3),
  sms_opted_out_at: null,
  do_not_contact: false,
}

describe("win-back channel — the happy paths", () => {
  it("a recent customer with a phone, not opted out, is SMS-eligible", () => {
    expect(winbackChannel(base, NOW)).toBe("sms")
  })

  it("falls back to email when there's no phone", () => {
    expect(winbackChannel({ ...base, phone: null }, NOW)).toBe("email")
  })

  it("falls back to email when SMS-opted-out", () => {
    expect(
      winbackChannel({ ...base, sms_opted_out_at: monthsAgo(1) }, NOW)
    ).toBe("email")
  })

  it("falls back to email when outside the EBR window", () => {
    expect(winbackChannel({ ...base, last_transaction_at: monthsAgo(24) }, NOW)).toBe(
      "email"
    )
  })

  it("reaches no one when do_not_contact is set", () => {
    expect(winbackChannel({ ...base, do_not_contact: true }, NOW)).toBe("none")
    // even with a perfect SMS profile otherwise
    expect(isSmsEligibleForWinback({ ...base, do_not_contact: true }, NOW)).toBe(
      false
    )
  })

  it("reaches no one with neither a phone nor an email", () => {
    expect(
      winbackChannel({ ...base, phone: null, email: null }, NOW)
    ).toBe("none")
  })
})

describe("EBR window boundary", () => {
  it("counts a transaction just inside 18 months as eligible", () => {
    expect(withinEbrWindow(monthsAgo(EBR_WINDOW_MONTHS - 1), NOW)).toBe(true)
  })

  it("counts a transaction past 18 months as stale", () => {
    expect(withinEbrWindow(monthsAgo(EBR_WINDOW_MONTHS + 1), NOW)).toBe(false)
  })

  it("treats a missing or unparseable date as stale (fail closed)", () => {
    expect(withinEbrWindow(null, NOW)).toBe(false)
    expect(withinEbrWindow("not a date", NOW)).toBe(false)
  })
})

describe("LOCKED — a 19-month-stale customer can NEVER be SMS-eligible", () => {
  // The spec's named acceptance: last_transaction_at 19 months ago must never
  // resolve into an SMS audience, regardless of any other field. We sweep the
  // permutations so no combination of consent/flags can flip it to SMS.
  const stale = monthsAgo(19)
  it("holds across every other-field permutation", () => {
    for (const phone of ["+14155550142", null]) {
      for (const email of ["marcus@gmail.com", null]) {
        for (const sms_opted_out_at of [null, monthsAgo(1)]) {
          for (const do_not_contact of [false, true]) {
            const c: WinbackCustomer = {
              phone,
              email,
              last_transaction_at: stale,
              sms_opted_out_at,
              do_not_contact,
            }
            expect(
              isSmsEligibleForWinback(c, NOW),
              JSON.stringify(c)
            ).toBe(false)
            expect(winbackChannel(c, NOW)).not.toBe("sms")
          }
        }
      }
    }
  })
})

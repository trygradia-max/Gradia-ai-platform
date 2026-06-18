import { describe, it, expect } from "vitest"

import { LIVE } from "./_lib"
import { RECOVERY_FIXTURES } from "./fixtures/recovery-threads"
import { extractCustomerFromThread } from "@/lib/recovery/extract"

/**
 * Live eval gating the Customer Recovery extraction worker
 * (GRADIA_CUSTOMER_RECOVERY_SPEC §2.1 — "the worker doesn't ship until it
 * passes"). Runs only with EVAL_LIVE=1 + a key. We assert on substance, not
 * exact strings: phone/email DIGITS-and-identity, name + vehicle make/model
 * contains, the direction enum, and — critically — that vendor spam comes back
 * low-confidence so downstream code drops it.
 *
 * Run: `npm run eval` (or EVAL_LIVE=1 vitest run eval/recovery-extraction.eval.test.ts)
 */

const digits = (s: string) => s.replace(/\D/g, "")

describe.skipIf(!LIVE)("Customer Recovery — extraction worker [live]", () => {
  for (const fx of RECOVERY_FIXTURES) {
    it(`${fx.id} (${fx.category})`, async () => {
      const got = await extractCustomerFromThread(fx.thread)
      const golden = fx.golden

      // Confidence: spam/non-customer must be low; real customers must be high.
      if (golden.confidence <= 0.2) {
        expect(got.confidence, "spam must score low-confidence").toBeLessThanOrEqual(
          0.4
        )
        // Low-confidence rows get dropped by code, so stop checking detail here.
        return
      }
      expect(got.confidence, "a real customer must score high").toBeGreaterThanOrEqual(
        0.6
      )

      // Direction enum must match the customer's furthest progress.
      expect(got.direction, "direction").toBe(golden.direction)

      // Every golden phone must appear (by last-10 digits) in what we pulled.
      const gotPhoneDigits = got.phones.map(digits)
      for (const gp of golden.phones) {
        const want = digits(gp).slice(-10)
        expect(
          gotPhoneDigits.some((d) => d.slice(-10) === want),
          `phone ${gp} should be extracted (got ${JSON.stringify(got.phones)})`
        ).toBe(true)
      }

      // Every golden email must appear (case-insensitive).
      const gotEmails = got.emails.map((e) => e.toLowerCase())
      for (const ge of golden.emails) {
        expect(gotEmails, `email ${ge}`).toContain(ge.toLowerCase())
      }

      // Name: surname is the reliable anchor across nickname/format variance.
      if (golden.name) {
        const surname = golden.name.split(/\s+/).pop()!.toLowerCase()
        expect(
          (got.name ?? "").toLowerCase(),
          `name should include "${surname}"`
        ).toContain(surname)
      }

      // Vehicle: the model token is the strongest signal when present.
      if (golden.vehicle) {
        const tokens = golden.vehicle.toLowerCase().split(/[\s,;]+/).filter(Boolean)
        const model = tokens.find((t) =>
          ["3", "q5", "f-150", "x5", "rx", "macan", "tahoe", "gti", "pilot", "corvette", "civic"].includes(
            t
          )
        )
        if (model) {
          expect(
            (got.vehicle ?? "").toLowerCase(),
            `vehicle should mention "${model}"`
          ).toContain(model)
        }
      }
    }, 60_000)
  }
})

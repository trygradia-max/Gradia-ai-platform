import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

/**
 * P0-010 — production env + error-surface locks.
 *
 * 1. Env documentation: every env var the billing/monitoring code reads is
 *    named in .env.example (audit doc 12 item 7 — a missing var would 500
 *    voice checkout in production), and no line carries a secret-shaped
 *    VALUE (names + placeholders only).
 * 2. revalidatePath source scan: no server action revalidates a legacy
 *    redirect-stub route — those revalidations are no-ops against pages
 *    that only redirect (audit doc 08; prevents recurrence).
 * 3. Error surfaces: the boundaries exist and report to Sentry rather than
 *    swallowing the event.
 */

const ENV_EXAMPLE = readFileSync(".env.example", "utf8")

describe("env documentation (.env.example)", () => {
  const REQUIRED_NAMES = [
    // P0-013: one Price per tier (D-031/D-034) — the rollout switch.
    "STRIPE_PRICE_CORE",
    "STRIPE_PRICE_PRO",
    "STRIPE_PRICE_OPERATOR",
    // The audit-flagged vars (P0-010 scope item 1) that survive P0-013:
    "STRIPE_PRICE_CREDIT_PACK",
    "STRIPE_PRICE_MINUTE_PACK",
    "STRIPE_API_BASE",
    "GLOBAL_DAILY_COST_CEILING_CENTS",
    // Long-documented criticals that must never drop out:
    "STRIPE_SECRET_KEY",
    "ENCRYPTION_KEY",
    "CRON_SECRET",
    "VAPI_DEFAULT_SHOP_ID",
  ]

  it("documents every required variable by name", () => {
    for (const name of REQUIRED_NAMES) {
      expect(
        new RegExp(`^${name}=`, "m").test(ENV_EXAMPLE),
        `missing ${name}= line in .env.example`
      ).toBe(true)
    }
  })

  it("no longer documents the retired two-SKU price vars (P0-013)", () => {
    for (const name of ["STRIPE_PRICE_ID", "STRIPE_PRICE_VOICE_ADDON"]) {
      expect(
        new RegExp(`^${name}=`, "m").test(ENV_EXAMPLE),
        `${name}= must not be documented — retired by P0-013`
      ).toBe(false)
    }
  })

  it("carries no secret-shaped values — names and placeholders only", () => {
    const assignments = ENV_EXAMPLE.split("\n").filter(
      (line) => !line.trimStart().startsWith("#") && line.includes("=")
    )
    const secretShapes =
      /(sk_live_|sk_test_\w{8,}|whsec_\w{8,}|xoxb-\d|postgres(ql)?:\/\/[^<\s]+:[^<\s]+@|price_1\w{8,})/
    for (const line of assignments) {
      const value = line.slice(line.indexOf("=") + 1).trim()
      expect(
        secretShapes.test(value),
        `secret-shaped value in .env.example line: ${line.split("=")[0]}=…`
      ).toBe(false)
    }
  })

  it("keeps the VAPI_DEFAULT_SHOP_ID production warning (leave blank in prod)", () => {
    // The P0-007 code guard fails closed in production; the doc note is the
    // operational half of that defense (audit trace H footgun).
    const idx = ENV_EXAMPLE.indexOf("VAPI_DEFAULT_SHOP_ID=")
    expect(idx).toBeGreaterThan(-1)
    const preamble = ENV_EXAMPLE.slice(Math.max(0, idx - 400), idx)
    expect(/production[\s\S]*(leave|blank|unset)/i.test(preamble)).toBe(true)
  })
})

describe("revalidatePath targets (no redirect stubs)", () => {
  // Legacy routes kept only as redirects (redesign spec §8-A4 / CRM C4b).
  // Revalidating them refreshes nothing the owner can see.
  const REDIRECT_STUBS = new Set([
    "/agents",
    "/agent",
    "/leads",
    "/chat",
    "/recovery",
    "/schedule",
  ])

  it("no server action revalidates a legacy redirect-stub route", () => {
    const actionsDir = join("src", "app", "actions")
    const offenders: string[] = []
    for (const file of readdirSync(actionsDir)) {
      if (!file.endsWith(".ts")) continue
      const source = readFileSync(join(actionsDir, file), "utf8")
      for (const match of source.matchAll(
        /revalidatePath\(\s*["'`]([^"'`]+)["'`]/g
      )) {
        if (REDIRECT_STUBS.has(match[1])) {
          offenders.push(`${file}: revalidatePath("${match[1]}")`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

describe("error surfaces", () => {
  const BOUNDARIES = [
    "src/app/error.tsx",
    "src/app/global-error.tsx",
    "src/app/(dashboard)/error.tsx",
  ]

  it("all error boundaries exist and report to Sentry", () => {
    for (const path of BOUNDARIES) {
      expect(existsSync(path), `${path} missing`).toBe(true)
      const source = readFileSync(path, "utf8")
      expect(
        source.includes("Sentry.captureException"),
        `${path} does not report to Sentry`
      ).toBe(true)
    }
  })

  it("not-found surfaces exist at root and dashboard level", () => {
    expect(existsSync("src/app/not-found.tsx")).toBe(true)
    expect(existsSync("src/app/(dashboard)/not-found.tsx")).toBe(true)
  })

  it("dashboard error boundary offers recovery (reset) and stays a client component", () => {
    const source = readFileSync("src/app/(dashboard)/error.tsx", "utf8")
    expect(source.startsWith('"use client"')).toBe(true)
    expect(source).toContain("reset()")
  })
})

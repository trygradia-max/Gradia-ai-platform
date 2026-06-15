import { describe, it, expect } from "vitest"

import {
  buildAuthorizeUrl,
  nameToCustomerInput,
  type HousecallProJobInput,
} from "@/lib/housecallpro"
import { pushBookingToCrm, pushLeadToCrm } from "@/lib/crm-provider"

/**
 * Tier 1 — pure, deterministic, no API. Locks the Housecall Pro CRM
 * integration's code-level contracts and the crm-provider seam wiring.
 * Live push behavior (real OAuth + REST) is exercised only with
 * credentials; these guard the parts that must never silently drift:
 * name splitting, the authorize URL shape, and the seam's public API.
 */

describe("nameToCustomerInput — HCP requires first/last OR company", () => {
  it("splits a two-part name into first + last", () => {
    expect(nameToCustomerInput("Sam Rivera", "fallback")).toEqual({
      firstName: "Sam",
      lastName: "Rivera",
      company: null,
    })
  })

  it("keeps a single token as first name only", () => {
    expect(nameToCustomerInput("Sam", "fallback")).toEqual({
      firstName: "Sam",
      lastName: null,
      company: null,
    })
  })

  it("falls back to company for an unnamed lead", () => {
    expect(nameToCustomerInput("", "+15551234567")).toEqual({
      firstName: null,
      lastName: null,
      company: "+15551234567",
    })
  })

  it("uses a generic company label when no fallback is given", () => {
    expect(nameToCustomerInput(null, "")).toEqual({
      firstName: null,
      lastName: null,
      company: "Lead",
    })
  })

  it("treats a 3+ part name as first + remainder", () => {
    expect(nameToCustomerInput("Mary Jane Watson", "fallback")).toEqual({
      firstName: "Mary",
      lastName: "Jane Watson",
      company: null,
    })
  })
})

describe("buildAuthorizeUrl — OAuth redirect shape", () => {
  it("carries client_id, redirect_uri, response_type, and the CSRF state", () => {
    process.env.HOUSECALLPRO_CLIENT_ID = "hcp_test_client"
    const url = new URL(
      buildAuthorizeUrl({
        redirectUri: "https://shop.example.com/api/housecallpro/auth/callback",
        state: "nonce-123",
      })
    )
    expect(url.origin + url.pathname).toBe(
      "https://api.housecallpro.com/oauth/authorize"
    )
    expect(url.searchParams.get("client_id")).toBe("hcp_test_client")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("state")).toBe("nonce-123")
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://shop.example.com/api/housecallpro/auth/callback"
    )
  })

  it("throws when the server isn't configured (fail loud, never silent)", () => {
    delete process.env.HOUSECALLPRO_CLIENT_ID
    expect(() =>
      buildAuthorizeUrl({ redirectUri: "https://x/cb", state: "s" })
    ).toThrow(/HOUSECALLPRO_CLIENT_ID/)
  })
})

describe("crm-provider seam — vendor-neutral public API", () => {
  it("exposes both push entry points the approval path depends on", () => {
    expect(typeof pushLeadToCrm).toBe("function")
    expect(typeof pushBookingToCrm).toBe("function")
  })

  it("type-checks the booking push shape callers must satisfy", () => {
    // Compile-time guard: the seam input is the superset both Jobber and
    // Housecall Pro push functions accept. A drift here breaks approvals.ts.
    const job: HousecallProJobInput = {
      customerId: "cus_1",
      description: "Ceramic coating — Sam Rivera",
      scheduledAt: "2026-07-01T15:00:00.000Z",
    }
    expect(job.customerId).toBe("cus_1")
  })
})

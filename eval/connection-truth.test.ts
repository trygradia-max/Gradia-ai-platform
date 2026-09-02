import { afterEach, describe, expect, it, vi } from "vitest"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Mail } from "lucide-react"

/**
 * UX-001 — connection truth.
 *
 * One predicate set for "is this integration connected?" (`connectionStatus`),
 * consumed by Home (`summarizeChannels`), the Settings tiles, the Email card,
 * onboarding, BI and the agent prerequisites. Locks:
 *   1. the predicate matrix, including the founder repro shape (credentials
 *      on file, display email null) and its inverse (stale display email,
 *      no credentials);
 *   2. Home/Settings parity — the two surfaces derive from the same row and
 *      can never disagree;
 *   3. identity never leaks into truth, and tenant rows never mix (pure
 *      per-row derivation);
 *   4. `integrationAvailability()` — server env presence, both halves of a
 *      credential pair required;
 *   5. the ConnectionTile's three rendered states: CONNECTED (✓ + Manage),
 *      NOT CONNECTED (Connect), NOT AVAILABLE (honest line, no Connect).
 */

// The tile's popup button and the channel module's server helpers reach into
// Next runtime APIs; neither is under test here.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, replace() {}, push() {} }),
}))
vi.mock("@/lib/shop", () => ({
  requireShop: async () => ({ id: "shop-a", name: "Shop A" }),
  getOptionalShop: async () => null,
}))
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }))

import { ConnectionTile } from "@/components/gradia/connection-tile"
import { summarizeChannels } from "@/lib/data/channels"
import {
  connectionStatus,
  integrationAvailability,
  type ConnectionShopFields,
} from "@/lib/data/connections"
import { STRINGS } from "@/lib/strings"

const EMPTY: ConnectionShopFields = {
  aurinko_access_token_enc: null,
  aurinko_account_id: null,
  aurinko_account_email: null,
  twilio_phone_number: null,
  vapi_assistant_id: null,
  jobber_access_token_enc: null,
  jobber_account_id: null,
  jobber_account_name: null,
}

/** The founder repro (2026-09-01): Gmail connected, display email never
 *  returned by the provider — Home said Live, Settings said Connect. */
const FOUNDER_REPRO: ConnectionShopFields = {
  ...EMPTY,
  aurinko_access_token_enc: "enc:v1:…",
  aurinko_account_id: 4242,
  aurinko_account_email: null,
}

const FULLY_WIRED: ConnectionShopFields = {
  aurinko_access_token_enc: "enc:v1:…",
  aurinko_account_id: 4242,
  aurinko_account_email: "shop@gmail.com",
  twilio_phone_number: "+16175550100",
  vapi_assistant_id: "asst_123",
  jobber_access_token_enc: "enc:v1:…",
  jobber_account_id: "acct_1",
  jobber_account_name: "Shine Co",
}

describe("connectionStatus — one predicate set", () => {
  it("founder repro: credentials on file + null display email → connected, identity null", () => {
    const s = connectionStatus(FOUNDER_REPRO)
    expect(s.email).toEqual({ connected: true, identity: null })
    expect(s.calendar).toEqual({ connected: true, identity: "Google Calendar" })
  })

  it("inverse: a stale display email with no credentials is NOT connected", () => {
    const s = connectionStatus({ ...EMPTY, aurinko_account_email: "old@gmail.com" })
    expect(s.email.connected).toBe(false)
    expect(s.calendar.connected).toBe(false)
    // Identity is still reported (display only) — never the predicate.
    expect(s.email.identity).toBe("old@gmail.com")
  })

  it("half a credential pair is not a connection", () => {
    expect(
      connectionStatus({ ...EMPTY, aurinko_access_token_enc: "enc" }).email.connected
    ).toBe(false)
    expect(connectionStatus({ ...EMPTY, aurinko_account_id: 1 }).email.connected).toBe(
      false
    )
  })

  it("calendar can never be on while email is off (shared grant)", () => {
    for (const row of [EMPTY, FOUNDER_REPRO, FULLY_WIRED]) {
      const s = connectionStatus(row)
      expect(s.calendar.connected).toBe(s.email.connected)
    }
  })

  it("sms / voice / crm read credentials, identity separately", () => {
    const s = connectionStatus(FULLY_WIRED)
    expect(s.sms).toEqual({ connected: true, identity: "+16175550100" })
    expect(s.voice).toEqual({ connected: true, identity: null })
    expect(s.crm).toEqual({ connected: true, identity: "Shine Co" })

    // CRM: token is the truth; a leftover account name is not.
    expect(
      connectionStatus({ ...EMPTY, jobber_account_name: "Shine Co" }).crm
    ).toEqual({ connected: false, identity: "Shine Co" })
    expect(
      connectionStatus({ ...EMPTY, jobber_access_token_enc: "enc" }).crm
    ).toEqual({ connected: true, identity: null })
  })

  it("whitespace-only values are absent; null / undefined rows are all off", () => {
    const s = connectionStatus({
      ...EMPTY,
      twilio_phone_number: "   ",
      vapi_assistant_id: "",
      aurinko_access_token_enc: " ",
      aurinko_account_id: 1,
    })
    expect(s.sms.connected).toBe(false)
    expect(s.voice.connected).toBe(false)
    expect(s.email.connected).toBe(false)
    for (const row of [null, undefined]) {
      const off = connectionStatus(row)
      for (const key of ["email", "calendar", "sms", "voice", "crm"] as const) {
        expect(off[key]).toEqual({ connected: false, identity: null })
      }
    }
  })

  it("is pure per row — shop A's credentials never colour shop B", () => {
    const a = connectionStatus(FULLY_WIRED)
    const b = connectionStatus(EMPTY)
    expect(a.email.connected).toBe(true)
    expect(b.email.connected).toBe(false)
    // Re-deriving A after B is unchanged (no module state).
    expect(connectionStatus(FULLY_WIRED)).toEqual(a)
  })
})

describe("Home / Settings parity — both surfaces derive from connectionStatus()", () => {
  const rows: Record<string, ConnectionShopFields> = {
    empty: EMPTY,
    founderRepro: FOUNDER_REPRO,
    fullyWired: FULLY_WIRED,
    staleEmailOnly: { ...EMPTY, aurinko_account_email: "old@gmail.com" },
    smsOnly: { ...EMPTY, twilio_phone_number: "+16175550100" },
    voiceOnly: { ...EMPTY, vapi_assistant_id: "asst_1" },
  }

  for (const [name, row] of Object.entries(rows)) {
    it(`${name}: Home channel statuses equal the tile predicates`, () => {
      const truth = connectionStatus(row)
      const home = new Map(summarizeChannels(row).map((c) => [c.id, c.status]))
      expect(home.get("email") === "connected").toBe(truth.email.connected)
      expect(home.get("calendar") === "connected").toBe(truth.calendar.connected)
      expect(home.get("sms") === "connected").toBe(truth.sms.connected)
      expect(home.get("voice") === "connected").toBe(truth.voice.connected)
    })
  }

  it("founder repro renders Connected on the Settings tile AND Live on Home", () => {
    const truth = connectionStatus(FOUNDER_REPRO)
    const home = summarizeChannels(FOUNDER_REPRO).find((c) => c.id === "email")
    const tile = renderToStaticMarkup(
      React.createElement(ConnectionTile, {
        icon: Mail,
        name: "Email",
        description: "Reads leads and drafts replies for our approval.",
        connected: truth.email.connected,
        available: true,
        connectedLabel:
          truth.email.identity ?? STRINGS.connections.identityFallback.email,
        connectHref: "/api/aurinko/auth/start",
        popup: true,
        manageHref: "#email",
      })
    )
    expect(home?.status).toBe("connected")
    expect(tile).toContain('data-connection-state="connected"')
    expect(tile).toContain("Gmail") // identity fallback, never a blank
    expect(tile).not.toMatch(/>Connect</)
    expect(tile).not.toContain("Connect Gmail")
  })

  it("Home copy names products owners know — no vendor plumbing", () => {
    const text = JSON.stringify(summarizeChannels(EMPTY))
    expect(text).not.toMatch(/Aurinko|Twilio|Vapi/)
  })
})

describe("integrationAvailability — server env presence, pairs required", () => {
  const NAMES = [
    "AURINKO_CLIENT_ID",
    "AURINKO_CLIENT_SECRET",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "VAPI_API_KEY",
    "JOBBER_CLIENT_ID",
    "JOBBER_CLIENT_SECRET",
  ]
  afterEach(() => vi.unstubAllEnvs())

  it("nothing set → nothing available", () => {
    for (const n of NAMES) vi.stubEnv(n, "")
    expect(integrationAvailability()).toEqual({
      email: false,
      calendar: false,
      sms: false,
      voice: false,
      crm: false,
    })
  })

  it("half a pair is not available; a full pair is; calendar follows email", () => {
    for (const n of NAMES) vi.stubEnv(n, "")
    vi.stubEnv("AURINKO_CLIENT_ID", "id")
    expect(integrationAvailability().email).toBe(false)
    vi.stubEnv("AURINKO_CLIENT_SECRET", "secret")
    const a = integrationAvailability()
    expect(a.email).toBe(true)
    expect(a.calendar).toBe(true)
    vi.stubEnv("VAPI_API_KEY", "  ")
    expect(integrationAvailability().voice).toBe(false)
    vi.stubEnv("VAPI_API_KEY", "key")
    expect(integrationAvailability().voice).toBe(true)
  })
})

function tile(overrides: Partial<Parameters<typeof ConnectionTile>[0]>) {
  return renderToStaticMarkup(
    React.createElement(ConnectionTile, {
      icon: Mail,
      name: "SMS",
      description: "Catches every text and drafts a reply in a minute.",
      connected: false,
      connectHref: "#sms",
      manageHref: "#sms",
      ...overrides,
    })
  )
}

describe("ConnectionTile — three honest states", () => {
  it("NOT AVAILABLE: names what is missing, offers no Connect, never says coming soon", () => {
    const html = tile({
      available: false,
      unavailableReason: STRINGS.connections.notAvailableReason.sms,
    })
    expect(html).toContain('data-connection-state="unavailable"')
    expect(html).toContain(STRINGS.connections.notAvailable)
    expect(html).toContain("Texting isn&#x27;t set up for this workspace yet")
    expect(html).not.toMatch(/>Connect</)
    expect(html).not.toMatch(/coming soon/i)
    expect(html).not.toMatch(/TWILIO_|AURINKO_|VAPI_|JOBBER_/)
  })

  it("NOT CONNECTED: a Connect control (link, or popup button)", () => {
    expect(tile({ available: true })).toMatch(/>Connect</)
    expect(tile({ available: true, popup: true })).toMatch(/>Connect</)
    expect(tile({ available: true })).toContain('data-connection-state="disconnected"')
  })

  it("CONNECTED: ✓ + identity + Manage, no Connect", () => {
    const html = tile({
      connected: true,
      connectedLabel: "+1 (617) 555-0100",
      connectedDetail: "Texting back",
    })
    expect(html).toContain('data-connection-state="connected"')
    expect(html).toContain(STRINGS.connections.connected)
    expect(html).toContain("+1 (617) 555-0100 · Texting back")
    expect(html).toContain(STRINGS.connections.manage)
    expect(html).not.toMatch(/>Connect</)
  })

  it("help renders as a keyboard-reachable ⓘ with a narrator accessible name", () => {
    const html = tile({ help: STRINGS.help.settings.sms })
    expect(html).toContain('aria-label="About SMS"')
    expect(html).toMatch(/<button[^>]*aria-label="About SMS"/)
  })
})

import { createHmac } from "node:crypto"
import { describe, it, expect, beforeAll, afterAll } from "vitest"

import { verifyTwilioSignature } from "@/lib/twilio"
import { verifyStripeSignature } from "@/lib/stripe"
import { verifyAurinkoSignature } from "@/lib/aurinko"
import { verifySlackSignature } from "@/lib/slack"
import { verifyMetaSignature } from "@/lib/meta"

/**
 * Tier 1 (pure) — webhook signature verification. Every inbound webhook is a
 * security boundary: a verifier that silently starts accepting bad signatures
 * is a remote-write hole, and nothing crashes to tell you. Pure HMAC, so these
 * run free on every change. We forge valid signatures with the same scheme,
 * then assert tamper / wrong-secret / replay / missing-header all reject.
 */

const SECRETS: Record<string, string> = {
  TWILIO_AUTH_TOKEN: "twilio_test_token",
  STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
  AURINKO_SIGNING_SECRET: "aurinko_test_secret",
  SLACK_SIGNING_SECRET: "slack_test_secret",
  META_APP_SECRET: "meta_test_secret",
}

const saved: Record<string, string | undefined> = {}
beforeAll(() => {
  for (const [k, v] of Object.entries(SECRETS)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
})
afterAll(() => {
  for (const k of Object.keys(SECRETS)) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

const nowSec = () => Math.floor(Date.now() / 1000)
const STALE = () => nowSec() - 100_000 // well outside any replay window

describe("Twilio (HMAC-SHA1 over url + sorted form pairs)", () => {
  const url = "https://app.test/api/twilio/sms"
  const form = new URLSearchParams({
    From: "+15035550133",
    To: "+15035550111",
    Body: "do you do ceramic?",
  })
  const sign = (u: string, f: URLSearchParams) => {
    let s = u
    for (const k of [...f.keys()].sort()) s += k + (f.get(k) ?? "")
    return createHmac("sha1", SECRETS.TWILIO_AUTH_TOKEN).update(s).digest("base64")
  }

  it("accepts a valid signature", () => {
    expect(verifyTwilioSignature({ url, form, signature: sign(url, form) })).toBe(true)
  })
  it("rejects a tampered body", () => {
    const sig = sign(url, form)
    const tampered = new URLSearchParams(form)
    tampered.set("Body", "free money")
    expect(verifyTwilioSignature({ url, form: tampered, signature: sig })).toBe(false)
  })
  it("rejects a signature made with the wrong token", () => {
    const bad = createHmac("sha1", "wrong").update(url).digest("base64")
    expect(verifyTwilioSignature({ url, form, signature: bad })).toBe(false)
  })
  it("rejects a missing signature", () => {
    expect(verifyTwilioSignature({ url, form, signature: null })).toBe(false)
  })
})

describe("Stripe (HMAC-SHA256 over `t.body`, with replay window)", () => {
  const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" })
  const header = (ts: number, secret = SECRETS.STRIPE_WEBHOOK_SECRET, b = body) => {
    const v1 = createHmac("sha256", secret).update(`${ts}.${b}`).digest("hex")
    return `t=${ts},v1=${v1}`
  }

  it("accepts a valid, fresh signature", () => {
    expect(verifyStripeSignature({ rawBody: body, signature: header(nowSec()) })).toBe(true)
  })
  it("rejects a tampered body", () => {
    const sig = header(nowSec())
    expect(verifyStripeSignature({ rawBody: body + " ", signature: sig })).toBe(false)
  })
  it("rejects a replayed (stale-timestamp) signature", () => {
    expect(verifyStripeSignature({ rawBody: body, signature: header(STALE()) })).toBe(false)
  })
  it("rejects the wrong secret and a missing header", () => {
    expect(verifyStripeSignature({ rawBody: body, signature: header(nowSec(), "whsec_wrong") })).toBe(false)
    expect(verifyStripeSignature({ rawBody: body, signature: null })).toBe(false)
  })
})

describe("Aurinko (HMAC-SHA256 over `v0:ts:body`, 5-min window)", () => {
  const body = JSON.stringify({ subscription: 1, notifications: [] })
  const sign = (ts: number, b = body, secret = SECRETS.AURINKO_SIGNING_SECRET) =>
    createHmac("sha256", secret).update(`v0:${ts}:${b}`).digest("hex")

  it("accepts a valid, fresh signature", () => {
    const ts = nowSec()
    expect(verifyAurinkoSignature({ rawBody: body, timestamp: String(ts), signature: sign(ts) })).toBe(true)
  })
  it("rejects a tampered body", () => {
    const ts = nowSec()
    expect(verifyAurinkoSignature({ rawBody: body + "x", timestamp: String(ts), signature: sign(ts) })).toBe(false)
  })
  it("rejects a replayed (stale-timestamp) signature", () => {
    const ts = STALE()
    expect(verifyAurinkoSignature({ rawBody: body, timestamp: String(ts), signature: sign(ts) })).toBe(false)
  })
  it("rejects a missing timestamp or signature", () => {
    expect(verifyAurinkoSignature({ rawBody: body, timestamp: null, signature: sign(nowSec()) })).toBe(false)
    expect(verifyAurinkoSignature({ rawBody: body, timestamp: String(nowSec()), signature: null })).toBe(false)
  })
})

describe("Slack (v0= HMAC-SHA256 over `v0:ts:body`, 5-min window)", () => {
  const body = "payload=%7B%22type%22%3A%22block_actions%22%7D"
  const sign = (ts: number, b = body, secret = SECRETS.SLACK_SIGNING_SECRET) =>
    "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${b}`).digest("hex")

  it("accepts a valid, fresh signature", () => {
    const ts = nowSec()
    expect(verifySlackSignature({ rawBody: body, timestamp: String(ts), signature: sign(ts) })).toBe(true)
  })
  it("rejects a tampered body", () => {
    const ts = nowSec()
    expect(verifySlackSignature({ rawBody: "payload=evil", timestamp: String(ts), signature: sign(ts) })).toBe(false)
  })
  it("rejects a replayed (stale-timestamp) signature", () => {
    const ts = STALE()
    expect(verifySlackSignature({ rawBody: body, timestamp: String(ts), signature: sign(ts) })).toBe(false)
  })
  it("rejects a missing signature", () => {
    expect(verifySlackSignature({ rawBody: body, timestamp: String(nowSec()), signature: null })).toBe(false)
  })
})

describe("Meta (sha256= HMAC over raw body)", () => {
  const body = JSON.stringify({ object: "page", entry: [] })
  const sign = (b = body, secret = SECRETS.META_APP_SECRET) =>
    "sha256=" + createHmac("sha256", secret).update(b).digest("hex")

  it("accepts a valid signature", () => {
    expect(verifyMetaSignature({ rawBody: body, signature: sign() })).toBe(true)
  })
  it("rejects a tampered body", () => {
    expect(verifyMetaSignature({ rawBody: body + "!", signature: sign() })).toBe(false)
  })
  it("rejects the wrong scheme prefix (sha1=)", () => {
    const hex = createHmac("sha256", SECRETS.META_APP_SECRET).update(body).digest("hex")
    expect(verifyMetaSignature({ rawBody: body, signature: `sha1=${hex}` })).toBe(false)
  })
  it("rejects a missing signature", () => {
    expect(verifyMetaSignature({ rawBody: body, signature: null })).toBe(false)
  })
})

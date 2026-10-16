import { describe, expect, it } from "vitest"
import { callsReadiness, channelReadiness, configuredChannels, emailReadiness, metaReadiness, textingReadiness, type ReadinessShop } from "@/lib/channel-readiness"
import { connectionStatus } from "@/lib/data/connections"

const shop = (patch: Partial<ReadinessShop> = {}): ReadinessShop => ({
  twilio_phone_number: null, gradia_number_e164: null, a2p_status: null, byo_sms_verified: false,
  vapi_assistant_id: null, vapi_phone_number_id: null, voice_test_called_at: null, voice_addon: false,
  aurinko_access_token_enc: null, aurinko_account_id: null, aurinko_subscription_id: null,
  ...patch,
} as ReadinessShop)
const state = (r: { state: string; reasons: string[] }) => [r.state, ...r.reasons]
const GRADIA = "+15550008888"

describe("texting readiness follows what actually gates a send", () => {
  it.each([
    [{}, ["not_set_up", "no_number"]],
    [{ twilio_phone_number: GRADIA, gradia_number_e164: GRADIA, a2p_status: "unregistered" }, ["action_needed", "registration_required"]],
    [{ twilio_phone_number: GRADIA, gradia_number_e164: GRADIA, a2p_status: "pending" }, ["in_progress", "registration_pending"]],
    [{ twilio_phone_number: GRADIA, gradia_number_e164: GRADIA, a2p_status: "rejected" }, ["action_needed", "registration_rejected"]],
    [{ twilio_phone_number: GRADIA, gradia_number_e164: GRADIA, a2p_status: "approved" }, ["ready"]],
    [{ twilio_phone_number: "+15550009999", byo_sms_verified: false }, ["action_needed", "byo_registration_unconfirmed"]],
    [{ twilio_phone_number: "+15550009999", byo_sms_verified: true }, ["ready"]],
  ] as const)("%j → %j", (patch, expected) => {
    expect(state(textingReadiness(shop(patch as Partial<ReadinessShop>), true))).toEqual(expected)
  })
})

describe("calls readiness requires number, assistant, test call and the Voice add-on", () => {
  it("names every missing piece", () => {
    expect(state(callsReadiness(shop(), true))).toEqual(["not_set_up", "no_voice_number", "no_assistant", "no_test_call"])
    expect(state(callsReadiness(shop({ vapi_assistant_id: "asst", voice_addon: true }), true))).toEqual(["action_needed", "no_voice_number", "no_test_call"])
    expect(state(callsReadiness(shop({ vapi_assistant_id: "asst", vapi_phone_number_id: "pn", voice_test_called_at: "2026-10-01T00:00:00Z" }), true))).toEqual(["action_needed", "voice_addon_inactive"])
    expect(state(callsReadiness(shop({ vapi_assistant_id: "asst", vapi_phone_number_id: "pn", voice_test_called_at: "2026-10-01T00:00:00Z", voice_addon: true }), true))).toEqual(["ready"])
  })
})

describe("email and Meta readiness", () => {
  it("email sends without an inbound subscription only as a limited channel", () => {
    expect(state(emailReadiness(shop(), true))).toEqual(["not_set_up", "no_mailbox"])
    expect(state(emailReadiness(shop({ aurinko_access_token_enc: "enc", aurinko_account_id: 1 as never }), true))).toEqual(["limited", "inbound_not_subscribed"])
    expect(state(emailReadiness(shop({ aurinko_access_token_enc: "enc", aurinko_account_id: 1 as never, aurinko_subscription_id: "sub" }), true))).toEqual(["ready"])
  })
  it("Meta is never 'ready': the page subscription can't be confirmed yet", () => {
    expect(state(metaReadiness(0, true))).toEqual(["not_set_up", "no_page_connected"])
    expect(state(metaReadiness(2, true))).toEqual(["limited", "page_subscription_unverified"])
  })
  it("an unconfigured deployment reports every channel unavailable, whatever the shop has", () => {
    const all = channelReadiness(shop({ twilio_phone_number: GRADIA, gradia_number_e164: GRADIA, a2p_status: "approved" }), {
      metaPageBindings: 3, configured: { calls: false, texting: false, email: false, meta: false },
    })
    expect(Object.values(all).map(r => r.state)).toEqual(["unavailable", "unavailable", "unavailable", "unavailable"])
    expect(configuredChannels({})).toEqual({ calls: false, texting: false, email: false, meta: false })
    expect(configuredChannels({ TWILIO_ACCOUNT_SID: "x", TWILIO_AUTH_TOKEN: "y" })).toMatchObject({ texting: true, calls: false })
  })
})

describe("where the old single 'connected' flag overstated readiness", () => {
  it.each([
    ["texting: number with registration pending", { twilio_phone_number: GRADIA, gradia_number_e164: GRADIA, a2p_status: "pending" }, "sms", "texting"],
    ["texting: own number never confirmed", { twilio_phone_number: "+15550009999" }, "sms", "texting"],
    ["calls: assistant only", { vapi_assistant_id: "asst" }, "voice", "calls"],
    ["email: mailbox without inbound subscription", { aurinko_access_token_enc: "enc", aurinko_account_id: 1 as never }, "email", "email"],
  ] as const)("%s", (_label, patch, oldKey, channel) => {
    const s = shop(patch as Partial<ReadinessShop>)
    expect(connectionStatus(s as never)[oldKey].connected).toBe(true)
    const now = channelReadiness(s, { metaPageBindings: 0, configured: { calls: true, texting: true, email: true, meta: true } })[channel]
    expect(now.state).not.toBe("ready")
  })
})

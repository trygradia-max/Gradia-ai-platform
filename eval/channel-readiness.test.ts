import { describe, expect, it } from "vitest"
import { callsReadiness, channelReadiness, configuredChannels, emailReadiness, metaReadiness, readinessStatusLabel, textingReadiness, type ReadinessShop } from "@/lib/channel-readiness"
import { connectionStatus } from "@/lib/data/connections"

const shop = (patch: Partial<ReadinessShop> = {}): ReadinessShop => ({
  twilio_phone_number: null, gradia_number_e164: null, a2p_status: null, byo_sms_verified: false,
  twilio_account_sid_enc: null, twilio_auth_token_enc: null,
  vapi_assistant_id: null, vapi_phone_number_id: null, voice_test_called_at: null, voice_addon: false,
  aurinko_access_token_enc: null, aurinko_account_id: null, aurinko_subscription_id: null,
  ...patch,
} as ReadinessShop)
const state = (r: { state: string; reasons: string[] }) => [r.state, ...r.reasons]
const GRADIA = "+15550008888"
const OWN = "+15550009999"
const OWN_ACCOUNT = { twilio_account_sid_enc: "enc-sid", twilio_auth_token_enc: "enc-token" }

describe("texting readiness follows what actually gates a send", () => {
  it.each([
    [{}, ["not_set_up", "no_number"]],
    [{ twilio_phone_number: GRADIA, gradia_number_e164: GRADIA, a2p_status: "unregistered" }, ["action_needed", "registration_required"]],
    [{ twilio_phone_number: GRADIA, gradia_number_e164: GRADIA, a2p_status: "pending" }, ["in_progress", "registration_pending"]],
    [{ twilio_phone_number: GRADIA, gradia_number_e164: GRADIA, a2p_status: "rejected" }, ["action_needed", "registration_rejected"]],
    [{ twilio_phone_number: GRADIA, gradia_number_e164: GRADIA, a2p_status: "approved" }, ["ready"]],
    [{ twilio_phone_number: OWN, ...OWN_ACCOUNT, byo_sms_verified: false }, ["action_needed", "byo_registration_unconfirmed"]],
    [{ twilio_phone_number: OWN, ...OWN_ACCOUNT, byo_sms_verified: true }, ["ready_to_test", "byo_owner_attested"]],
    [{ twilio_phone_number: OWN, byo_sms_verified: false }, ["action_needed", "not_own_account"]],
    [{ twilio_phone_number: OWN, byo_sms_verified: true }, ["action_needed", "not_own_account"]],
    [{ twilio_phone_number: OWN, twilio_account_sid_enc: "enc-sid", byo_sms_verified: true }, ["action_needed", "not_own_account"]],
    [{ twilio_phone_number: OWN, twilio_auth_token_enc: "enc-token", byo_sms_verified: true }, ["action_needed", "not_own_account"]],
    [{ twilio_phone_number: OWN, twilio_account_sid_enc: " ", twilio_auth_token_enc: "enc-token", byo_sms_verified: true }, ["action_needed", "not_own_account"]],
    [{ twilio_phone_number: OWN, gradia_number_e164: GRADIA, a2p_status: "approved", ...OWN_ACCOUNT, byo_sms_verified: true }, ["ready_to_test", "byo_owner_attested"]],
  ] as const)("%j → %j", (patch, expected) => {
    expect(state(textingReadiness(shop(patch as Partial<ReadinessShop>), true))).toEqual(expected)
  })
})

describe("an own number is never texting 'ready' (handoff: a checked setting alone is never Ready)", () => {
  // Every combination of attestation, credentials and Gradia-number A2P state that
  // leaves a non-Gradia number sending.
  const combos = [true, false].flatMap(verified =>
    [null, "enc-sid"].flatMap(sid => [null, "enc-token"].flatMap(token =>
      [null, "pending", "approved"].map(a2p => ({
        twilio_phone_number: OWN, gradia_number_e164: GRADIA, a2p_status: a2p,
        byo_sms_verified: verified, twilio_account_sid_enc: sid, twilio_auth_token_enc: token,
      })))))
  it.each(combos)("%j", (patch) => {
    const r = textingReadiness(shop(patch as Partial<ReadinessShop>), true)
    expect(r.state).not.toBe("ready")
    expect(readinessStatusLabel(r)).not.toBe("Ready")
    const ownAccount = Boolean(patch.twilio_account_sid_enc && patch.twilio_auth_token_enc)
    if (!ownAccount) expect(r.reasons).toEqual(["not_own_account"])
  })
  it("the attested state maps to 'Ready to test', matching byoSmsSetupStatus('confirmed') in PR #93", () => {
    expect(readinessStatusLabel(textingReadiness(shop({ twilio_phone_number: OWN, ...OWN_ACCOUNT, byo_sms_verified: true }), true))).toBe("Ready to test")
    expect(readinessStatusLabel(textingReadiness(shop({ twilio_phone_number: OWN, ...OWN_ACCOUNT }), true))).toBe("Needs your details")
    expect(readinessStatusLabel(textingReadiness(shop({ twilio_phone_number: OWN, byo_sms_verified: true }), true))).toBe("Needs your details")
  })
})

describe("readiness states map onto the handoff status vocabulary", () => {
  it.each([
    [{ state: "unavailable", reasons: ["server_not_configured"] }, null],
    [{ state: "not_set_up", reasons: ["no_number"] }, "Not set up"],
    [{ state: "in_progress", reasons: ["registration_pending"] }, "Submitted for review"],
    [{ state: "action_needed", reasons: ["registration_required"] }, "Needs your details"],
    [{ state: "action_needed", reasons: ["registration_rejected"] }, "Needs a correction"],
    [{ state: "action_needed", reasons: ["not_own_account"] }, "Needs your details"],
    [{ state: "limited", reasons: ["inbound_not_subscribed"] }, "Ready to test"],
    [{ state: "ready_to_test", reasons: ["byo_owner_attested"] }, "Ready to test"],
    [{ state: "ready", reasons: [] }, "Ready"],
  ] as const)("%j → %s", (r, label) => {
    expect(readinessStatusLabel(r as never)).toBe(label)
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
    ["texting: own number never confirmed", { twilio_phone_number: OWN, ...OWN_ACCOUNT }, "sms", "texting"],
    ["texting: own number attested by the owner", { twilio_phone_number: OWN, ...OWN_ACCOUNT, byo_sms_verified: true }, "sms", "texting"],
    ["texting: own number flagged but sent through Gradia's pilot account", { twilio_phone_number: OWN, byo_sms_verified: true }, "sms", "texting"],
    ["calls: assistant only", { vapi_assistant_id: "asst" }, "voice", "calls"],
    ["email: mailbox without inbound subscription", { aurinko_access_token_enc: "enc", aurinko_account_id: 1 as never }, "email", "email"],
  ] as const)("%s", (_label, patch, oldKey, channel) => {
    const s = shop(patch as Partial<ReadinessShop>)
    expect(connectionStatus(s as never)[oldKey].connected).toBe(true)
    const now = channelReadiness(s, { metaPageBindings: 0, configured: { calls: true, texting: true, email: true, meta: true } })[channel]
    expect(now.state).not.toBe("ready")
  })
})

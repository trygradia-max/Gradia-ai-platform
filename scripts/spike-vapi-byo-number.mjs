/**
 * SPIKE (throwaway) — TELEPHONY_VOICE_BUILDER_SPEC build-order step 2.
 * Proves the voice/SMS webhook SPLIT on a BYO Twilio number imported into
 * Vapi (spec §2.3): voice → Vapi, SMS → Gradia. The open question this
 * answers: does Vapi's import overwrite the Twilio messaging webhook?
 *
 * Run:  node --env-file=.env.local scripts/spike-vapi-byo-number.mjs \
 *         --number +16175550142 [--assistant <vapi assistant id>] [--run]
 *
 * Dry-run by default (prints the plan + current webhook state). --run
 * performs the import, re-checks the Twilio messaging webhook, and
 * restores it if Vapi clobbered it.
 * Needs VAPI_API_KEY + TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN; the number
 * must already exist on that Twilio account (use the subaccount spike).
 */

const TW_BASE = "https://api.twilio.com/2010-04-01"
const VAPI_BASE = "https://api.vapi.ai"

const twSid = process.env.TWILIO_ACCOUNT_SID?.trim()
const twToken = process.env.TWILIO_AUTH_TOKEN?.trim()
const vapiKey = process.env.VAPI_API_KEY?.trim()

if (!twSid || !twToken || !vapiKey) {
  console.error(
    "Skipping spike: needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and VAPI_API_KEY in .env.local."
  )
  process.exit(1)
}

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : null
}

const number = opt("--number")
if (!number) {
  console.error("Pass --number +1XXXXXXXXXX (an existing number on this Twilio account).")
  process.exit(1)
}

const twAuth = "Basic " + Buffer.from(`${twSid}:${twToken}`).toString("base64")

async function twilioNumberConfig() {
  const res = await fetch(
    `${TW_BASE}/Accounts/${twSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`,
    { headers: { Authorization: twAuth, Accept: "application/json" } }
  )
  const body = await res.json()
  const n = body.incoming_phone_numbers?.[0]
  if (!n) throw new Error(`Number ${number} not found on account ${twSid}`)
  return { sid: n.sid, voiceUrl: n.voice_url ?? "", smsUrl: n.sms_url ?? "" }
}

async function restoreSmsUrl(numberSid, smsUrl) {
  const res = await fetch(`${TW_BASE}/Accounts/${twSid}/IncomingPhoneNumbers/${numberSid}.json`, {
    method: "POST",
    headers: {
      Authorization: twAuth,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ SmsUrl: smsUrl, SmsMethod: "POST" }).toString(),
  })
  if (!res.ok) throw new Error(`SmsUrl restore failed: ${res.status}`)
}

const before = await twilioNumberConfig()
console.log("BEFORE import:")
console.log(`   voice webhook: ${before.voiceUrl || "(none)"}`)
console.log(`   sms   webhook: ${before.smsUrl || "(none)"}`)

if (!flag("--run")) {
  console.log(
    "\nDry run (pass --run to import). Plan:\n" +
      `   POST ${VAPI_BASE}/phone-number {provider: byo-phone-number, number: ${number}}\n` +
      "   → re-read Twilio config → verify SmsUrl unchanged → restore if clobbered"
  )
  process.exit(0)
}

console.log("\nImporting number into Vapi…")
// Finding (vapi-voice-provider skill, 2026-06-09): provider "twilio" is
// correct for Twilio-account numbers (byo-phone-number = SIP trunks), and
// smsEnabled defaults to TRUE, which overwrites the messaging webhook.
// We pass smsEnabled: false — this spike verifies docs match reality.
const assistantId = opt("--assistant")
const res = await fetch(`${VAPI_BASE}/phone-number`, {
  method: "POST",
  headers: { Authorization: `Bearer ${vapiKey}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    provider: "twilio",
    name: `spike-${number}`,
    number,
    twilioAccountSid: twSid,
    twilioAuthToken: twToken,
    smsEnabled: false,
    ...(assistantId ? { assistantId } : {}),
  }),
})
const imported = await res.json().catch(() => ({}))
if (!res.ok) {
  console.error(`Vapi import failed ${res.status}: ${JSON.stringify(imported).slice(0, 400)}`)
  process.exit(1)
}
console.log(`   ✓ Vapi phone-number id: ${imported.id}`)

const after = await twilioNumberConfig()
console.log("\nAFTER import:")
console.log(`   voice webhook: ${after.voiceUrl || "(none)"}`)
console.log(`   sms   webhook: ${after.smsUrl || "(none)"}`)

if (after.smsUrl === before.smsUrl) {
  console.log("\nSPIKE RESULT: split holds — voice → Vapi, SMS stays on Gradia. ✔")
} else {
  console.log("\nSPIKE RESULT: Vapi OVERWROTE the messaging webhook. Restoring…")
  await restoreSmsUrl(after.sid, before.smsUrl)
  console.log(
    "   ✓ restored. BUILD NOTE: number attachment (spec §2.3) must re-set SmsUrl after every Vapi import."
  )
}
console.log(
  `\nCleanup reminder: delete the Vapi phone-number when done →\n   curl -X DELETE ${VAPI_BASE}/phone-number/${imported.id} -H "Authorization: Bearer $VAPI_API_KEY"`
)

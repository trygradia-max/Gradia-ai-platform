/**
 * SPIKE (throwaway) — TELEPHONY_VOICE_BUILDER_SPEC build-order step 1.
 * Proves the ISV flow against live Twilio: create subaccount → search
 * numbers under it → (optionally) purchase → close the subaccount.
 *
 * Run:  node --env-file=.env.local scripts/spike-twilio-subaccount.mjs [--area 617] [--buy] [--keep]
 *
 * Safe by default: without --buy nothing costs money; without --keep the
 * throwaway subaccount is closed at the end (closing releases any numbers).
 * Needs TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN (master) in .env.local.
 */

const BASE = "https://api.twilio.com/2010-04-01"
const masterSid = process.env.TWILIO_ACCOUNT_SID?.trim()
const masterToken = process.env.TWILIO_AUTH_TOKEN?.trim()

if (!masterSid || !masterToken) {
  console.error(
    "Skipping spike: TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set in .env.local.\n" +
      "Add master-account credentials (server env only — never client code) and re-run."
  )
  process.exit(1)
}

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

async function twilio(method, path, { sid, token, form } = {}) {
  const auth = Buffer.from(`${sid ?? masterSid}:${token ?? masterToken}`).toString("base64")
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(body).slice(0, 300)}`)
  }
  return body
}

const ts = new Date().toISOString().replace(/[:.]/g, "-")
let subSid = null
let subToken = null

try {
  // 1. Subaccount create (master creds)
  console.log("1) Creating throwaway subaccount…")
  const sub = await twilio("POST", "/Accounts.json", {
    form: { FriendlyName: `spike-throwaway-${ts}` },
  })
  subSid = sub.sid
  subToken = sub.auth_token
  console.log(`   ✓ subaccount ${subSid} (status: ${sub.status})`)

  // 2. Number search UNDER the subaccount
  const area = opt("--area", "617")
  console.log(`2) Searching voice+SMS local numbers (area ${area}) under subaccount…`)
  const search = await twilio(
    "GET",
    `/Accounts/${subSid}/AvailablePhoneNumbers/US/Local.json?SmsEnabled=true&VoiceEnabled=true&PageSize=5&AreaCode=${area}`,
    { sid: subSid, token: subToken }
  )
  const numbers = search.available_phone_numbers ?? []
  for (const n of numbers) {
    console.log(`   • ${n.friendly_name}  (${n.locality ?? "?"}, ${n.region ?? "?"})`)
  }
  if (!numbers.length) console.log("   (no results — try another --area)")

  // 3. Optional purchase (~$1.15/mo, released when subaccount closes)
  if (flag("--buy") && numbers.length) {
    console.log(`3) Purchasing ${numbers[0].phone_number} under subaccount…`)
    const bought = await twilio("POST", `/Accounts/${subSid}/IncomingPhoneNumbers.json`, {
      sid: subSid,
      token: subToken,
      form: { PhoneNumber: numbers[0].phone_number },
    })
    console.log(`   ✓ provisioned ${bought.phone_number} (sid ${bought.sid})`)
  } else {
    console.log("3) Skipping purchase (pass --buy to provision the first result)")
  }

  console.log("\nSPIKE RESULT: subaccount-per-shop flow works end-to-end. ✔")
} catch (err) {
  console.error("\nSPIKE FAILED:", err.message)
  process.exitCode = 1
} finally {
  // 4. Cleanup — closing the subaccount releases its numbers
  if (subSid && !flag("--keep")) {
    console.log(`4) Closing throwaway subaccount ${subSid}…`)
    await twilio("POST", `/Accounts/${subSid}.json`, { form: { Status: "closed" } })
      .then(() => console.log("   ✓ closed"))
      .catch((e) => console.error(`   ⚠ close failed — close manually in console: ${e.message}`))
  } else if (subSid) {
    console.log(`4) Keeping subaccount ${subSid} (--keep) — close it manually when done.`)
  }
}

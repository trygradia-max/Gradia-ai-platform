import { randomBytes } from "node:crypto"

// In-memory fake of the Twilio REST endpoints the number lifecycle uses
// (subaccounts, IncomingPhoneNumbers list/create/update/delete), with Basic
// auth checked per account. Install with `vi.stubGlobal("fetch", ...)`;
// anything not on api.twilio.com (the disposable database) passes through.
// Nothing reaches Twilio.

export type FakeNumber = { sid: string; phone_number: string; account: string; sms_url: string | null }
type Fault = "lose_response" | "fail" | null

export const MASTER = { sid: "AC" + "0".repeat(32), token: "synthetic-master-token" }
const hex = (n: number) => randomBytes(n).toString("hex")

export function createTwilioFake() {
  const state = {
    tokens: new Map<string, string>([[MASTER.sid, MASTER.token]]),
    friendly: new Map<string, string>(),
    numbers: new Map<string, FakeNumber>(),
    provisions: 0,
    releases: [] as string[],
    calls: [] as { method: string; account: string | null; path: string }[],
    /** Delay inside the provisioning call, before the number exists. */
    provisionDelay: 0,
    /** Next provision: create the number, then lose the response. */
    provisionFault: null as Fault,
    /** Release faults, consumed one per DELETE. `lose_response`: released,
     *  then the response is lost. `fail`: refused, nothing released. */
    releaseFaults: [] as Fault[],
  }

  const onAccount = (account: string) => [...state.numbers.values()].filter((n) => n.account === account)
  const addAccount = (sid: string, token: string) => state.tokens.set(sid, token)
  const addNumber = (account: string, phone: string) => {
    const n = { sid: "PN" + hex(16), phone_number: phone, account, sms_url: null }
    state.numbers.set(n.sid, n)
    return n
  }
  const reset = () => {
    state.provisions = 0; state.releases = []; state.calls = []
    state.provisionDelay = 0; state.provisionFault = null; state.releaseFaults = []
  }

  async function fetchImpl(realFetch: typeof fetch, input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    if (url.hostname !== "api.twilio.com") return realFetch(input, init)
    const method = (init?.method ?? "GET").toUpperCase()
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "")
    const [user, pass] = Buffer.from(auth.replace(/^Basic /, ""), "base64").toString().split(":")
    const account = url.pathname.match(/\/Accounts\/(AC[0-9a-f]{32})\//)?.[1] ?? null
    state.calls.push({ method, account, path: url.pathname })
    if (state.tokens.get(user) !== pass) return json({ message: "unauthorized" }, 401)

    if (url.pathname.endsWith("/Accounts.json") && method === "POST") {
      const sub = { sid: "AC" + hex(16), auth_token: hex(16) }
      state.tokens.set(sub.sid, sub.auth_token)
      state.friendly.set(sub.sid, new URLSearchParams(String(init?.body)).get("FriendlyName") ?? "")
      return json({ ...sub, friendly_name: state.friendly.get(sub.sid), status: "active" }, 201)
    }
    if (url.pathname.endsWith("/Accounts.json") && method === "GET") {
      const name = url.searchParams.get("FriendlyName")
      return json({ accounts: [...state.friendly].filter(([, n]) => n === name).map(([sid, n]) => ({ sid, auth_token: state.tokens.get(sid), friendly_name: n, status: "active" })) })
    }
    if (account && account !== user) return json({ message: "forbidden" }, 403)
    if (account && url.pathname.endsWith("/IncomingPhoneNumbers.json") && method === "GET") {
      const filter = url.searchParams.get("PhoneNumber")
      return json({ incoming_phone_numbers: onAccount(account).filter((n) => !filter || n.phone_number === filter) })
    }
    if (account && url.pathname.endsWith("/IncomingPhoneNumbers.json") && method === "POST") {
      const body = new URLSearchParams(String(init?.body))
      const phone = body.get("PhoneNumber") ?? ""
      if (state.provisionDelay) await new Promise((r) => setTimeout(r, state.provisionDelay))
      if ([...state.numbers.values()].some((n) => n.phone_number === phone)) return json({ message: "not available" }, 400)
      const n = { sid: "PN" + hex(16), phone_number: phone, account, sms_url: body.get("SmsUrl") }
      state.numbers.set(n.sid, n)
      state.provisions += 1
      if (state.provisionFault === "lose_response") { state.provisionFault = null; throw new TypeError("fetch failed (synthetic lost response)") }
      return json(n, 201)
    }
    const pn = url.pathname.match(/\/IncomingPhoneNumbers\/(PN[0-9a-f]{32})\.json$/)?.[1]
    if (account && pn && method === "POST") {
      const n = state.numbers.get(pn)
      if (!n || n.account !== account) return json({ message: "not found" }, 404)
      n.sms_url = new URLSearchParams(String(init?.body)).get("SmsUrl") ?? n.sms_url
      return json(n)
    }
    if (account && pn && method === "DELETE") {
      const fault = state.releaseFaults.shift() ?? null
      if (fault === "fail") return json({ message: "synthetic outage" }, 503)
      if (state.numbers.get(pn)?.account !== account) return json({ message: "not found" }, 404)
      state.numbers.delete(pn)
      state.releases.push(pn)
      if (fault === "lose_response") throw new TypeError("fetch failed (synthetic lost response)")
      return new Response(null, { status: 204 })
    }
    return json({ message: `unexpected ${method} ${url.pathname}` }, 500)
  }

  return { state, onAccount, addAccount, addNumber, reset, fetchImpl }
}

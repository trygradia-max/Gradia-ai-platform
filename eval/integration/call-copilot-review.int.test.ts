import { randomBytes } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"

import { executeApproval } from "@/lib/approvals"
import { findCallCopilotCallId } from "@/lib/call-copilot/capture-gate"
import { recordCallCopilotEvent } from "@/lib/call-copilot/ingress"
import { proposeFromCall, type ProposeOutcome } from "@/lib/call-copilot/proposals"
import { spanOf } from "@/lib/call-copilot/planner"
import { recordTranscriptSegment, sealEvidence } from "@/lib/call-copilot/transcript"
import { readCallReviewDetail, readCallReviewList } from "@/lib/call-copilot/review-read"
import type { ReviewDetail, ReviewProposal } from "@/lib/call-copilot/review-dto"
import { approveSelected, dismissProposal, type DecideDeps } from "@/lib/call-review/decide"
import { INTEGRATION_WITH_SESSION, anonClient, assertDisposableTarget, cleanup, seedShop, type Seeded } from "./_db"
import { PW, resilientService, transient } from "./_governed-run-fixture"
import { FixtureExtractor, SEGMENTS, cite, f, fullOutput, type FixtureSegment } from "../_call-copilot-fixtures"

/**
 * Call Copilot PR F, against a real (disposable) Postgres: the review read boundary (tenant, role, redaction, bounds),
 * freshness parity with the approval claim, and decisions through the EXISTING executor.
 */
vi.mock("@/lib/telephony-provider", async (original) => ({ ...(await original<typeof import("@/lib/telephony-provider")>()), smsGateForShop: () => ({ allowed: true }) }))
vi.mock("@/lib/twilio", async (original) => ({ ...(await original<typeof import("@/lib/twilio")>()), sendOutboundSms: vi.fn(async () => ({ messageSid: "synthetic-message", status: "queued" })) }))
vi.mock("@/lib/aurinko", async (original) => ({
  ...(await original<typeof import("@/lib/aurinko")>()),
  getAccessTokenForShop: vi.fn(async () => "int-test-token"),
  listCalendarEvents: vi.fn(async () => []),
  createCalendarEvent: vi.fn(async () => ({ id: "ev-int", subject: "x", start: null, end: null, location: null })),
  updateCalendarEventTime: vi.fn(async () => undefined),
  deleteCalendarEvent: vi.fn(async () => undefined),
}))
vi.mock("@/lib/sms-drafter", () => ({ draftBookingConfirmationSms: vi.fn(async () => { throw new Error("drafter skipped in integration test") }) }))
vi.mock("@/lib/crm-provider", () => ({ pushBookingToCrm: vi.fn(async () => undefined), pushLeadToCrm: vi.fn(async () => undefined) }))
vi.mock("@/lib/agent-events", () => ({ dispatchAgentEvent: vi.fn(async () => undefined) }))

const PLAN_NOW = new Date("2026-11-20T12:00:00Z")
const BASE = Date.now() - 30 * 60 * 1000
const at = (s: number) => new Date(BASE + s * 1000).toISOString()
const newProviderCall = () => `CA${randomBytes(16).toString("hex")}`

/** Same transport-noise-only retry as the PR E harness; product refusals are never retried. */
async function session(email: string, password: string): Promise<SupabaseClient> {
  assertDisposableTarget()
  const retryingFetch: typeof fetch = async (input, init) => {
    let last: Response | undefined
    for (let i = 0; i < 4; i++) {
      try {
        const res = await fetch(input, init)
        if (res.status !== 502 && res.status !== 503) return res
        last = res
      } catch (e) {
        if (i === 3) throw e
      }
      await new Promise((r) => setTimeout(r, 200 * (i + 1)))
    }
    return last!
  }
  const client = createClient(process.env.SUPABASE_TEST_URL!, process.env.SUPABASE_TEST_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: retryingFetch } })
  let last = ""
  for (let i = 0; i < 4; i++) {
    const { error } = await client.auth.signInWithPassword({ email, password })
    if (!error) return client
    last = error.message
    if (error.status && error.status < 500 && error.status !== 429) break
    await new Promise((r) => setTimeout(r, 300 * (i + 1)))
  }
  throw new Error(`sign-in failed: ${last}`)
}

type World = { shop: Seeded; owner: SupabaseClient; providerCall: string; callId: string }
let db: SupabaseClient
const extraShops: Seeded[] = []
const ev = (c: string, seq: number, kind: string, s: number, extra: Record<string, unknown> = {}) => ({ providerCallId: c, providerEventId: `${c}-${seq}`, sequence: seq, occurredAt: at(s), kind, ...extra })
async function event(shopId: string, e: Record<string, unknown>) {
  const r = await recordCallCopilotEvent(db, { shopId, provider: "twilio", event: e })
  expect(["recorded", "duplicate"]).toContain(r.outcome)
}
async function consented(shopId: string, c: string) {
  for (const e of [
    ev(c, 1, "call_opened", 0, { routeKind: "gradia_controlled_number" }),
    ev(c, 2, "disclosure_delivered", 1, { party: "operator", disclosureVersion: "d1" }),
    ev(c, 3, "disclosure_delivered", 2, { party: "caller", disclosureVersion: "d1" }),
    ev(c, 4, "consent_granted", 3, { party: "operator", disclosureVersion: "d1", respondsToSequence: 2 }),
    ev(c, 5, "consent_granted", 4, { party: "caller", disclosureVersion: "d1", respondsToSequence: 3 }),
  ]) await event(shopId, e)
}
async function newShop(): Promise<Seeded> {
  const shop = await transient(() => seedShop(db, { password: PW }))
  extraShops.push(shop)
  expect((await db.from("shops").update({ timezone: "America/Los_Angeles" }).eq("id", shop.shopId)).error).toBeNull()
  return shop
}
async function newCall(shop: Seeded, owner: SupabaseClient): Promise<World> {
  const providerCall = newProviderCall()
  await consented(shop.shopId, providerCall)
  const callId = (await findCallCopilotCallId(db, { shopId: shop.shopId, provider: "twilio", providerCallId: providerCall }))!
  return { shop, owner, providerCall, callId }
}
async function newWorld(): Promise<World> {
  const shop = await newShop()
  return newCall(shop, await session(shop.email, PW))
}
const window = (i: number) => ({ startedAt: at(5 + i * 5), endedAt: at(8 + i * 5) })
async function ingest(w: World, segments: FixtureSegment[] = SEGMENTS) {
  for (const s of segments) {
    const r = await recordTranscriptSegment(db, { shopId: w.shop.shopId, callId: w.callId, segment: { providerSegmentId: `${w.providerCall}-s${s.index}`, index: s.index, speaker: s.speaker, text: s.text, ...window(s.index) } })
    expect(r.outcome, `segment ${s.index}`).toBe("recorded")
  }
}
async function sealed(w: World, over: { declaredFinal?: boolean; expected?: number | null } = {}) {
  const r = await sealEvidence(db, { shopId: w.shop.shopId, actorId: w.shop.ownerId, callId: w.callId, declaredFinal: over.declaredFinal ?? false, expectedSegmentCount: over.expected ?? null })
  if (r.outcome !== "sealed" && r.outcome !== "unchanged") throw new Error(`seal: ${JSON.stringify(r)}`)
  return r
}
async function customer(shopId: string, over: Record<string, unknown> = {}) {
  const { data, error } = await db.from("customers").insert({ shop_id: shopId, name: "Jordan Rivera", phone: "+1 555 014 2988", email: null, ...over }).select("*").single()
  if (error) throw new Error(error.message)
  return data as { id: string; updated_at: string }
}
const propose = (w: World, extractor: FixtureExtractor, extra: { evidenceRevisionId: string; knownCustomerId?: string; actorId?: string }): Promise<ProposeOutcome> =>
  proposeFromCall(db, { extractor }, { shopId: w.shop.shopId, actorId: extra.actorId ?? w.shop.ownerId, callId: w.callId, now: PLAN_NOW, ...extra })
const count = async (table: string, shopId: string) => (await db.from(table).select("*", { count: "exact", head: true }).eq("shop_id", shopId)).count ?? 0

/** A call with the full fixture dialogue, a known customer and every proposal kind staged by the owner. */
async function staged(opts: { ended?: boolean; customer?: Record<string, unknown> } = {}) {
  const w = await newWorld()
  await ingest(w)
  if (opts.ended !== false) await event(w.shop.shopId, ev(w.providerCall, 6, "call_ended", 60))
  const rev = await sealed(w, { declaredFinal: opts.ended !== false, expected: SEGMENTS.length })
  const cust = await customer(w.shop.shopId, opts.customer)
  // the booking executor prices and times a booking from the shop's own menu
  expect((await db.from("services").insert({ shop_id: w.shop.shopId, name: "Ceramic coating", price_cents: 90000, duration_minutes: 180 })).error).toBeNull()
  const out = await propose(w, new FixtureExtractor(() => fullOutput()), { evidenceRevisionId: rev.evidenceRevisionId, knownCustomerId: cust.id })
  if (out.status !== "recorded") throw new Error(JSON.stringify(out))
  return { w, rev, cust }
}
async function detailOf(client: SupabaseClient, w: World, revision?: number): Promise<ReviewDetail> {
  const r = await readCallReviewDetail(client, { shopId: w.shop.shopId, callId: w.callId, revision })
  if (r.status !== "ok") {
    const raw = await client.rpc("call_copilot_review_detail", { p_shop: w.shop.shopId, p_call: w.callId, p_revision: revision ?? null })
    const { reviewDetailSchema } = await import("@/lib/call-copilot/review-dto")
    const parsed = reviewDetailSchema.safeParse(raw.data)
    throw new Error(`detail: ${r.status} rpcError=${JSON.stringify(raw.error)} zod=${parsed.success ? "ok" : JSON.stringify(parsed.error.issues.slice(0, 3))}`)
  }
  return r.value
}
const kindOf = (d: ReviewDetail, kind: string): ReviewProposal => d.proposals.find((p) => p.kind === kind)!
const realDeps = (w: World, onApprove?: (actionId: string) => Promise<void>): DecideDeps => ({
  readDetail: () => readCallReviewDetail(w.owner, { shopId: w.shop.shopId, callId: w.callId }),
  approve: async (actionId) => { await onApprove?.(actionId); return executeApproval(w.owner, actionId, w.shop.shopId, { userId: w.shop.ownerId }) },
  dismiss: async () => ({ ok: false, error: "unused" }) as never,
})
const item = (p: ReviewProposal) => ({ proposalId: p.id, reviewToken: p.review_token })
const lastDecision = async (shopId: string, actionId: string) =>
  (await db.from("control_execution_decisions").select("allowed,reason").eq("shop_id", shopId).eq("action_id", actionId).order("id", { ascending: false }).limit(1).single()).data as { allowed: boolean; reason: string }

describe.skipIf(!INTEGRATION_WITH_SESSION)("Call Copilot review (PR F), real Postgres", () => {
  beforeAll(() => { db = resilientService() })
  afterAll(async () => { for (const s of extraShops) await cleanup(db, s).catch(() => undefined) })
  afterEach(() => vi.clearAllMocks())

  // -------------------------------------------------------------------------------------------
  describe("the read boundary", () => {
    it("browser roles have no table access and cannot run any internal or service function; only the two readers are open", async () => {
      const { w } = await staged()
      const tables = ["call_copilot_calls", "call_copilot_events", "call_copilot_conflicts", "call_copilot_transcript_segments", "call_copilot_transcript_conflicts",
        "call_copilot_evidence_revisions", "call_copilot_extraction_runs", "call_copilot_proposals", "call_copilot_run_proposals"]
      for (const client of [w.owner, anonClient()]) {
        for (const t of tables) {
          const r = await client.from(t).select("*").limit(1)
          expect(r.error?.code, `${t} must refuse a browser role`).toBe("42501")
        }
      }
      const internal: [string, Record<string, unknown>][] = [
        ["call_copilot_review_viewer", { p_shop: w.shop.shopId }],
        ["call_copilot_review_freshness", { p_shop: w.shop.shopId, p_proposal: w.callId, p_payload: null }],
        ["call_copilot_review_snippet", { p_shop: w.shop.shopId, p_call: w.callId, p_segment: w.callId, p_start: 0, p_end: 1, p_digest: "x", p_state: {} }],
        ["call_copilot_review_ambiguity", { a: {} }],
        ["call_copilot_read_transcript", { p_shop: w.shop.shopId, p_actor: w.shop.ownerId, p_call: w.callId, p_revision: w.callId }],
        ["call_copilot_capture_state", { p_shop_id: w.shop.shopId, p_call_id: w.callId }],
        ["call_copilot_record_extraction", { p_shop: w.shop.shopId, p_actor: w.shop.ownerId, p_call: w.callId, p_revision: w.callId, p_run: {}, p_proposals: [] }],
      ]
      for (const [fn, args] of internal) {
        const r = await w.owner.rpc(fn, args)
        expect(r.error?.code, fn).toBe("42501")
      }
      // the readers answer for the owner and are denied to anon
      expect((await w.owner.rpc("call_copilot_review_list", { p_shop: w.shop.shopId })).error).toBeNull()
      expect((await anonClient().rpc("call_copilot_review_list", { p_shop: w.shop.shopId })).error?.code).toBe("42501")
      expect((await anonClient().rpc("call_copilot_review_detail", { p_shop: w.shop.shopId, p_call: w.callId })).error?.code).toBe("42501")
    })

    it("has no caller identity argument: the service role (no auth.uid) is refused, and the reader cannot be pointed at another user", async () => {
      const { w } = await staged()
      expect((await db.rpc("call_copilot_review_detail", { p_shop: w.shop.shopId, p_call: w.callId })).error?.code).toBe("42501")
      expect((await db.rpc("call_copilot_review_list", { p_shop: w.shop.shopId })).error?.code).toBe("42501")
    })

    it("owner and crm.read manager can read; everyone else, including cross-shop owners, is refused; a forged call id is indistinguishable from a missing one", async () => {
      const { w } = await staged()
      const other = await newShop()
      const otherOwner = await session(other.email, PW)
      const mk = async (role: string, caps: string[], active = true) => {
        const u = await newShop()
        expect((await db.from("shop_memberships").upsert({ shop_id: w.shop.shopId, user_id: u.ownerId, role, capabilities: caps, active, display_name: role }, { onConflict: "shop_id,user_id" })).error).toBeNull()
        return { u, client: await session(u.email, PW) }
      }
      const ownerView = await detailOf(w.owner, w)
      expect(ownerView).toMatchObject({ viewer_role: "owner", can_approve: true })

      const manager = await mk("manager", ["crm.read"])
      const mView = await detailOf(manager.client, w)
      expect(mView).toMatchObject({ viewer_role: "manager", can_approve: false })
      expect(mView.proposals.map((p) => p.id).sort()).toEqual(ownerView.proposals.map((p) => p.id).sort())

      for (const [name, c] of [
        ["manager without crm.read", await mk("manager", ["notes.write"])],
        ["inactive manager", await mk("manager", ["crm.read"], false)],
        ["staff", await mk("staff", [])],
      ] as const) {
        expect((await c.client.rpc("call_copilot_review_detail", { p_shop: w.shop.shopId, p_call: w.callId })).error?.code, name).toBe("42501")
        expect((await c.client.rpc("call_copilot_review_list", { p_shop: w.shop.shopId })).error?.code, name).toBe("42501")
      }
      // another shop's owner naming this shop
      expect((await otherOwner.rpc("call_copilot_review_detail", { p_shop: w.shop.shopId, p_call: w.callId })).error?.code).toBe("42501")
      expect((await otherOwner.rpc("call_copilot_review_list", { p_shop: w.shop.shopId })).error?.code).toBe("42501")
      // ...or their own shop with this shop's call id: exactly the answer for a random id
      const cross = await otherOwner.rpc("call_copilot_review_detail", { p_shop: other.shopId, p_call: w.callId })
      const random = await otherOwner.rpc("call_copilot_review_detail", { p_shop: other.shopId, p_call: crypto.randomUUID() })
      expect(cross.data).toEqual({ found: false })
      expect(cross).toEqual(random)
      expect(await readCallReviewDetail(otherOwner, { shopId: other.shopId, callId: w.callId })).toEqual({ status: "not_found" })
      const list = await readCallReviewList(otherOwner, { shopId: other.shopId })
      expect(list.status === "ok" && list.value.items).toEqual([])

      // revocation is immediate
      expect((await db.from("shop_memberships").update({ active: false }).eq("shop_id", w.shop.shopId).eq("user_id", manager.u.ownerId)).error).toBeNull()
      expect((await manager.client.rpc("call_copilot_review_detail", { p_shop: w.shop.shopId, p_call: w.callId })).error?.code).toBe("42501")
    })

    it("a manager of this shop who owns another shop cannot read this shop with that other authority", async () => {
      const { w } = await staged()
      const m = await newShop() // owns its own shop
      expect((await db.from("shop_memberships").upsert({ shop_id: w.shop.shopId, user_id: m.ownerId, role: "manager", capabilities: ["notes.write"], active: true, display_name: "m" }, { onConflict: "shop_id,user_id" })).error).toBeNull()
      const client = await session(m.email, PW)
      expect((await client.rpc("call_copilot_review_detail", { p_shop: w.shop.shopId, p_call: w.callId })).error?.code).toBe("42501")
      expect((await client.rpc("call_copilot_review_detail", { p_shop: m.shopId, p_call: w.callId })).data).toEqual({ found: false })
    })

    it("the call list is newest first, bounded, keyset-paginated without gaps or repeats, and clamps its limit", async () => {
      const shop = await newShop()
      const owner = await session(shop.email, PW)
      const made: string[] = []
      for (let i = 0; i < 5; i++) { made.push((await newCall(shop, owner)).callId); await new Promise((r) => setTimeout(r, 15)) }
      const seen: string[] = []
      let cursor: { createdAt: string; id: string } | null = null
      for (let page = 0; page < 5; page++) {
        const r = await readCallReviewList(owner, { shopId: shop.shopId, limit: 2, before: cursor })
        if (r.status !== "ok") {
          const raw = await owner.rpc("call_copilot_review_list", { p_shop: shop.shopId, p_limit: 2, p_before_created: cursor?.createdAt ?? null, p_before_id: cursor?.id ?? null })
          const { reviewListSchema } = await import("@/lib/call-copilot/review-dto")
          const parsed = reviewListSchema.safeParse(raw.data)
          throw new Error(`list: ${r.status} rpcError=${JSON.stringify(raw.error)} zod=${parsed.success ? "ok" : JSON.stringify(parsed.error.issues.slice(0, 3))}`)
        }
        expect(r.value.items.length).toBeLessThanOrEqual(2)
        seen.push(...r.value.items.map((i) => i.call_id))
        if (!r.value.next_cursor) break
        cursor = { createdAt: r.value.next_cursor.created_at, id: r.value.next_cursor.id }
      }
      expect(seen).toEqual([...made].reverse())
      expect(new Set(seen).size).toBe(5)
      const big = await owner.rpc("call_copilot_review_list", { p_shop: shop.shopId, p_limit: 100000 })
      expect((big.data as { items: unknown[] }).items.length).toBe(5)
      const zero = await owner.rpc("call_copilot_review_list", { p_shop: shop.shopId, p_limit: 0 })
      expect((zero.data as { items: unknown[] }).items.length).toBe(1)
      expect((await owner.rpc("call_copilot_review_list", { p_shop: shop.shopId, p_before_created: at(0) })).error?.code).toBe("22023")
    })
  })

  // -------------------------------------------------------------------------------------------
  describe("what leaves the database", () => {
    it("is only the exact cited spans: never a whole segment, a provider id, a requester id or a candidate id", async () => {
      const { w, cust } = await staged()
      const d = await detailOf(w.owner, w)
      const json = JSON.stringify(d)
      for (const s of SEGMENTS) expect(json, `segment ${s.index} must not appear whole`).not.toContain(s.text)
      expect(json).not.toContain(w.providerCall)
      expect(json).not.toContain(w.shop.ownerId)
      expect(json).not.toContain(w.shop.shopId)
      let shown = 0
      for (const p of d.proposals) for (const field of p.fields) for (const c of field.citations) {
        expect(c.state).toBe("shown")
        shown++
        const seg = SEGMENTS.find((s) => s.index === c.segment_index)!
        expect(seg.text).toContain(c.snippet!)
        expect(c.snippet!.length).toBeLessThan(seg.text.length + 1)
      }
      expect(shown).toBeGreaterThan(10)
      // the cited words are exactly what the model cited
      const email = kindOf(d, "customer").fields.find((x) => x.name === "email")!
      expect(email.citations[0]!.snippet).toBe(spanOf(SEGMENTS[1]!.text, SEGMENTS[1]!.text.indexOf("jordan dot rivera"), SEGMENTS[1]!.text.indexOf("jordan dot rivera") + "jordan dot rivera at example dot test".length))
      expect(kindOf(d, "customer").customer).toEqual({ id: cust.id, name: "Jordan Rivera" })
    })

    it("never includes payment-card digits anywhere, because they are redacted before storage and nothing else is read", async () => {
      const w = await newWorld()
      const segs: FixtureSegment[] = [
        { index: 0, speaker: "caller", text: "My card is 4111 1111 1111 1111 and this is Jordan Rivera calling about the coating." },
        { index: 1, speaker: "caller", text: "My number is plus one five five five zero one four two nine eight eight." },
      ]
      await ingest(w, segs)
      const rev = await sealed(w)
      const cust = await customer(w.shop.shopId)
      const out = await propose(w, new FixtureExtractor(() => ({ proposals: [{ kind: "customer", name: f("Jordan Rivera", [cite([{ ...segs[0]!, text: "My card is [redacted: payment card] and this is Jordan Rivera calling about the coating." }, segs[1]!], 0, "Jordan Rivera")]), phone: f("+1 555 014 2988", [cite(segs, 1, "plus one five five five zero one four two nine eight eight")]) }] })), { evidenceRevisionId: rev.evidenceRevisionId, knownCustomerId: cust.id })
      expect(out.status).toBe("recorded")
      const json = JSON.stringify(await detailOf(w.owner, w))
      expect(json).not.toMatch(/4111[ -]?1111/)
      expect(json).not.toMatch(/\d{13,19}/)
    })

    it("candidate customers are counts, never identifiers", async () => {
      const w = await newWorld()
      await ingest(w)
      const rev = await sealed(w)
      // the heard phone matches one customer and the heard e-mail another: two candidates, no single answer
      await customer(w.shop.shopId, { name: "Jordan A" })
      const b = await customer(w.shop.shopId, { name: "Jordan B", phone: "+1 555 014 3000", email: "jordan.rivera@example.test" })
      const out = await propose(w, new FixtureExtractor(() => fullOutput()), { evidenceRevisionId: rev.evidenceRevisionId })
      expect(out.status).toBe("recorded")
      const d = await detailOf(w.owner, w)
      const customerProposal = kindOf(d, "customer")
      expect(customerProposal.route).toBe("review_only")
      expect(customerProposal.ambiguity?.candidate_customers).toBe(2)
      expect(JSON.stringify(d)).not.toContain(b.id)
    })

    it("review-only kinds carry no action, a reason, and customer memory says so", async () => {
      const { w } = await staged()
      const d = await detailOf(w.owner, w)
      for (const kind of ["memory_candidate", "lead", "followup_task"]) {
        const p = kindOf(d, kind)
        expect(p).toMatchObject({ route: "review_only", action_id: null, status: null, executed: null, staged: null })
        expect(p.review_reason).toBeTruthy()
      }
      expect(kindOf(d, "memory_candidate").review_reason).toBe("customer_memory_review_only")
    })

    it("complete evidence, runs and capture state are reported truthfully; partial evidence says why", async () => {
      const { w } = await staged()
      const d = await detailOf(w.owner, w)
      expect(d.capture).toMatchObject({ status: "ended", review_permitted: true, call_ended: true })
      expect(d.evidence.selected).toMatchObject({ revision: 1, current: true, coverage_status: "complete", segment_count: SEGMENTS.length, expected_segment_count: SEGMENTS.length })
      expect(d.runs[0]).toMatchObject({ status: "completed", revision: 1, requested_by_me: true })
      expect(d.snippets_withheld).toBe(false)

      const open = await staged({ ended: false })
      const od = await detailOf(open.w.owner, open.w)
      expect(od.evidence.selected).toMatchObject({ coverage_status: "partial" })
      expect(od.evidence.selected!.coverage_reasons).toEqual(expect.arrayContaining(["completion_not_attested", "call_not_ended"]))
    })
  })

  // -------------------------------------------------------------------------------------------
  describe("fresh denial and stale reasons, matching the approval claim", () => {
    /** The review's freshness code must equal the reason the real claim records when the same action is approved. */
    async function expectParity(w: World, kind: string, code: string) {
      const d = await detailOf(w.owner, w)
      const p = kindOf(d, kind)
      expect(p.freshness, "review freshness").toBe(code)
      const r = await executeApproval(w.owner, p.action_id!, w.shop.shopId, { userId: w.shop.ownerId })
      expect(r.ok).toBe(false)
      expect(await lastDecision(w.shop.shopId, p.action_id!)).toMatchObject({ allowed: false, reason: code })
      // nothing ran and the action stays pending
      const after = await detailOf(w.owner, w)
      expect(kindOf(after, kind)).toMatchObject({ status: "pending", executed: false })
    }

    it("fresh state has no denial reason", async () => {
      const { w } = await staged()
      const d = await detailOf(w.owner, w)
      expect(d.proposals.every((p) => p.freshness === null)).toBe(true)
    })

    it("a late consent decline shows call_consent_unavailable, hides every snippet, and the claim agrees", async () => {
      const { w } = await staged({ ended: false })
      await event(w.shop.shopId, ev(w.providerCall, 6, "consent_declined", 70, { party: "caller", disclosureVersion: "d1", respondsToSequence: 3 }))
      const d = await detailOf(w.owner, w)
      expect(d.capture.review_permitted).toBe(false)
      expect(d.snippets_withheld).toBe(true)
      const json = JSON.stringify(d)
      for (const s of SEGMENTS) expect(json).not.toContain(s.text.slice(0, 30))
      for (const p of d.proposals) for (const field of p.fields) for (const c of field.citations) expect(c).toMatchObject({ state: "withheld" })
      expect(d.proposals.every((p) => p.freshness === "call_consent_unavailable")).toBe(true)
      await expectParity(w, "service_request", "call_consent_unavailable")
    })

    it("new evidence shows call_evidence_changed, marks the revision out of date, withholds snippets, and the claim agrees", async () => {
      const { w } = await staged()
      await recordTranscriptSegment(db, { shopId: w.shop.shopId, callId: w.callId, segment: { providerSegmentId: `${w.providerCall}-s9`, index: 8, speaker: "caller", text: "One more thing about the wheels.", ...window(8) } })
      const d = await detailOf(w.owner, w)
      expect(d.evidence.selected).toMatchObject({ current: false, not_current_reason: "evidence_changed" })
      expect(d.snippets_withheld).toBe(true)
      expect(JSON.stringify(d)).not.toContain("One more thing")
      await expectParity(w, "timing", "call_evidence_changed")
    })

    it("an edited pending payload shows call_proposal_edited and the claim agrees", async () => {
      const { w } = await staged()
      const p = kindOf(await detailOf(w.owner, w), "service_request")
      const payload = (await db.from("pending_actions").select("payload").eq("id", p.action_id!).single()).data!.payload as Record<string, unknown>
      expect((await db.from("pending_actions").update({ payload: { ...payload, content: "tampered" } }).eq("id", p.action_id!)).error).toBeNull()
      await expectParity(w, "service_request", "call_proposal_edited")
    })

    it("a changed customer identity shows call_crm_state_changed and the claim agrees", async () => {
      const { w, cust } = await staged()
      expect((await db.from("customers").update({ name: "Someone Else" }).eq("id", cust.id)).error).toBeNull()
      await expectParity(w, "quote_draft", "call_crm_state_changed")
    })

    it("a revoked requester shows call_requester_revoked and the claim agrees", async () => {
      const w = await newWorld()
      await ingest(w)
      const rev = await sealed(w)
      const cust = await customer(w.shop.shopId)
      const mgr = await newShop()
      expect((await db.from("shop_memberships").upsert({ shop_id: w.shop.shopId, user_id: mgr.ownerId, role: "manager", capabilities: ["crm.read"], active: true, display_name: "m" }, { onConflict: "shop_id,user_id" })).error).toBeNull()
      const out = await propose(w, new FixtureExtractor(() => fullOutput()), { evidenceRevisionId: rev.evidenceRevisionId, knownCustomerId: cust.id, actorId: mgr.ownerId })
      expect(out.status).toBe("recorded")
      expect((await db.from("shop_memberships").update({ active: false }).eq("shop_id", w.shop.shopId).eq("user_id", mgr.ownerId)).error).toBeNull()
      const d = await detailOf(w.owner, w)
      expect(d.proposals.every((p) => p.requested_by_me === false)).toBe(true)
      await expectParity(w, "service_request", "call_requester_revoked")
    })

    it("a read never blocks a capture writer or an approval: it takes no row lock", async () => {
      const { w } = await staged({ ended: false })
      const reads = Array.from({ length: 6 }, () => detailOf(w.owner, w))
      const write = event(w.shop.shopId, ev(w.providerCall, 6, "capture_paused", 80))
      const results = await Promise.all([...reads, write])
      expect(results.length).toBe(7)
    })

    it("a pause creates a visible gap and changes the evidence; coverage never calls it complete", async () => {
      const { w } = await staged({ ended: false })
      await event(w.shop.shopId, ev(w.providerCall, 6, "capture_paused", 15))
      const d = await detailOf(w.owner, w)
      expect(d.capture.gaps.some((g) => g.reason === "paused")).toBe(true)
      expect(d.evidence.selected!.current).toBe(false)
    })

    it("an unknown extraction outcome is visible and is never silently retried", async () => {
      const w = await newWorld()
      await ingest(w)
      const rev = await sealed(w)
      const ex = new FixtureExtractor(() => ({ ok: false, kind: "unknown_outcome", code: "extractor_timeout" }))
      const out = await propose(w, ex, { evidenceRevisionId: rev.evidenceRevisionId })
      expect(out).toMatchObject({ status: "extraction_failed", kind: "unknown_outcome" })
      const d = await detailOf(w.owner, w)
      expect(d.runs[0]).toMatchObject({ status: "unknown_outcome", proposal_count: 0 })
      expect(d.proposals).toEqual([])
      expect(await propose(w, ex, { evidenceRevisionId: rev.evidenceRevisionId })).toMatchObject({ status: "extraction_failed", code: "previous_outcome_unknown" })
      expect(ex.calls).toBe(1)
    })
  })

  // -------------------------------------------------------------------------------------------
  describe("decisions go through the existing executor, in order, and stop safely", () => {
    it("approve selected runs vehicle, note, quote and booking in dependency order, exactly once, and a replay duplicates nothing", async () => {
      // the customer already has every identity field the call mentions, so there is no customer proposal and nothing stales the booking
      const { w, cust } = await staged({ customer: { email: "jordan.rivera@example.test" } })
      const d = await detailOf(w.owner, w)
      expect(d.proposals.some((p) => p.kind === "customer")).toBe(false)
      const picks = ["appointment_draft", "quote_draft", "service_request", "vehicle"].map((k) => kindOf(d, k))
      const order: string[] = []
      const deps = realDeps(w, async (id) => { order.push(d.proposals.find((p) => p.action_id === id)!.kind) })
      const r = await approveSelected(deps, picks.map(item))
      expect(r.ok, JSON.stringify(r.steps)).toBe(true)
      expect(order).toEqual(["vehicle", "service_request", "quote_draft", "appointment_draft"])
      expect((await db.from("vehicles").select("make,year").eq("customer_id", cust.id)).data).toEqual([{ make: "Tesla", year: 2021 }])
      const callNotes = async () => (await db.from("interactions").select("*", { count: "exact", head: true }).eq("shop_id", w.shop.shopId).eq("metadata->reported_metadata->>origin", "call_copilot")).count
      const effects = async () => ({ notes: await callNotes(), interactions: await count("interactions", w.shop.shopId), quotes: await count("quotes", w.shop.shopId), appointments: await count("appointments", w.shop.shopId) })
      const once = await effects()
      expect(once).toMatchObject({ notes: 1, quotes: 1, appointments: 1 })
      // the review now shows the authoritative result
      const after = await detailOf(w.owner, w)
      for (const k of ["vehicle", "service_request", "quote_draft", "appointment_draft"]) expect(kindOf(after, k)).toMatchObject({ status: "approved", executed: true })
      // replays: a stale tab (old tokens) and the executor itself both do nothing new
      const again = await approveSelected(deps, picks.map(item))
      expect(again.ok).toBe(false)
      for (const p of picks) expect(await executeApproval(w.owner, p.action_id!, w.shop.shopId, { userId: w.shop.ownerId })).toMatchObject({ ok: true, status: "already_decided" })
      expect(await effects()).toEqual(once)
    })

    it("vehicle runs before the customer change, which runs before everything that depends on it; a booking that bound the e-mail the customer change fills is shown stale, never run", async () => {
      const { w, cust } = await staged() // the customer has no e-mail: the call fills it
      const d = await detailOf(w.owner, w)
      const picks = ["quote_draft", "service_request", "customer", "vehicle"].map((k) => kindOf(d, k))
      const order: string[] = []
      const deps = realDeps(w, async (id) => { order.push(d.proposals.find((p) => p.action_id === id)!.kind) })
      const r = await approveSelected(deps, picks.map(item))
      expect(r.ok, JSON.stringify(r.steps)).toBe(true)
      expect(order).toEqual(["vehicle", "customer", "service_request", "quote_draft"])
      expect((await db.from("customers").select("email").eq("id", cust.id).single()).data!.email).toBe("jordan.rivera@example.test")
      // the appointment proposal bound the (then empty) e-mail; the customer approval changed it, so the review says so and offers no approve
      const after = await detailOf(w.owner, w)
      expect(kindOf(after, "appointment_draft")).toMatchObject({ status: "pending", executed: false, freshness: "call_crm_state_changed" })
      expect(await count("appointments", w.shop.shopId)).toBe(0)
      const blocked = await approveSelected(deps, [item(kindOf(after, "appointment_draft"))])
      expect(blocked.ok).toBe(false)
      expect(await count("appointments", w.shop.shopId)).toBe(0)
    })

    it("a selection that skips a prerequisite is refused whole; nothing changes", async () => {
      const { w } = await staged()
      const d = await detailOf(w.owner, w)
      const r = await approveSelected(realDeps(w), [item(kindOf(d, "quote_draft")), item(kindOf(d, "customer"))])
      expect(r.ok).toBe(false)
      expect(r.message).toMatch(/Approve vehicle first/i)
      expect(await count("quotes", w.shop.shopId)).toBe(0)
      expect((await detailOf(w.owner, w)).proposals.filter((p) => p.status === "approved")).toEqual([])
    })

    it("stops at the first denial from the database and attempts nothing after it", async () => {
      const { w, cust } = await staged()
      const d = await detailOf(w.owner, w)
      const picks = ["vehicle", "customer", "quote_draft"].map((k) => kindOf(d, k))
      let n = 0
      // the customer's identity changes between the owner's last look and the second approval
      const deps = realDeps(w, async () => { if (++n === 2) await db.from("customers").update({ phone: "+1 555 014 2999" }).eq("id", cust.id) })
      const r = await approveSelected(deps, picks.map(item))
      expect(r.ok).toBe(false)
      expect(r.steps.map((s) => s.result)).toEqual(["approved", "denied"])
      expect(r.notAttempted).toEqual([kindOf(d, "quote_draft").id])
      expect(await count("quotes", w.shop.shopId)).toBe(0)
      const after = await detailOf(w.owner, w)
      expect(kindOf(after, "vehicle")).toMatchObject({ status: "approved", executed: true })
      expect(kindOf(after, "customer")).toMatchObject({ status: "pending", executed: false })
      expect(kindOf(after, "quote_draft").freshness).toBe("call_crm_state_changed")
    })

    it("an approval made on stale evidence changes nothing and says why; a refreshed read reveals it first", async () => {
      const { w } = await staged({ ended: false })
      const seen = await detailOf(w.owner, w)
      await event(w.shop.shopId, ev(w.providerCall, 6, "consent_declined", 70, { party: "operator", disclosureVersion: "d1", respondsToSequence: 2 }))
      const r = await approveSelected(realDeps(w), [item(kindOf(seen, "vehicle"))])
      expect(r.ok).toBe(false)
      expect(r.steps[0]).toMatchObject({ result: "refused" })
      expect(await count("vehicles", w.shop.shopId)).toBe(0)
    })

    it("a manager cannot approve: the application refuses and the claim itself denies", async () => {
      const { w } = await staged()
      const mgr = await newShop()
      expect((await db.from("shop_memberships").upsert({ shop_id: w.shop.shopId, user_id: mgr.ownerId, role: "manager", capabilities: ["crm.read", "approvals.messages"], active: true, display_name: "m" }, { onConflict: "shop_id,user_id" })).error).toBeNull()
      const client = await session(mgr.email, PW)
      const d = await detailOf(client, w)
      expect(d.can_approve).toBe(false)
      const note = kindOf(d, "service_request")
      const refused = await approveSelected({ readDetail: () => readCallReviewDetail(client, { shopId: w.shop.shopId, callId: w.callId }), approve: async () => { throw new Error("must not be called") }, dismiss: async () => { throw new Error("must not be called") } }, [item(note)])
      expect(refused.ok).toBe(false)
      // even if the application layer were bypassed, the claim denies a manager for a record command
      const direct = await executeApproval(client, note.action_id!, w.shop.shopId, { userId: mgr.ownerId })
      expect(direct.ok).toBe(false)
      expect(await count("interactions", w.shop.shopId)).toBe(0)
      expect(kindOf(await detailOf(w.owner, w), "service_request")).toMatchObject({ status: "pending", executed: false })
    })

    it("dismiss rejects the pending action through the existing path and changes no customer data", async () => {
      const { w } = await staged()
      const d = await detailOf(w.owner, w)
      const note = kindOf(d, "service_request")
      const { executeRejection } = await import("@/lib/approvals")
      const deps: DecideDeps = { ...realDeps(w), dismiss: (id) => executeRejection(w.owner, id, w.shop.shopId, { userId: w.shop.ownerId }) }
      const r = await dismissProposal(deps, item(note))
      expect(r.ok, r.message).toBe(true)
      expect(kindOf(await detailOf(w.owner, w), "service_request")).toMatchObject({ status: "rejected" })
      expect(await count("interactions", w.shop.shopId)).toBe(0)
      // a dismissed prerequisite no longer blocks its dependents
      const v = kindOf(await detailOf(w.owner, w), "vehicle")
      expect((await dismissProposal(deps, item(v))).ok).toBe(true)
      const customerNow = kindOf(await detailOf(w.owner, w), "customer")
      expect((await approveSelected(realDeps(w), [item(customerNow)])).ok).toBe(true)
    })
  })
})

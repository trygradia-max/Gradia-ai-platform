// Live-smoke seed for the Gradia MVP. Sets up a disposable, clearly-marked
// data set so an operator can verify Phases 1–3 against a real Supabase:
//
//   P1 (in-app approvals): a pending create_lead shows in /approvals + the
//       sidebar badge; Approve finalizes a real lead.
//   P2 (free-form chat agent): a "ceramic quote, never booked" audience that
//       the dry-run Preview resolves — and proves the opt-out guardrail
//       (the STOP customer is excluded). Zero sends.
//   P3 (credits fail-closed): with --fill-credits, the period's usage is
//       pushed to the limit so an agent run pauses (requires FEATURES.paywall).
//   C1 (CRM foundation): vehicles (one per customer, sized), a size-class
//       priced service, a sent quote at the truck_suv price, and a confirmed
//       job — exercising the vehicles/quotes/job-status schema end to end.
//
// Everything it creates is tagged SMOKE: / [smoke-seed] and is removed + re-
// created on each run, so it never touches your real data.
//
// Run (Node 20.6+):
//   node --env-file=.env.local scripts/seed-smoke.mjs --shop <SHOP_ID>
//   node --env-file=.env.local scripts/seed-smoke.mjs --shop <SHOP_ID> --fill-credits
//   node --env-file=.env.local scripts/seed-smoke.mjs --shop <SHOP_ID> --clean-only
//
// Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (service role
// bypasses RLS). ANTHROPIC_API_KEY must be set in the app env for the P2
// preview drafts to render.

import { createClient } from "@supabase/supabase-js"

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const valOf = (f) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}

const SHOP_ID = valOf("--shop") || process.env.SMOKE_SHOP_ID
const CLEAN_ONLY = has("--clean-only")
const FILL_CREDITS = has("--fill-credits")

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n" +
      "Run with:  node --env-file=.env.local scripts/seed-smoke.mjs --shop <id>"
  )
  process.exit(1)
}

const db = createClient(url, key, { auth: { persistSession: false } })

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString()

async function listShopsAndExit() {
  const { data, error } = await db
    .from("shops")
    .select("id, name")
    .order("created_at", { ascending: false })
    .limit(20)
  if (error) {
    console.error("Couldn't list shops:", error.message)
    process.exit(1)
  }
  console.log("Pass one of these with --shop <id>:\n")
  for (const s of data ?? []) console.log(`  ${s.id}   ${s.name}`)
  if (!data?.length) console.log("  (no shops yet — create one via onboarding)")
  process.exit(1)
}

async function clean(shopId) {
  // Order matters for FKs; deleting smoke customers cascades their
  // interactions/vehicles/quotes, but we clear dependents first anyway.
  await db.from("pending_actions").delete().eq("shop_id", shopId).eq("payload->>smoke", "true")
  await db.from("usage_events").delete().eq("shop_id", shopId).like("ref_id", "smoke-%")
  await db.from("custom_agents").delete().eq("shop_id", shopId).like("name", "SMOKE:%")
  await db.from("appointments").delete().eq("shop_id", shopId).eq("internal_note", "[smoke-seed]")
  await db.from("quotes").delete().eq("shop_id", shopId).eq("internal_note", "[smoke-seed]")
  await db.from("leads").delete().eq("shop_id", shopId).like("customer_name", "SMOKE:%")
  await db.from("interactions").delete().eq("shop_id", shopId).eq("metadata->>smoke", "true")
  await db.from("customers").delete().eq("shop_id", shopId).like("name", "SMOKE:%")
  await db.from("services").delete().eq("shop_id", shopId).like("name", "SMOKE:%")
  console.log("✓ removed any prior SMOKE: rows")
}

async function insertCustomer(shopId, name, phone, email) {
  const { data, error } = await db
    .from("customers")
    .insert({ shop_id: shopId, name, phone, email })
    .select("id")
    .single()
  if (error) throw new Error(`customer ${name}: ${error.message}`)
  return data.id
}

async function main() {
  if (!SHOP_ID) await listShopsAndExit()

  const { data: shop, error: shopErr } = await db
    .from("shops")
    .select("id, name, owner_id, credit_limit, credit_period_start")
    .eq("id", SHOP_ID)
    .maybeSingle()
  if (shopErr) {
    console.error("Shop lookup failed:", shopErr.message)
    process.exit(1)
  }
  if (!shop) {
    console.error(`No shop with id ${SHOP_ID}.`)
    await listShopsAndExit()
  }
  const owner = shop.owner_id

  console.log(`\nSeeding smoke data for "${shop.name}" (${shop.id})\n`)
  await clean(shop.id)
  if (CLEAN_ONLY) {
    console.log("\nDone (clean-only).")
    return
  }

  // --- Customers ---------------------------------------------------------
  // Ada: a clean ceramic-quote lead → should appear in the P2 preview.
  // Cy:  same ceramic quote BUT texted STOP → must be excluded (opt-out).
  // Bo:  long-inactive customer (for the stale-customer flow, if tested).
  const ada = await insertCustomer(shop.id, "SMOKE: Ada Ceramic", "+15550000101", "ada.smoke@example.com")
  const cy = await insertCustomer(shop.id, "SMOKE: Cy OptOut", "+15550000102", "cy.smoke@example.com")
  const bo = await insertCustomer(shop.id, "SMOKE: Bo Stale", "+15550000103", "bo.smoke@example.com")

  // --- Vehicles (CRM C1 — the vehicles table, not the flat columns) ------
  const vehicleRows = [
    { shop_id: shop.id, customer_id: ada, year: 2022, make: "Tesla", model: "Model Y", color: "White", size_class: "truck_suv" },
    { shop_id: shop.id, customer_id: cy, year: 2019, make: "Ford", model: "F-150", color: "Black", size_class: "truck_suv" },
    { shop_id: shop.id, customer_id: bo, year: 2015, make: "Honda", model: "Civic", color: "Silver", size_class: "sedan" },
  ]
  const { data: vehicles, error: vehErr } = await db
    .from("vehicles")
    .insert(vehicleRows)
    .select("id, customer_id")
  if (vehErr) throw new Error(`vehicles: ${vehErr.message}`)
  const vehicleOf = Object.fromEntries(vehicles.map((v) => [v.customer_id, v.id]))

  // --- Service with size-class pricing (resolves through lib/service-pricing:
  //     truck_suv $700, sedan $600, everything else falls back to $650) ----
  const { data: svc, error: svcErr } = await db
    .from("services")
    .insert({
      shop_id: shop.id,
      name: "SMOKE: Ceramic Coating",
      description: "Disposable smoke-seed service. [smoke-seed]",
      price_cents: 65000,
      duration_minutes: 300,
      category: "protection",
      base_price_by_size: { sedan: 60000, truck_suv: 70000 },
      duration_by_size: { sedan: 270, truck_suv: 330 },
      condition_multipliers: [{ key: "heavy_soil", label: "Heavy soiling", multiplier: 1.2 }],
    })
    .select("id")
    .single()
  if (svcErr) throw new Error(`service: ${svcErr.message}`)

  // --- Leads (quoted ceramic, never booked) ------------------------------
  const leadRows = [
    {
      shop_id: shop.id,
      customer_id: ada,
      customer_name: "SMOKE: Ada Ceramic",
      phone: "+15550000101",
      car_info: "2022 Tesla Model Y, white",
      vehicle_id: vehicleOf[ada],
      pin_notes: "Quoted ceramic coating, hasn't booked. [smoke-seed]",
      status: "quoted",
      stage: "quote_sent",
      created_at: daysAgo(20),
    },
    {
      shop_id: shop.id,
      customer_id: cy,
      customer_name: "SMOKE: Cy OptOut",
      phone: "+15550000102",
      car_info: "2019 F-150, black",
      vehicle_id: vehicleOf[cy],
      pin_notes: "Quoted ceramic, then texted STOP. [smoke-seed]",
      status: "quoted",
      stage: "quote_sent",
      created_at: daysAgo(18),
    },
  ]
  const { data: leads, error: leadErr } = await db
    .from("leads")
    .insert(leadRows)
    .select("id, customer_id")
  if (leadErr) throw new Error(`leads: ${leadErr.message}`)
  const adaLead = leads.find((l) => l.customer_id === ada)

  // --- Quote (C1): Ada's truck_suv ceramic at the size-class price --------
  const { data: quote, error: quoteErr } = await db
    .from("quotes")
    .insert({
      shop_id: shop.id,
      customer_id: ada,
      vehicle_id: vehicleOf[ada],
      lead_id: adaLead?.id ?? null,
      status: "sent",
      line_items: [
        {
          service_id: svc.id,
          name: "SMOKE: Ceramic Coating",
          base_cents: 70000, // truck_suv from base_price_by_size
          modifiers: [],
          price_cents: 70000,
        },
      ],
      subtotal_cents: 70000,
      discount_cents: 0,
      total_cents: 70000,
      sent_via: "sms",
      sent_at: daysAgo(3),
      internal_note: "[smoke-seed]",
      created_by: "owner",
    })
    .select("id, public_token")
    .single()
  if (quoteErr) throw new Error(`quote: ${quoteErr.message}`)
  if (adaLead) {
    await db.from("leads").update({ quote_id: quote.id }).eq("id", adaLead.id)
  }

  // --- Jobs (C1): appointments carry the job status machine now — one row
  //     per interesting status so the future C4 calendar has real variety.
  const tomorrow = new Date(Date.now() + 86_400_000)
  tomorrow.setHours(10, 0, 0, 0)
  const jobRows = [
    {
      // Upcoming, confirmed, quoted at the truck_suv price.
      shop_id: shop.id,
      lead_id: adaLead?.id ?? null,
      customer_id: ada,
      vehicle_id: vehicleOf[ada],
      quote_id: quote.id,
      scheduled_at: tomorrow.toISOString(),
      duration_minutes: 330, // truck_suv from duration_by_size
      service_name: "SMOKE: Ceramic Coating",
      service_ids: [svc.id],
      status: "confirmed",
      location_type: "shop",
      payment_status: "unpaid",
      quoted_amount_cents: 70000,
      internal_note: "[smoke-seed]",
    },
    {
      // Mobile job mid-work today.
      shop_id: shop.id,
      customer_id: cy,
      vehicle_id: vehicleOf[cy],
      scheduled_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      duration_minutes: 120,
      service_name: "SMOKE: Ceramic Coating",
      service_ids: [svc.id],
      status: "in_progress",
      location_type: "mobile",
      address: { line1: "123 Smoke Test Ln", city: "Testville" },
      travel_fee_cents: 2500,
      payment_status: "deposit",
      quoted_amount_cents: 70000,
      internal_note: "[smoke-seed]",
    },
    {
      // Finished + paid last week (feeds lifecycle/LTV rollups later).
      shop_id: shop.id,
      customer_id: bo,
      vehicle_id: vehicleOf[bo],
      scheduled_at: daysAgo(7),
      duration_minutes: 270, // sedan from duration_by_size
      service_name: "SMOKE: Ceramic Coating",
      service_ids: [svc.id],
      status: "paid",
      location_type: "shop",
      payment_status: "paid",
      quoted_amount_cents: 60000, // sedan price
      internal_note: "[smoke-seed]",
    },
  ]
  const { error: jobErr } = await db.from("appointments").insert(jobRows)
  if (jobErr) throw new Error(`appointments/jobs: ${jobErr.message}`)

  // --- Interactions ------------------------------------------------------
  const interactions = [
    // Cy opted out — inbound STOP. The resolver excludes this customer.
    {
      shop_id: shop.id,
      customer_id: cy,
      channel: "sms",
      role: "customer",
      content: "STOP",
      metadata: { smoke: true, direction: "inbound" },
      occurred_at: daysAgo(10),
    },
    // Bo is stale: only an old touchpoint, well past any cooldown.
    {
      shop_id: shop.id,
      customer_id: bo,
      channel: "sms",
      role: "customer",
      content: "Do you do headlight restoration?",
      metadata: { smoke: true, direction: "inbound" },
      occurred_at: daysAgo(75),
    },
  ]
  const { error: intErr } = await db.from("interactions").insert(interactions)
  if (intErr) throw new Error(`interactions: ${intErr.message}`)

  // --- Pending approval (P1) --------------------------------------------
  const { data: pending, error: pErr } = await db
    .from("pending_actions")
    .insert({
      shop_id: shop.id,
      action_type: "create_lead",
      status: "pending",
      requested_by: owner,
      payload: {
        smoke: true,
        customer_name: "SMOKE: Pat Walk-in",
        phone: "+15550000104",
        car_info: "2018 Civic, blue",
        pin_notes: "Walked in asking about a full interior detail. [smoke-seed]",
        status: "new",
      },
    })
    .select("id")
    .single()
  if (pErr) throw new Error(`pending_action: ${pErr.message}`)

  // --- Free-form agent (P2) — disabled; preview/Run-now from the UI ------
  const config = {
    name: "SMOKE: ceramic quote follow-up",
    short_description:
      "We text leads who got a ceramic quote and never booked.",
    trigger: { kind: "schedule", schedule_summary: "every day at 9am" },
    audience: {
      entity: "leads",
      filters_summary: ["status quoted", "mentions ceramic", "never booked"],
    },
    action: {
      kind: "draft_sms",
      intent_summary: "a warm nudge to come book their ceramic coating",
    },
    prerequisites_needed: ["Twilio number connected", "Anthropic key on server"],
    human_in_the_loop_note:
      "Every text lands as an approval before it sends.",
    freeform: {
      entity: "leads",
      channel: "sms",
      filters: { lead_status: "quoted", keyword: "ceramic", max_age_days: 365 },
      message_intent:
        "a warm, brief nudge to come book their ceramic coating if they're still interested",
      max_recipients: 50,
      cooldown_days: 30,
    },
    schedule: { cadence: "daily", hour_of_day: 14 },
  }
  const { data: agent, error: aErr } = await db
    .from("custom_agents")
    .insert({
      shop_id: shop.id,
      owner_id: owner,
      name: config.name,
      description: config.short_description,
      problem_text: "Text leads who got a ceramic quote and never booked.",
      config,
      enabled: false,
    })
    .select("id")
    .single()
  if (aErr) throw new Error(`custom_agent: ${aErr.message}`)

  // --- Optional: push credits to the limit (P3 fail-closed) --------------
  let creditNote = "skipped (pass --fill-credits to test P3 fail-closed)"
  if (FILL_CREDITS) {
    const { error: uErr } = await db.from("usage_events").insert({
      shop_id: shop.id,
      kind: "message",
      quantity: 1,
      credits: shop.credit_limit,
      ref_id: "smoke-fill",
    })
    if (uErr) throw new Error(`usage_events: ${uErr.message}`)
    creditNote = `filled to limit (${shop.credit_limit} credits this period)`
  }

  // --- Report ------------------------------------------------------------
  console.log("✓ seeded:")
  console.log(`    customers: Ada (match), Cy (opted out), Bo (stale)`)
  console.log(`    vehicles: 3 (one per customer — Ada's is a truck_suv)`)
  console.log(`    service: SMOKE: Ceramic Coating (size-class priced $600/$700, fallback $650)`)
  console.log(`    leads: 2 quoted-ceramic (stage quote_sent, linked to vehicles)`)
  console.log(`    quote: ${quote.id} (sent, $700 = truck_suv price) → /q/${quote.public_token ?? "?"}`)
  console.log(`    jobs: 3 across statuses (confirmed / in_progress mobile / paid)`)
  console.log(`    pending approval: ${pending.id}`)
  console.log(`    free-form agent: ${agent.id} (disabled)`)
  console.log(`    credits: ${creditNote}\n`)

  console.log("Run the smokes:\n")
  console.log("  P1 — /approvals shows 'SMOKE: Pat Walk-in' + the sidebar badge")
  console.log("       increments. Approve → a real lead appears in /leads.\n")
  console.log("  P2 — /agents/build → \"text leads who got a ceramic quote and")
  console.log("       never booked\" → Plan → Preview audience. Expect 1 recipient")
  console.log("       (Ada) — Cy is excluded by the STOP opt-out — plus a sample")
  console.log("       SMS draft. Nothing sends. (Run-now staging also needs a")
  console.log("       connected Twilio number.)\n")
  console.log("  P3 — requires FEATURES.paywall=true. With --fill-credits, open the")
  console.log("       SMOKE agent and Run now → it should NOT fire ('credit limit")
  console.log("       reached'). Raise the limit in /settings → Usage to clear it.\n")
  console.log("Re-run anytime (it re-seeds cleanly); `--clean-only` to remove.")
}

main().catch((err) => {
  console.error("\nSeed failed:", err.message)
  process.exit(1)
})

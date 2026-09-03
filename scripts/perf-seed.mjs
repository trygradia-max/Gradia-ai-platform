// PERF-001 — seed a realistic shop into the LOCAL Supabase stack for
// response-time measurement (manual tool; never part of CI or Production).
//
//   eval "$(supabase status -o env)"
//   SUPABASE_TEST_URL="$API_URL" SUPABASE_TEST_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
//     node scripts/perf-seed.mjs --app http://localhost:3100
//   node scripts/perf-seed.mjs --clean        # removes every perf-seed shop + owner
//
// Shape (ticket §scope 1): ≥ 500 customers, ≥ 200 appointments, ≥ 50 pending
// actions, plus leads / quotes / interactions / payments so every Home loader
// has rows to chew on. Prints the owner e-mail, the shop id and a one-time
// magic link that signs the browser in (local GoTrue → /auth/callback).
//
// SAFETY: refuses any Supabase URL that is not loopback. There is no
// --allow-remote flag on purpose — seeding a remote project is a founder act.

import { createClient } from "@supabase/supabase-js"

const args = process.argv.slice(2)
const opt = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : fallback
}
const has = (flag) => args.includes(flag)

const URL_ = process.env.SUPABASE_TEST_URL
const KEY = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY
if (!URL_ || !KEY) {
  console.error("Set SUPABASE_TEST_URL and SUPABASE_TEST_SERVICE_ROLE_KEY (local stack only).")
  process.exit(1)
}
const host = new URL(URL_).hostname
if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
  console.error(`Refusing non-loopback Supabase URL (${host}). This seed is local-only.`)
  process.exit(1)
}

const APP = (opt("--app", "http://localhost:3100")).replace(/\/$/, "")
const N = {
  customers: Number(opt("--customers", "600")),
  leads: Number(opt("--leads", "700")),
  quotes: Number(opt("--quotes", "150")),
  appointments: Number(opt("--appointments", "260")),
  pending: Number(opt("--pending", "60")),
  interactions: Number(opt("--interactions", "3000")),
  payments: Number(opt("--payments", "40")),
}

const db = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } })

const DAY = 86_400_000
const now = Date.now()
const iso = (ms) => new Date(ms).toISOString()
const daysAgo = (d) => iso(now - d * DAY)
// Deterministic pseudo-random so two seeds produce the same shape.
let seed = 42
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296
const pick = (xs) => xs[Math.floor(rnd() * xs.length)]
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))

const FIRST = ["Marcus", "Dana", "Priya", "Luis", "Keisha", "Tom", "Ana", "Jordan", "Mei", "Omar", "Sofia", "Derek"]
const LAST = ["Reyes", "Nguyen", "Okafor", "Miller", "Patel", "Kowalski", "Haddad", "Silva", "Brooks", "Tanaka"]
const MAKES = [["Tesla", "Model 3"], ["Ford", "F-150"], ["Toyota", "4Runner"], ["BMW", "M3"], ["Honda", "Civic"], ["Porsche", "911"], ["Subaru", "Outback"], ["Chevrolet", "Tahoe"]]
const COLORS = ["silver", "black", "white", "red", "blue", "gray"]
const SERVICES = [
  ["Full Detail", 25000, 180], ["Interior Detail", 15000, 120], ["Exterior Wash + Wax", 9000, 60],
  ["Ceramic Coating", 120000, 480], ["Paint Correction", 60000, 360], ["Window Tint", 35000, 150],
]

async function insertAll(table, rows, select) {
  const out = []
  for (let i = 0; i < rows.length; i += 250) {
    const chunk = rows.slice(i, i + 250)
    const q = db.from(table).insert(chunk)
    const { data, error } = select ? await q.select(select) : await q
    if (error) throw new Error(`${table}: ${error.message}`)
    if (data) out.push(...data)
  }
  return out
}

async function clean() {
  const { data, error } = await db.auth.admin.listUsers({ perPage: 1000 })
  if (error) throw error
  const owners = data.users.filter((u) => u.email?.startsWith("perf-seed-"))
  for (const u of owners) {
    await db.from("shops").delete().eq("owner_id", u.id)
    await db.auth.admin.deleteUser(u.id)
  }
  console.log(`cleaned ${owners.length} perf-seed owner(s)`)
}

async function main() {
  if (has("--clean")) return clean()

  const stamp = Date.now().toString(36)
  const email = `perf-seed-${stamp}@example.test`
  const { data: created, error: userErr } = await db.auth.admin.createUser({
    email,
    email_confirm: true,
    password: `perf-${stamp}-${Math.random().toString(36).slice(2)}`,
  })
  if (userErr || !created?.user) throw new Error(`createUser: ${userErr?.message}`)
  const ownerId = created.user.id

  const { data: shop, error: shopErr } = await db
    .from("shops")
    .insert({
      name: "Perf Seed Detailing",
      owner_id: ownerId,
      plan: "active",
      settings: { onboarding_done: true },
      twilio_phone_number: `+1617555${stamp.slice(-4).padStart(4, "0")}`,
    })
    .select("id")
    .single()
  if (shopErr || !shop) throw new Error(`shop: ${shopErr?.message}`)
  const shopId = shop.id

  const services = await insertAll(
    "services",
    SERVICES.map(([name, price_cents, duration_minutes]) => ({ shop_id: shopId, name, price_cents, duration_minutes })),
    "id, name, price_cents, duration_minutes"
  )

  const customers = await insertAll(
    "customers",
    Array.from({ length: N.customers }, (_, i) => {
      const [vehicle_make, vehicle_model] = pick(MAKES)
      const createdDaysAgo = int(1, 540)
      return {
        shop_id: shopId,
        name: `${pick(FIRST)} ${pick(LAST)}`,
        phone: `+1617${String(2000000 + i).padStart(7, "0")}`,
        email: i % 3 === 0 ? null : `perf-${stamp}-${i}@example.test`,
        vehicle_make,
        vehicle_model,
        vehicle_year: int(2012, 2025),
        vehicle_color: pick(COLORS),
        created_at: daysAgo(createdDaysAgo),
        updated_at: daysAgo(int(0, createdDaysAgo)),
        last_visit_at: rnd() < 0.7 ? daysAgo(int(1, 400)) : null,
        source: pick(["voice", "sms", "import", "web"]),
      }
    }),
    "id, name, phone"
  )

  const stages = ["new", "needs_quote", "quote_sent", "follow_up", "booked", "lost"]
  const leads = await insertAll(
    "leads",
    Array.from({ length: N.leads }, (_, i) => {
      const c = customers[i % customers.length]
      const stage = pick(stages)
      const age = i < 40 ? int(0, 6) : int(7, 90)
      return {
        shop_id: shopId,
        customer_id: c.id,
        customer_name: c.name,
        phone: c.phone,
        car_info: `${pick(COLORS)} ${pick(MAKES).join(" ")}`,
        status: stage === "booked" ? "booked" : stage === "quote_sent" ? "quoted" : "new",
        stage,
        stage_entered_at: daysAgo(int(0, age)),
        lost_reason: stage === "lost" ? pick(["price", "timing", "no_response", "competitor", "other"]) : null,
        est_value_cents: int(80, 900) * 100,
        created_at: daysAgo(age),
        updated_at: daysAgo(int(0, age)),
        source: pick(["voice", "sms", "email", "web"]),
      }
    }),
    "id, customer_id"
  )

  const quotes = await insertAll(
    "quotes",
    Array.from({ length: N.quotes }, (_, i) => {
      const l = leads[i]
      const svc = pick(services)
      const total = svc.price_cents + int(0, 200) * 100
      return {
        shop_id: shopId,
        customer_id: l.customer_id,
        lead_id: l.id,
        status: pick(["sent", "sent", "viewed", "accepted", "declined"]),
        line_items: [{ service_id: svc.id, name: svc.name, cents: svc.price_cents }],
        subtotal_cents: total,
        total_cents: total,
        created_at: daysAgo(int(0, 60)),
      }
    }),
    "id, lead_id"
  )
  for (const q of quotes) {
    const { error } = await db.from("leads").update({ quote_id: q.id }).eq("id", q.lead_id)
    if (error) throw new Error(`lead.quote_id: ${error.message}`)
  }

  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  await insertAll(
    "appointments",
    Array.from({ length: N.appointments }, (_, i) => {
      const c = customers[(i * 7) % customers.length]
      const svc = pick(services)
      const scheduled =
        i < 8
          ? todayStart.getTime() + (8 + i) * 3_600_000
          : now + (int(-60, 30)) * DAY + int(8, 17) * 3_600_000
      return {
        shop_id: shopId,
        customer_id: c.id,
        lead_id: leads[i % leads.length].id,
        scheduled_at: iso(scheduled),
        duration_minutes: svc.duration_minutes,
        service_name: svc.name,
        quoted_amount_cents: svc.price_cents,
        timezone: "America/New_York",
        created_at: iso(Math.min(now, scheduled - int(1, 10) * DAY)),
        confirmed_at: rnd() < 0.5 ? iso(scheduled - DAY) : null,
      }
    })
  )

  const pendingRows = []
  for (let i = 0; i < N.pending; i++) {
    const c = customers[(i * 11) % customers.length]
    const kind = i % 6 === 5 ? "create_lead" : i % 6 === 4 ? "book_appointment" : i % 6 === 3 ? "add_note" : "send_sms"
    const payload =
      kind === "send_sms"
        ? { to_phone: c.phone, body: `Hi ${c.name.split(" ")[0]} — following up on your quote. Want us to hold Saturday? — Gradia`, customer_name: c.name, customer_id: c.id, reason: "quote follow-up", source: "sms_agent" }
        : kind === "create_lead"
          ? { customer_name: c.name, phone: c.phone, car_info: "black Tesla Model 3", status: "new", source: "voice" }
          : kind === "book_appointment"
            ? { customer_name: c.name, phone: c.phone, service: "Full Detail", iso_start_time: iso(now + int(1, 10) * DAY), duration_minutes: 180, timezone: "America/New_York", source: "voice" }
            : { content: "Prefers morning drop-offs; has two vehicles.", customer_name: c.name, phone: c.phone, source: "whisper" }
    pendingRows.push({ shop_id: shopId, action_type: kind, payload, requested_by: ownerId, status: "pending", created_at: daysAgo(int(0, 5)) })
  }
  // Approved outbound in the last 7 days — feeds the ROI receipt + activity feed.
  for (let i = 0; i < 40; i++) {
    const c = customers[(i * 13) % customers.length]
    pendingRows.push({
      shop_id: shopId,
      action_type: i % 3 === 0 ? "send_email" : "send_sms",
      payload: { to_phone: c.phone, to_email: `perf-${i}@example.test`, subject: "Your detail is booked", body: "See you Saturday at 9. — Gradia", customer_name: c.name, customer_id: c.id, source: "custom_agent" },
      requested_by: ownerId,
      status: "approved",
      created_at: daysAgo(int(0, 6)),
      decided_at: daysAgo(int(0, 6)),
      decided_by_user: ownerId,
    })
  }
  await insertAll("pending_actions", pendingRows)

  const interactions = []
  for (let i = 0; i < N.interactions; i++) {
    const c = customers[(i * 3) % customers.length]
    const voice = i % 5 < 2
    const callId = voice ? `perf-call-${Math.floor(i / 3)}` : null
    interactions.push({
      shop_id: shopId,
      customer_id: c.id,
      channel: voice ? "voice" : "sms",
      role: i % 2 === 0 ? "customer" : "gradia",
      content: i % 2 === 0 ? "Hey, how much for a ceramic coating on a Model 3?" : "For a Model 3 a full ceramic coating runs $1,200 and takes a day — want us to hold a slot?",
      occurred_at: daysAgo(int(0, 60)),
      metadata: voice ? { vapi_call_id: callId } : { twilio_sid: `SM${i}` },
    })
  }
  await insertAll("interactions", interactions)

  await insertAll(
    "payments",
    Array.from({ length: N.payments }, (_, i) => ({
      shop_id: shopId,
      customer_id: customers[(i * 17) % customers.length].id,
      amount_cents: pick(services).price_cents,
      stripe_invoice_id: `perf-${stamp}-inv-${i}`,
      paid_at: daysAgo(int(0, 120)),
    }))
  )

  const { data: link, error: linkErr } = await db.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: `${APP}/auth/callback?next=/dashboard` },
  })
  if (linkErr) throw new Error(`generateLink: ${linkErr.message}`)

  console.log(JSON.stringify({ email, ownerId, shopId, counts: N, magicLink: link.properties?.action_link }, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

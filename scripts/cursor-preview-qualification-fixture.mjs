// Local-only disposable seed for the Cursor preview database (API 58331).
// Refuses any other target. Never a production migration or shared-stack write.
import { readFileSync, existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { createClient } from "@supabase/supabase-js"

const cfg = JSON.parse(readFileSync(".local-tools/cursor-preview-db.json", "utf8"))
if (cfg.API_URL !== "http://127.0.0.1:58331") throw new Error("Cursor preview database required")
const accountsPath = ".local-tools/cursor-preview-account.json"
if (!existsSync(accountsPath)) throw new Error("Preview account file missing")
const state = JSON.parse(readFileSync(accountsPath, "utf8"))
const service = createClient(cfg.API_URL, cfg.SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

function checked(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message} ${result.error.details ?? ""}`)
  return result.data
}

const rpcProbe = await service.rpc("list_lead_qualifications", { p_shop: state.shopId, p_offset: 0 })
if (rpcProbe.error?.code === "PGRST202") {
  throw new Error(
    "Qualification RPCs are missing on this preview database. Apply 20261009100000_lead_qualification.sql locally first."
  )
}

const existing = checked(
  await service.from("lead_workflows").select("id").eq("shop_id", state.shopId).limit(1),
  "existing workflows"
)
if (existing.length) {
  console.log("Qualification preview fixtures already have intake workflows; leaving them in place.")
  process.exit(0)
}

const owner = createClient(cfg.API_URL, cfg.ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})
checked(
  await owner.auth.signInWithPassword({
    email: state.roles.owner.email,
    password: state.roles.owner.password,
  }),
  "owner sign-in"
)

const alex = checked(
  await service.from("customers").select("id,name,phone,email,updated_at").eq("id", state.customers.alex).single(),
  "alex"
)
const jordan = checked(
  await service.from("customers").select("id,name,phone,email,updated_at").eq("id", state.customers.jordan).single(),
  "jordan"
)
const vehicle = checked(
  await service
    .from("vehicles")
    .insert({
      shop_id: state.shopId,
      customer_id: alex.id,
      year: 2021,
      make: "Fictional",
      model: "Coupe",
      color: "Green",
    })
    .select("id")
    .single(),
  "vehicle"
)

async function linkedWorkflow(customer, thread, payload) {
  const recorded = checked(
    await service.rpc("record_lead_intake", {
      p_shop: state.shopId,
      p_channel: "website_form",
      p_provider: "website_form",
      p_event_id: randomUUID(),
      p_received_at: new Date().toISOString(),
      p_evidence_ref: null,
      p_thread_key: thread,
      p_payload: payload,
    }),
    "record intake"
  )
  const body = typeof recorded === "string" ? JSON.parse(recorded) : recorded
  checked(
    await owner.rpc("link_intake_customer", {
      p_shop: state.shopId,
      p_workflow: body.workflow_id,
      p_revision: 1,
      p_customer: customer.id,
      p_snapshot: customer,
      p_command: randomUUID(),
    }),
    "link customer"
  )
  return body.workflow_id
}

const unknownWorkflow = await linkedWorkflow(jordan, "cursor-preview-unknown", {
  display_name: "Jordan Lee (Demo)",
  service_text: "Ceramic coating",
  message: "Local-only unknown qualification fixture.",
})
const staleWorkflow = await linkedWorkflow(alex, "cursor-preview-stale", {
  display_name: "Alex Morgan (Demo)",
  vehicle_text: "2021 Fictional Coupe",
  service_text: "Full detail",
  message: "Local-only stale qualification fixture.",
})

const choices = checked(
  await owner.rpc("intake_vehicle_choices", {
    p_shop: state.shopId,
    p_workflow: staleWorkflow,
    p_revision: 2,
  }),
  "vehicle choices"
)
checked(
  await owner.rpc("link_intake_vehicle", {
    p_shop: state.shopId,
    p_workflow: staleWorkflow,
    p_revision: 2,
    p_customer: alex.id,
    p_customer_updated_at: choices.customer_updated_at,
    p_vehicle: vehicle.id,
    p_snapshot: choices.vehicles[0],
    p_command: randomUUID(),
  }),
  "link vehicle"
)

const reported = { status: "reported", source: "customer", evidence_revision: null }
checked(
  await owner.rpc("update_lead_qualification", {
    p_shop: state.shopId,
    p_workflow: staleWorkflow,
    p_command: randomUUID(),
    p_revision: 0,
    p_customer: alex.id,
    p_vehicle: vehicle.id,
    p_review_state: "reviewed",
    p_fields: {
      service: { ...reported, source: "intake", evidence_revision: 1, service_id: null, text: "Full detail" },
      vehicle_condition: { ...reported, text: "Light swirl marks" },
      timing: { ...reported, earliest: "2026-10-20", latest: "2026-10-31", text: "Weekdays" },
      location: { status: "confirmed", source: "staff", evidence_revision: null, type: "shop", area: null },
      constraints: { ...reported, items: [] },
    },
    p_open_questions: [],
  }),
  "save stale source record"
)

checked(
  await service.rpc("record_lead_intake", {
    p_shop: state.shopId,
    p_channel: "website_form",
    p_provider: "website_form",
    p_event_id: randomUUID(),
    p_received_at: new Date().toISOString(),
    p_evidence_ref: null,
    p_thread_key: "cursor-preview-stale",
    p_payload: { message: "Later submission that makes the saved qualification stale." },
  }),
  "late evidence"
)

console.log("Seeded unknown workflow", unknownWorkflow)
console.log("Seeded stale workflow", staleWorkflow)

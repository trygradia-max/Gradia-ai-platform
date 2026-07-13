/**
 * Automation catalog (CRM C5) — TOGGLES, NOT A BUILDER. Eight pre-built
 * automations; owners flip them on, pick approval|autopilot, and edit the
 * message template. Triggers are CODE on real events (sweeps + the existing
 * confirm/reminder crons routed through here) — no agent loops.
 *
 * Send discipline: everything stages the standard send_sms pending action.
 * approval → it waits in /approvals. autopilot → it executes through
 * executeApproval immediately (the same A2P / quiet-hours / opt-out /
 * metering gate as every outbound), with a credit pre-check first (fail
 * closed) and a Package-2 entitlement gate — without the entitlement an
 * "autopilot" entry degrades to staging, never to silence.
 *
 * HARD FLOOR: entries flagged touches_money_or_calendar can never be
 * autopilot — enforced in autonomy.ts (isAutomationAutopilotAllowed) and
 * locked by guardrails tests. None of the launch 8 carry the flag; the
 * floor exists so a future entry can't quietly cross it.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { isAutomationAutopilotAllowed } from "@/lib/autonomy"
import { hasPackage2 } from "@/lib/entitlements"
import { precheckCredits, type ShopCreditFields } from "@/lib/credits"
import { recordInteraction } from "@/lib/memory"
import type { AutomationMode, ShopRow } from "@/lib/types/database"

export type AutomationCatalogKey =
  | "new_lead_instant"
  | "missed_call_textback"
  | "quote_followup"
  | "lead_revival"
  | "appt_confirmation"
  | "appt_reminder"
  | "job_completed"
  | "review_request"

export type AutomationCatalogEntry = {
  key: AutomationCatalogKey
  /** Plain-English sentence the Settings toggle shows (no vendor names). */
  sentence: string
  detail: string
  /** Spec default mode. Existing shops only ever see behavior change by
   *  opting in: everything defaults OFF except the two that already run
   *  today (#5/#6), which default ON + approval — their exact current
   *  behavior (zero-behavior-change rail). */
  defaultEnabled: boolean
  defaultMode: AutomationMode
  /** Money/calendar floor — such entries can never be autopilot. */
  touchesMoneyOrCalendar: boolean
  /** Default SMS template. {tokens} fill from code, never a model. */
  defaultTemplate: string
}

export const AUTOMATION_CATALOG: AutomationCatalogEntry[] = [
  {
    key: "new_lead_instant",
    sentence: "Text a new lead if nobody's reached out within 5 minutes.",
    detail: "Speed wins the job — an instant reply while they're still shopping.",
    defaultEnabled: false,
    defaultMode: "autopilot",
    touchesMoneyOrCalendar: false,
    defaultTemplate:
      "Hi {customer_name}, it's {shop_name} — thanks for reaching out! What are you looking to get done? Happy to get you a price. — {shop_name}",
  },
  {
    key: "missed_call_textback",
    sentence: "Text back anyone whose call we couldn't take.",
    detail: "A missed call becomes a text thread instead of a lost job.",
    defaultEnabled: false,
    defaultMode: "autopilot",
    touchesMoneyOrCalendar: false,
    defaultTemplate:
      "Hi, it's {shop_name} — sorry we missed your call! Text us here and we'll get you sorted. — {shop_name}",
  },
  {
    key: "quote_followup",
    sentence: "Follow up on quotes that haven't been answered (3 gentle touches).",
    detail: "2, 5, and 12 days after sending — escalating from nudge to last call.",
    defaultEnabled: false,
    defaultMode: "approval",
    touchesMoneyOrCalendar: false,
    defaultTemplate:
      "Hi {customer_name}, just checking you saw the quote we sent over: {quote_link}. Any questions, we're right here. — {shop_name}",
  },
  {
    key: "lead_revival",
    sentence: "Revive leads that went quiet for 3 weeks.",
    detail: "Only leads who actually engaged once — never cold spam.",
    defaultEnabled: false,
    defaultMode: "approval",
    touchesMoneyOrCalendar: false,
    defaultTemplate:
      "Hi {customer_name}, it's {shop_name} — still thinking about getting the car done? We'd love to fit you in this week. — {shop_name}",
  },
  {
    key: "appt_confirmation",
    sentence: "Ask customers to confirm their appointment by text.",
    detail: "Runs today: the confirm-by-text goes out ahead of the visit.",
    defaultEnabled: true, // pre-catalog behavior — do not change
    defaultMode: "approval", // pre-catalog behavior: staged for approval
    touchesMoneyOrCalendar: false,
    defaultTemplate: "", // empty = keep the built-in confirm copy (unchanged)
  },
  {
    key: "appt_reminder",
    sentence: "Send a reminder the day before every appointment.",
    detail: "Runs today: the 24-hour reminder, drafted in our voice.",
    defaultEnabled: true, // pre-catalog behavior — do not change
    defaultMode: "approval", // pre-catalog behavior: staged for approval
    touchesMoneyOrCalendar: false,
    defaultTemplate: "", // empty = keep the drafted reminder copy (unchanged)
  },
  {
    key: "job_completed",
    sentence: "Thank customers when their job wraps, with care instructions.",
    detail: "Lands right after you tap Complete — thanks plus aftercare.",
    defaultEnabled: false,
    defaultMode: "autopilot",
    touchesMoneyOrCalendar: false,
    defaultTemplate:
      "Hi {customer_name}, thanks for trusting {shop_name} with the {services}! Quick care tip: skip washes for 48 hours and rinse gently the first week. Anything looks off, text us. — {shop_name}",
  },
  {
    key: "review_request",
    sentence: "Ask for a review a few hours after a job completes.",
    detail: "Same neutral ask for everyone, with your public review link.",
    defaultEnabled: false,
    defaultMode: "approval",
    touchesMoneyOrCalendar: false,
    defaultTemplate:
      "Hi {customer_name}, thanks again from {shop_name}! If you have a minute, a quick review means the world to a small shop: {review_link} — {shop_name}",
  },
]

export const AUTOMATION_KEYS = AUTOMATION_CATALOG.map((e) => e.key)

export function catalogEntry(key: AutomationCatalogKey): AutomationCatalogEntry {
  const entry = AUTOMATION_CATALOG.find((e) => e.key === key)
  if (!entry) throw new Error(`Unknown automation: ${key}`)
  return entry
}

/** {token} fill — code only, unknown tokens collapse to nothing. */
export function renderTemplate(
  template: string,
  vars: Record<string, string | null | undefined>
): string {
  return template
    .replace(/\{([a-z_]+)\}/g, (_, token: string) => (vars[token] ?? "").trim())
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

export type AutomationConfig = {
  key: AutomationCatalogKey
  automationId: string | null
  enabled: boolean
  mode: AutomationMode
  template: string
  config: Record<string, unknown>
}

type AutomationRowLite = {
  id: string
  catalog_key: string
  enabled: boolean
  mode: AutomationMode
  template_overrides: Record<string, unknown>
  config: Record<string, unknown>
}

/** Merged view: DB row when the owner touched it, catalog defaults otherwise.
 *  Pre-C1 DBs (no automations table) fall back to pure defaults. */
export async function loadAutomationConfigs(
  supabase: SupabaseClient,
  shopId: string
): Promise<Map<AutomationCatalogKey, AutomationConfig>> {
  const out = new Map<AutomationCatalogKey, AutomationConfig>()
  for (const entry of AUTOMATION_CATALOG) {
    out.set(entry.key, {
      key: entry.key,
      automationId: null,
      enabled: entry.defaultEnabled,
      mode: entry.defaultMode,
      template: entry.defaultTemplate,
      config: {},
    })
  }
  const { data, error } = await supabase
    .from("automations")
    .select("id, catalog_key, enabled, mode, template_overrides, config")
    .eq("shop_id", shopId)
  if (error) {
    console.warn("[automations] config load skipped (pre-C1?):", error.message)
    return out
  }
  for (const row of (data as AutomationRowLite[] | null) ?? []) {
    const key = row.catalog_key as AutomationCatalogKey
    const entry = AUTOMATION_CATALOG.find((e) => e.key === key)
    if (!entry) continue
    const template =
      typeof row.template_overrides?.sms === "string" && row.template_overrides.sms.trim()
        ? (row.template_overrides.sms as string)
        : entry.defaultTemplate
    out.set(key, {
      key,
      automationId: row.id,
      enabled: row.enabled,
      // The floor is enforced on write AND on read — a stale autopilot row
      // for a flagged entry degrades to approval.
      mode: isAutomationAutopilotAllowed(key) ? row.mode : "approval",
      template,
      config: row.config ?? {},
    })
  }
  return out
}

/** Find-or-create the automations row (runs need the FK). */
export async function ensureAutomationRow(
  supabase: SupabaseClient,
  shopId: string,
  key: AutomationCatalogKey,
  desired?: { enabled?: boolean; mode?: AutomationMode }
): Promise<string | null> {
  const entry = catalogEntry(key)
  const { data: existing } = await supabase
    .from("automations")
    .select("id")
    .eq("shop_id", shopId)
    .eq("catalog_key", key)
    .maybeSingle()
  if (existing) return (existing as { id: string }).id
  const { data, error } = await supabase
    .from("automations")
    .insert({
      shop_id: shopId,
      catalog_key: key,
      enabled: desired?.enabled ?? entry.defaultEnabled,
      mode: desired?.mode ?? entry.defaultMode,
    })
    .select("id")
    .single()
  if (error || !data) {
    console.warn("[automations] row create skipped (pre-C1?):", error?.message)
    return null
  }
  return (data as { id: string }).id
}

/**
 * Catalog consult for the PRE-EXISTING confirm/reminder crons (#5/#6).
 * Their staging machinery is untouched; they ask two questions here:
 * "is this still on?" and "which copy/mode?". The defaults reproduce
 * today's behavior exactly (enabled + approval + built-in copy), so a shop
 * that never opens the catalog sees zero change — locked by tests.
 */
export async function catalogGateFor(
  supabase: SupabaseClient,
  shopId: string,
  key: AutomationCatalogKey
): Promise<AutomationConfig> {
  const configs = await loadAutomationConfigs(supabase, shopId)
  return configs.get(key)!
}

/**
 * Post-stage hook for #5/#6: record the run for history, and when the owner
 * flipped the entry to autopilot (never the default), execute the already-
 * staged pending action through the one send path — same entitlement +
 * credit + policy gates as every autopilot automation.
 */
export async function afterCatalogStage(
  supabase: SupabaseClient,
  shop: Pick<ShopRow, "id" | "owner_id" | "plan" | "voice_addon" | "credit_period_start">,
  config: AutomationConfig,
  pendingId: string,
  ref: { customerId: string | null; triggerRef: string }
): Promise<"staged" | "sent"> {
  const automationId =
    config.automationId ?? (await ensureAutomationRow(supabase, shop.id, config.key))

  let autopilot = config.mode === "autopilot" && isAutomationAutopilotAllowed(config.key)
  if (autopilot && !hasPackage2(shop)) autopilot = false
  if (autopilot) {
    const credit = await precheckCredits(supabase, shop as ShopCreditFields, 1)
    if (!credit.ok) autopilot = false
  }

  let status: "staged" | "sent" = "staged"
  let held: string | null = null
  if (autopilot) {
    const { executeApproval } = await import("@/lib/approvals")
    const result = await executeApproval(supabase, pendingId, { userId: shop.owner_id })
    if (result.ok && result.status === "executed") status = "sent"
    else if (!result.ok) held = result.error
  }

  if (automationId) {
    await supabase.from("automation_runs").insert({
      shop_id: shop.id,
      automation_id: automationId,
      customer_id: ref.customerId,
      trigger_ref: ref.triggerRef,
      status,
      pending_action_id: pendingId,
      result: held ? { held } : {},
    })
  }
  return status
}

export type AutomationTarget = {
  customerId: string | null
  leadId?: string | null
  toPhone: string
  customerName: string | null
  body: string
  /** Idempotency key — one run per (automation, trigger_ref), ever. */
  triggerRef: string
  reason: string
  category?: "marketing" | "transactional"
}

export type AutomationRunOutcome =
  | { ok: true; status: "sent" | "staged" | "skipped_duplicate" }
  | { ok: false; error: string }

/**
 * Stage-or-send for one target. Approval stages; autopilot executes through
 * the ONE send path (executeApproval → A2P/quiet-hours/opt-out/metering).
 * Fail-closed: credit pre-check before autopilot; missing Package 2
 * degrades autopilot to staging. Every attempt lands in automation_runs.
 */
export async function runAutomationForTarget(
  supabase: SupabaseClient,
  shop: Pick<ShopRow, "id" | "owner_id" | "name" | "plan" | "voice_addon" | "credit_period_start">,
  config: AutomationConfig,
  target: AutomationTarget
): Promise<AutomationRunOutcome> {
  if (!config.enabled) return { ok: true, status: "skipped_duplicate" }

  const automationId =
    config.automationId ??
    (await ensureAutomationRow(supabase, shop.id, config.key, {
      enabled: config.enabled,
      mode: config.mode,
    }))
  if (!automationId) return { ok: false, error: "automations table unavailable (pre-C1?)" }

  // Idempotency — never touch the same trigger twice.
  const { data: priorRun } = await supabase
    .from("automation_runs")
    .select("id")
    .eq("automation_id", automationId)
    .eq("trigger_ref", target.triggerRef)
    .maybeSingle()
  if (priorRun) return { ok: true, status: "skipped_duplicate" }

  const { data: pending, error: pendingErr } = await supabase
    .from("pending_actions")
    .insert({
      shop_id: shop.id,
      action_type: "send_sms",
      payload: {
        to_phone: target.toPhone,
        body: target.body,
        customer_name: target.customerName,
        customer_id: target.customerId,
        reason: target.reason,
        source: `automation:${config.key}`,
        category: target.category ?? "marketing",
      },
      requested_by: shop.owner_id,
    })
    .select("id")
    .single()
  if (pendingErr || !pending) {
    return { ok: false, error: pendingErr?.message ?? "stage failed" }
  }
  const pendingId = (pending as { id: string }).id

  const recordRun = async (status: "staged" | "sent" | "failed", result: Record<string, unknown> = {}) => {
    await supabase.from("automation_runs").insert({
      shop_id: shop.id,
      automation_id: automationId,
      customer_id: target.customerId,
      lead_id: target.leadId ?? null,
      trigger_ref: target.triggerRef,
      status,
      pending_action_id: pendingId,
      result,
    })
  }

  // The floor + entitlement + credit gates decide whether autopilot may fire.
  let autopilot = config.mode === "autopilot" && isAutomationAutopilotAllowed(config.key)
  if (autopilot && !hasPackage2(shop)) {
    autopilot = false // Core shops stay approve-first — degrade, don't drop.
  }
  if (autopilot) {
    const credit = await precheckCredits(supabase, shop as ShopCreditFields, 1)
    if (!credit.ok) autopilot = false // fail closed → wait in /approvals
  }

  if (!autopilot) {
    await recordRun("staged")
    return { ok: true, status: "staged" }
  }

  const { executeApproval } = await import("@/lib/approvals")
  const result = await executeApproval(supabase, pendingId, { userId: shop.owner_id })
  if (!result.ok) {
    // Held by the send path (quiet hours / A2P / opt-out) — the pending
    // action was rolled back to pending and stays visible in /approvals.
    await recordRun("staged", { held: result.error })
    return { ok: true, status: "staged" }
  }

  await recordRun("sent")
  await recordInteraction(supabase, {
    shopId: shop.id,
    customerId: target.customerId,
    channel: "note",
    role: "system",
    content: `Automation sent: ${catalogEntry(config.key).sentence}`,
    metadata: { kind: "automation", catalog_key: config.key, trigger_ref: target.triggerRef },
  })
  return { ok: true, status: "sent" }
}

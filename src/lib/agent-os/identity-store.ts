import type { SupabaseClient } from "@supabase/supabase-js"

import type { DtoResult } from "@/lib/agent-os/definition-dto"
import type { AgentConfig } from "@/lib/types/database"

type Db = { service: SupabaseClient }

export const AGENT_NAME_BOUNDS = { min: 3, max: 80 } as const
/** A workspace holds at most this many Gradia agent identities; bounds abuse of the create action. */
export const MAX_AGENT_IDENTITIES = 50

/**
 * The inert legacy `config` a new, DISABLED identity carries.
 *
 * `custom_agents.config` is NOT NULL and the legacy cards read it directly, so a row needs a
 * valid shape. This one has no recipe, no freeform plan and no schedule: the legacy runtime has
 * nothing to execute (`runnable` is false), the row is created `enabled = false`, and a governed
 * agent can only be enabled inside definition activation. It stores no prompt, provider,
 * credential or tool authority; the real definition lives in immutable revisions.
 */
export function inertLegacyConfig(name: string): AgentConfig {
  return {
    name,
    short_description: "Gradia agent being set up. Nothing runs until it is activated.",
    trigger: { kind: "event", event_summary: "Not configured yet" },
    audience: { entity: "leads", filters_summary: ["Not configured yet"] },
    action: { kind: "flag_for_review", intent_summary: "Not configured yet" },
    prerequisites_needed: [],
    human_in_the_loop_note: "Disabled until the owner activates a reviewed definition.",
  }
}

export function validateAgentName(raw: unknown): { ok: true; name: string } | { ok: false } {
  if (typeof raw !== "string") return { ok: false }
  const name = raw.replace(/\s+/g, " ").trim()
  // Control characters and angle brackets never belong in a display name.
  if (name.length < AGENT_NAME_BOUNDS.min || name.length > AGENT_NAME_BOUNDS.max || /[\p{Cc}\p{Cf}<>]/u.test(name)) return { ok: false }
  return { ok: true, name }
}

export type CreateIdentityResult =
  | { ok: true; agentId: string }
  | { ok: false; code: "forbidden" | "invalid_name" | "limit_reached" | "unavailable" }

/**
 * Creates ONLY a disabled `custom_agents` row. The caller (a server action) supplies the
 * session-derived shop and actor; a live OWNER of that exact shop is re-verified in the
 * database. No definition, memory, tool or policy is created here.
 */
export async function createAgentIdentity(
  deps: Db,
  input: { shopId: string; actorId: string; name: unknown }
): Promise<CreateIdentityResult> {
  const role = await deps.service.rpc("agent_definition_actor_role", { p_shop: input.shopId, p_actor: input.actorId })
  if (role.error) return { ok: false, code: "unavailable" }
  if (role.data !== "owner") return { ok: false, code: "forbidden" }

  const name = validateAgentName(input.name)
  if (!name.ok) return { ok: false, code: "invalid_name" }

  const existing = await deps.service.from("custom_agents").select("id", { count: "exact", head: true }).eq("shop_id", input.shopId)
  if (existing.error || existing.count === null) return { ok: false, code: "unavailable" }
  if (existing.count >= MAX_AGENT_IDENTITIES) return { ok: false, code: "limit_reached" }

  const created = await deps.service
    .from("custom_agents")
    .insert({
      shop_id: input.shopId,
      owner_id: input.actorId,
      name: name.name,
      description: null,
      problem_text: name.name,
      config: inertLegacyConfig(name.name),
      enabled: false,
    })
    .select("id")
    .single()
  if (created.error || !created.data) return { ok: false, code: "unavailable" }
  return { ok: true, agentId: created.data.id as string }
}

// ---------------------------------------------------------------------------
// Read-only reviewed-memory catalog for the Knowledge step
// ---------------------------------------------------------------------------

export type MemorySourceStatus = "selectable" | "awaiting_review" | "revoked" | "expired" | "not_published"

/** IDs, names, revision and status only. Never a body, hash, candidate text or embedding. */
export type MemoryCatalogDto = {
  sources: { sourceId: string; name: string; memoryRevision: number | null; status: MemorySourceStatus }[]
  /** True when more sources exist than were returned. */
  truncated: boolean
}

const CATALOG_LIMIT = 200

export async function readMemoryCatalog(
  deps: Db,
  input: { shopId: string; actorId: string }
): Promise<DtoResult<MemoryCatalogDto>> {
  try {
    const role = await deps.service.rpc("agent_definition_actor_role", { p_shop: input.shopId, p_actor: input.actorId })
    if (role.error) return { status: "unavailable", reason: "role" }
    if (role.data !== "owner" && role.data !== "manager" && role.data !== "staff") return { status: "forbidden" }

    const sources = await deps.service
      .from("reviewed_memory_sources")
      .select("id,source_name")
      .eq("shop_id", input.shopId)
      .order("source_name", { ascending: true })
      .limit(CATALOG_LIMIT + 1)
    if (sources.error) return { status: "unavailable", reason: "sources" }
    const rows = (sources.data ?? []) as { id: string; source_name: string }[]
    const truncated = rows.length > CATALOG_LIMIT
    const visible = rows.slice(0, CATALOG_LIMIT)
    if (visible.length === 0) return { status: "ok", data: { sources: [], truncated: false } }
    const ids = visible.map((s) => s.id)

    const [active, revisions] = await Promise.all([
      deps.service.from("reviewed_memory_active").select("source_id,revision").eq("shop_id", input.shopId).in("source_id", ids),
      deps.service
        .from("reviewed_memory_revisions")
        .select("source_id,revision,state,valid_from,valid_until,retention_until")
        .eq("shop_id", input.shopId)
        .in("source_id", ids)
        .limit(5000),
    ])
    if (active.error || revisions.error) return { status: "unavailable", reason: "memory" }
    if ((revisions.data ?? []).length >= 5000) return { status: "unavailable", reason: "memory_too_large" }

    const now = Date.now()
    const activeBySource = new Map((active.data ?? []).map((a) => [a.source_id as string, a.revision as number]))
    type Rev = { source_id: string; revision: number; state: string; valid_from: string | null; valid_until: string | null; retention_until: string | null }
    const bySource = new Map<string, Rev[]>()
    for (const r of (revisions.data ?? []) as Rev[]) bySource.set(r.source_id, [...(bySource.get(r.source_id) ?? []), r])

    const outOfWindow = (r: Rev) =>
      Boolean((r.valid_from && Date.parse(r.valid_from) > now) || (r.valid_until && Date.parse(r.valid_until) <= now) || (r.retention_until && Date.parse(r.retention_until) <= now))

    return {
      status: "ok",
      data: {
        truncated,
        sources: visible.map((source) => {
          const revs = bySource.get(source.id) ?? []
          const activeRevision = activeBySource.get(source.id) ?? null
          const current = activeRevision === null ? null : revs.find((r) => r.revision === activeRevision) ?? null
          let status: MemorySourceStatus
          if (current && current.state === "published" && !outOfWindow(current)) status = "selectable"
          else if (current && current.state === "published") status = "expired"
          else if (revs.some((r) => r.state === "revoked")) status = "revoked"
          else if (revs.some((r) => r.state === "candidate" || r.state === "reviewed" || r.state === "conflicted")) status = "awaiting_review"
          else status = "not_published"
          return {
            sourceId: source.id,
            name: source.source_name,
            memoryRevision: status === "selectable" ? activeRevision : null,
            status,
          }
        }),
      },
    }
  } catch {
    return { status: "unavailable", reason: "unavailable" }
  }
}

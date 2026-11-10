"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import {
  activateAgentDefinition,
  createAgentDefinitionRevision,
  readActivationEligibility,
  readAgentDetailDto,
  readAgentsHomeDto,
  readBuilderResumeDto,
  readRevisionDto,
  setAgentDefinitionLifecycle,
  type ActivateDefinitionResult,
  type CreateRevisionResult,
  type LifecycleChangeResult,
} from "@/lib/agent-os/definition-store"
import type {
  ActivationEligibilityDto,
  AgentDetailDto,
  AgentsHomeDto,
  BuilderResumeDto,
  DtoResult,
  RevisionDto,
} from "@/lib/agent-os/definition-dto"
import {
  createAgentIdentity,
  readMemoryCatalog,
  type CreateIdentityResult,
  type MemoryCatalogDto,
} from "@/lib/agent-os/identity-store"
import { readCommercialBillingDto, resolveBillingRuntime } from "@/lib/commercial-billing-service"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

/**
 * Session-derived seam over the Agent OS definition store (Build 1; no UI here).
 *
 * Server Functions are reachable by direct POST, so every export derives the actor and
 * shop from the session and the database re-verifies live authority. The shop, actor,
 * policy / knowledge revision, connector, evaluation and billing evidence are NEVER read
 * from arguments. Evaluation evidence has no action here: it is written only by the
 * trusted evaluator seam (`recordTrustedAgentEvaluation`).
 */

const id = z.string().uuid()
const revisionNumber = z.number().int().positive()

async function session() {
  const user = await requireUser()
  const shop = await requireShop()
  return { actorId: user.id, shopId: shop.id }
}

const INVALID = { status: "unavailable", reason: "invalid_request" } as const

async function readDeps() {
  const supabase = await createClient()
  const runtime = resolveBillingRuntime()
  return {
    service: createServiceClient(),
    billing: (shop: string) => readCommercialBillingDto(supabase, runtime, shop),
  }
}

export async function getAgentsHome(): Promise<DtoResult<AgentsHomeDto>> {
  const { actorId, shopId } = await session()
  const { service } = await readDeps()
  return readAgentsHomeDto({ service }, { shopId, actorId })
}

export async function getAgentDetail(agentId: string): Promise<DtoResult<AgentDetailDto>> {
  if (!id.safeParse(agentId).success) return INVALID
  const { actorId, shopId } = await session()
  const deps = await readDeps()
  return readAgentDetailDto(deps, { shopId, actorId, agentId })
}

export async function getBuilderResume(agentId: string): Promise<DtoResult<BuilderResumeDto>> {
  if (!id.safeParse(agentId).success) return INVALID
  const { actorId, shopId } = await session()
  const deps = await readDeps()
  return readBuilderResumeDto(deps, { shopId, actorId, agentId })
}

export async function getAgentRevision(agentId: string, revision: number): Promise<DtoResult<RevisionDto>> {
  if (!id.safeParse(agentId).success || !revisionNumber.safeParse(revision).success) return INVALID
  const { actorId, shopId } = await session()
  const deps = await readDeps()
  return readRevisionDto(deps, { shopId, actorId, agentId, revision })
}

export async function getActivationEligibility(agentId: string, revision: number): Promise<DtoResult<ActivationEligibilityDto>> {
  if (!id.safeParse(agentId).success || !revisionNumber.safeParse(revision).success) return INVALID
  const { actorId, shopId } = await session()
  const deps = await readDeps()
  return readActivationEligibility(deps, { shopId, actorId, agentId, revision })
}

/** Saves an immutable revision. `requestId` makes a retry an exact replay, never a duplicate. */
export async function saveAgentDefinitionRevision(input: {
  agentId: string
  requestId: string
  definition: unknown
  parentRevision?: number | null
  /** The latest revision the editor was looking at (null = none yet). A stale view is a conflict, not an overwrite. */
  expectedLatestRevision?: number | null
}): Promise<CreateRevisionResult> {
  const parsed = z
    .object({ agentId: id, requestId: id, parentRevision: revisionNumber.nullish(), expectedLatestRevision: revisionNumber.nullish() })
    .safeParse({ agentId: input?.agentId, requestId: input?.requestId, parentRevision: input?.parentRevision, expectedLatestRevision: input?.expectedLatestRevision })
  if (!parsed.success) return { ok: false, code: "invalid_definition" }
  const { actorId, shopId } = await session()
  const result = await createAgentDefinitionRevision(
    { service: createServiceClient() },
    {
      shopId,
      actorId,
      agentId: parsed.data.agentId,
      requestId: parsed.data.requestId,
      definition: input.definition,
      parentRevision: parsed.data.parentRevision ?? null,
      // Preserve Build 1 behavior for callers that do not state their view.
      ...(input.expectedLatestRevision === undefined ? {} : { expectedLatest: parsed.data.expectedLatestRevision ?? null }),
    }
  )
  if (result.ok) revalidatePath("/agents")
  return result
}

/** Owner-only. Evidence is server-loaded; the arguments only name what the owner is looking at. */
export async function activateAgentDefinitionRevision(input: {
  agentId: string
  revision: number
  expectedHash: string
  expectedPointer: number | null
}): Promise<ActivateDefinitionResult> {
  const parsed = z
    .object({ agentId: id, revision: revisionNumber, expectedHash: z.string().regex(/^[0-9a-f]{64}$/), expectedPointer: revisionNumber.nullable() })
    .safeParse(input)
  if (!parsed.success) return { ok: false, code: "invalid_definition", reasons: ["invalid_definition"], billing: null }
  const { actorId, shopId } = await session()
  const supabase = await createClient()
  const result = await activateAgentDefinition(
    {
      service: createServiceClient(),
      handoff: { sessionClient: supabase, runtime: resolveBillingRuntime() },
    },
    { shopId, actorId, ...parsed.data }
  )
  if (result.ok) {
    revalidatePath("/agents")
    revalidatePath("/receptionist")
  }
  return result
}

export async function pauseOrBlockAgentDefinition(input: {
  agentId: string
  lifecycle: "paused" | "blocked"
  reason: string
  expectedPointer: number | null
}): Promise<LifecycleChangeResult> {
  const parsed = z
    .object({ agentId: id, lifecycle: z.enum(["paused", "blocked"]), reason: z.string().trim().min(1).max(200), expectedPointer: revisionNumber.nullable() })
    .safeParse(input)
  if (!parsed.success) return { ok: false, code: "invalid" }
  const { actorId, shopId } = await session()
  const result = await setAgentDefinitionLifecycle({ service: createServiceClient() }, { shopId, actorId, ...parsed.data })
  if (result.ok) {
    revalidatePath("/agents")
    revalidatePath("/receptionist")
  }
  return result
}

/**
 * Creates ONLY a disabled `custom_agents` identity (no definition, no memory, no tool, no
 * policy). The shop and actor come from the session; the database-backed role check requires
 * a live owner. Revalidates nothing sensitive: the builder then loads the agent by id.
 */
export async function createGradiaAgentIdentity(input: { name: string }): Promise<CreateIdentityResult> {
  const parsed = z.object({ name: z.string().max(400) }).safeParse({ name: input?.name })
  if (!parsed.success) return { ok: false, code: "invalid_name" }
  const { actorId, shopId } = await session()
  const result = await createAgentIdentity({ service: createServiceClient() }, { shopId, actorId, name: parsed.data.name })
  if (result.ok) revalidatePath("/agents")
  return result
}

/** Read-only catalog of the shop's reviewed memory sources: ids, names, revision and status only. */
export async function getSelectableMemory(): Promise<DtoResult<MemoryCatalogDto>> {
  const { actorId, shopId } = await session()
  return readMemoryCatalog({ service: createServiceClient() }, { shopId, actorId })
}

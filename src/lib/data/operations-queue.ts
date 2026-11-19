import "server-only"

import { z } from "zod"

import {
  operationsOverviewFromPage,
  readOperationsQueuePage,
  unavailableOperationsQueuePage,
  type OperationsOverview,
  type OperationsQueueCursor,
} from "@/lib/operations-queue-reader"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { TEAM_CAPABILITIES, canReadOperationsQueue } from "@/lib/team-permissions"

const workspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  role: z.enum(["owner", "manager", "staff"]),
  capabilities: z.array(z.enum(TEAM_CAPABILITIES)),
  location_id: z.string().uuid(),
})

type QueueOptions = { limit?: number; cursor?: OperationsQueueCursor | null }

/** Owner dashboard loader. Shop context comes from the authenticated request;
 * no client-selected tenant identifier crosses this boundary. The RPC still
 * rechecks current database authority before returning any rows. */
export async function loadOperationsQueueForCurrentShop(options: QueueOptions = {}) {
  const shop = await requireShop()
  const db = await createClient()
  return readOperationsQueuePage(db, shop.id, options)
}

export async function loadOperationsOverviewForCurrentShop(
  options: QueueOptions = {}
): Promise<OperationsOverview> {
  return operationsOverviewFromPage(await loadOperationsQueueForCurrentShop(options))
}

/** Owner/manager workspace loader for the future operations surface. A URL shop
 * selector is only a candidate: the authenticated `team_workspaces` result must
 * contain it with one of the grants that can yield queue rows. The queue RPC then
 * rechecks the same live membership and filters every source independently. */
export async function loadOperationsOverviewForWorkspace(
  workspaceId: string | undefined,
  options: QueueOptions = {}
): Promise<OperationsOverview | null> {
  await requireUser()
  const db = await createClient()
  const result = await db.rpc("team_workspaces")
  const parsed = z.array(workspaceSchema).safeParse(result.data)
  if (result.error || !parsed.success) {
    return operationsOverviewFromPage(unavailableOperationsQueuePage())
  }
  const allowed = parsed.data.filter(canReadOperationsQueue)
  const workspace = workspaceId
    ? allowed.find((candidate) => candidate.id === workspaceId)
    : allowed[0]
  if (!workspace) {
    // A verified membership whose role carries no queue grant has no queue to show: that is
    // "not part of this role" (null), not a failed read. A workspace that cannot be matched to a
    // live membership at all stays unavailable, never an all-clear.
    const known = workspaceId ? parsed.data.find((candidate) => candidate.id === workspaceId) : parsed.data[0]
    return known ? null : operationsOverviewFromPage(unavailableOperationsQueuePage())
  }
  return operationsOverviewFromPage(await readOperationsQueuePage(db, workspace.id, options))
}

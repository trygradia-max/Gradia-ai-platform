import "server-only"

import { readOperationsQueuePage, type OperationsQueueCursor } from "@/lib/operations-queue-reader"
import { requireShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"

/** Owner dashboard loader. Shop context comes from the authenticated request;
 * no client-selected tenant identifier crosses this boundary. The RPC still
 * rechecks current database authority before returning any rows. */
export async function loadOperationsQueueForCurrentShop(options: {
  limit?: number
  cursor?: OperationsQueueCursor | null
} = {}) {
  const shop = await requireShop()
  const db = await createClient()
  return readOperationsQueuePage(db, shop.id, options)
}

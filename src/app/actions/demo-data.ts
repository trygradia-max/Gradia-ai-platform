"use server"

import { revalidatePath } from "next/cache"

import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"

/**
 * Demo-data hygiene (fix-pass 2026-07-13, P2). seed:smoke rows carry
 * explicit demo markers (SMOKE: names, [smoke-seed] notes, smoke metadata,
 * source='demo'); this deletes EXACTLY those rows and nothing else — the
 * founder's real pipeline stays untouched. Owner-confirmed, shop-scoped,
 * RLS-bound (runs as the owner's session).
 */

export type ClearDemoResult =
  | { ok: true; deleted: Record<string, number> }
  | { ok: false; error: string }

export async function clearDemoData(): Promise<ClearDemoResult> {
  await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()

  const deleted: Record<string, number> = {}

  // Order matters for FKs; customers cascade vehicles/quotes/interactions.
  const steps: { table: string; run: () => PromiseLike<{ count: number | null; error: { message: string } | null }> }[] = [
    {
      table: "pending_actions",
      run: () =>
        supabase
          .from("pending_actions")
          .delete({ count: "exact" })
          .eq("shop_id", shop.id)
          .eq("payload->>smoke", "true"),
    },
    {
      table: "appointments",
      run: () =>
        supabase
          .from("appointments")
          .delete({ count: "exact" })
          .eq("shop_id", shop.id)
          .eq("internal_note", "[smoke-seed]"),
    },
    {
      table: "quotes",
      run: () =>
        supabase
          .from("quotes")
          .delete({ count: "exact" })
          .eq("shop_id", shop.id)
          .eq("internal_note", "[smoke-seed]"),
    },
    {
      table: "leads",
      run: () =>
        supabase
          .from("leads")
          .delete({ count: "exact" })
          .eq("shop_id", shop.id)
          .or("customer_name.like.SMOKE:%,source.eq.demo"),
    },
    {
      table: "interactions",
      run: () =>
        supabase
          .from("interactions")
          .delete({ count: "exact" })
          .eq("shop_id", shop.id)
          .eq("metadata->>smoke", "true"),
    },
    {
      table: "custom_agents",
      run: () =>
        supabase
          .from("custom_agents")
          .delete({ count: "exact" })
          .eq("shop_id", shop.id)
          .like("name", "SMOKE:%"),
    },
    {
      table: "customers",
      run: () =>
        supabase
          .from("customers")
          .delete({ count: "exact" })
          .eq("shop_id", shop.id)
          .or("name.like.SMOKE:%,source.eq.demo"),
    },
    {
      table: "services",
      run: () =>
        supabase
          .from("services")
          .delete({ count: "exact" })
          .eq("shop_id", shop.id)
          .like("name", "SMOKE:%"),
    },
  ]

  for (const step of steps) {
    const { count: n, error } = await step.run()
    if (error) {
      // Pre-migration tables (quotes) just skip — never block the sweep.
      console.warn(`[demo-data] ${step.table} skipped:`, error.message)
      continue
    }
    if (n && n > 0) deleted[step.table] = n
  }

  revalidatePath("/dashboard")
  revalidatePath("/customers")
  revalidatePath("/calendar")
  return { ok: true, deleted }
}

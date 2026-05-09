import { OnboardingWizard } from "@/components/gradia/onboarding-wizard"
import { requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { ServiceRow, ShopRow } from "@/lib/types/database"

export const dynamic = "force-dynamic"

export default async function OnboardingPage() {
  await requireUser()
  const supabase = await createClient()

  const { data: shopRow } = await supabase
    .from("shops")
    .select("*")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()

  const shop = (shopRow as ShopRow | null) ?? null

  let services: ServiceRow[] = []
  if (shop) {
    const { data } = await supabase
      .from("services")
      .select("*")
      .eq("shop_id", shop.id)
      .order("created_at", { ascending: true })
    services = (data as ServiceRow[] | null) ?? []
  }

  let initialStep: 1 | 2 | 3 = 1
  if (shop && services.length === 0) initialStep = 2
  if (shop && services.length > 0) initialStep = 3

  return (
    <div className="flex min-h-svh flex-col items-center bg-background p-4 sm:justify-center sm:p-6">
      <OnboardingWizard
        initialShop={shop}
        initialServices={services}
        initialStep={initialStep}
      />
    </div>
  )
}

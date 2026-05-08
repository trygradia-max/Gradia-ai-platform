import { redirect } from "next/navigation"

import { getOptionalShop } from "@/lib/shop"
import { OnboardingForm } from "@/components/gradia/onboarding-form"

export const dynamic = "force-dynamic"

export default async function OnboardingPage() {
  const shop = await getOptionalShop()
  if (shop) {
    redirect("/dashboard")
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-background p-6">
      <OnboardingForm />
    </div>
  )
}

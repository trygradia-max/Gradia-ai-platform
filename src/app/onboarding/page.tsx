import { redirect } from "next/navigation"
import { getChannelReadiness } from "@/app/actions/channel-readiness"
import { getA2pState } from "@/app/actions/a2p"
import { GrainOverlay } from "@/components/gradia/grain-overlay"
import { MeshBackground } from "@/components/gradia/mesh-background"
import { OnboardingWizard } from "@/components/gradia/onboarding-wizard"
import { integrationAvailability } from "@/lib/data/connections"
import { deriveWizardStep } from "@/lib/onboarding"
import { STRINGS } from "@/lib/strings"
import { getOptionalShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { listVoiceOptions } from "@/lib/voice-provider"
import type { ShopRow } from "@/lib/types/database"

export const dynamic = "force-dynamic"

type Step = 1 | 2 | 3

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string; step?: string }>
}) {
  await requireUser()
  const supabase = await createClient()
  const { new: isNew, step: stepParam } = await searchParams
  const startFresh = isNew === "1"

  // For "add another shop" we deliberately ignore any existing shop
  // and start the wizard from step 1 with a blank canvas. RLS is
  // fine with the user having multiple rows in shops; the active
  // cookie + the switcher pick which one is "selected" later.
  const activeShop = startFresh ? null : await getOptionalShop()
  const { data: shopRow } = !activeShop
    ? { data: null }
    : await supabase
        .from("shops")
        .select("*")
        .eq("id", activeShop.id)
        .maybeSingle()

  const shop = (shopRow as ShopRow | null) ?? null

  // Existing owners retain onboarding. Invited teammates land in their scoped workspace.
  if (!shop && !startFresh) {
    const { data: memberships, error } = await supabase.rpc("team_workspaces")
    if (!error && memberships?.length) redirect("/team")
  }

  // Saved progress wins. Old links used step 5 for the number and step 6
  // for phone help.
  const requested = Number.parseInt(stepParam ?? "", 10)
  const requestedStep: Step | null =
    requested === 1 || requested === 2 || requested === 3
      ? requested
      : requested === 5
        ? 2
        : requested === 6
          ? 3
          : null
  const initialStep: Step =
    requestedStep && shop && !startFresh
      ? requestedStep
      : startFresh
        ? 1
        : deriveWizardStep(shop)

  const isResuming = Boolean(shop) && !startFresh
  const a2pState = shop ? await getA2pState() : { status: "none" as const, failureReason: null, business: null }
  const readiness = shop ? await getChannelReadiness() : undefined
  const voiceOptions = listVoiceOptions()
  const vapiConfigured = integrationAvailability().voice

  return (
    <div className="relative isolate flex min-h-svh flex-col items-center justify-center gap-8 overflow-hidden bg-background px-4 py-12 sm:px-6">
      <GrainOverlay />
      <MeshBackground />

      <header className="relative max-w-xl space-y-2.5 text-center">
        <p className="label-eyebrow text-muted-foreground/70">
          {startFresh
            ? STRINGS.pages.onboarding.eyebrowFresh
            : isResuming
              ? STRINGS.pages.onboarding.eyebrowResume
              : STRINGS.pages.onboarding.eyebrowStart}
        </p>
        <h1 className="font-display text-[clamp(1.875rem,5vw,2.75rem)] leading-[1.05] tracking-[-0.025em] text-foreground">
          {startFresh
            ? STRINGS.pages.onboarding.headlineFresh
            : STRINGS.pages.onboarding.headlineStart}
        </h1>
        <p className="mx-auto max-w-md text-sm text-muted-foreground">
          {STRINGS.pages.onboarding.body}
        </p>
      </header>

      <OnboardingWizard
        initialShop={shop}
        initialStep={initialStep}
        forceCreate={startFresh}
        a2pState={a2pState}
        readiness={readiness}
        voiceOptions={voiceOptions}
        vapiConfigured={vapiConfigured}
      />
    </div>
  )
}

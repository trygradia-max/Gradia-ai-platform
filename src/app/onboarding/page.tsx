import { getA2pState } from "@/app/actions/a2p"
import { GrainOverlay } from "@/components/gradia/grain-overlay"
import { MeshBackground } from "@/components/gradia/mesh-background"
import { OnboardingWizard } from "@/components/gradia/onboarding-wizard"
import { deriveWizardStep } from "@/lib/onboarding"
import { requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { listVoiceOptions } from "@/lib/voice-provider"
import type { ServiceRow, ShopRow } from "@/lib/types/database"

export const dynamic = "force-dynamic"

type Step = 1 | 2 | 3 | 4 | 5

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
  const { data: shopRow } = startFresh
    ? { data: null }
    : await supabase
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

  // ?step= override (the OAuth return lands on step 4); otherwise resume
  // at the first incomplete step.
  const requested = Number.parseInt(stepParam ?? "", 10)
  const initialStep: Step =
    requested >= 1 && requested <= 5 && shop && !startFresh
      ? (requested as Step)
      : startFresh
        ? 1
        : deriveWizardStep(shop, services.length)

  const isResuming = Boolean(shop) && !startFresh
  const a2pState = shop ? await getA2pState() : { status: "none" as const, failureReason: null, business: null }
  const voiceOptions = listVoiceOptions()
  const vapiConfigured = Boolean(process.env.VAPI_API_KEY?.trim())

  return (
    <div className="relative isolate flex min-h-svh flex-col items-center justify-center gap-8 overflow-hidden bg-background px-4 py-12 sm:px-6">
      <GrainOverlay />
      <MeshBackground />

      <header className="relative max-w-xl space-y-2.5 text-center">
        <p className="label-eyebrow text-muted-foreground/70">
          {startFresh
            ? "Add another shop"
            : isResuming
              ? "Pick up where we left off"
              : "Set up the shop"}
        </p>
        <h1 className="font-display text-[clamp(1.875rem,5vw,2.75rem)] leading-[1.05] tracking-[-0.025em] text-foreground">
          {startFresh ? (
            <>
              A <span className="italic">second</span>{" "}shop, same setup.
            </>
          ) : (
            <>
              Let&apos;s <span className="italic">wire</span>{" "}the shop up.
            </>
          )}
        </h1>
        <p className="mx-auto max-w-md text-sm text-muted-foreground">
          Five short steps — your shop, your menu, then the inbox, number,
          and receptionist. Skip anything; we&apos;ll nudge you later.
          Everything&apos;s editable in Settings.
        </p>
      </header>

      <OnboardingWizard
        initialShop={shop}
        initialServices={services}
        initialStep={initialStep}
        forceCreate={startFresh}
        a2pState={a2pState}
        voiceOptions={voiceOptions}
        vapiConfigured={vapiConfigured}
      />
    </div>
  )
}

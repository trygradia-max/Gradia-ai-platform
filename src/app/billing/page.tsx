import Link from "next/link"

import { getUsageState } from "@/app/actions/billing"
import {
  BillingSubscribe,
  VoiceAddonToggle,
} from "@/components/gradia/billing-subscribe"
import { UsageMeters } from "@/components/gradia/usage-meters"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export const dynamic = "force-dynamic"

export default async function BillingPage() {
  const usage = await getUsageState()
  const active = usage.plan === "active"

  return (
    <div className="mx-auto flex min-h-svh max-w-xl flex-col justify-center gap-6 p-6">
      {/* Always-visible way back — this page sits outside the dashboard
          shell, and pre-subscription visitors previously had no in-app
          exit (2026-07-13 master audit P1). If onboarding isn't finished,
          the dashboard gate resumes the wizard automatically. */}
      <div className="flex items-center justify-between">
        <span className="font-display text-sm tracking-tight text-muted-foreground">
          Gradia
        </span>
        <Link
          href="/dashboard"
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          Back to dashboard
        </Link>
      </div>
      <Card className="border-border/70">
        <CardHeader className="space-y-1">
          <CardTitle className="font-display text-2xl tracking-tight">
            {active ? "Your Gradia plan" : "Activate Gradia"}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            From $20/month — chat agent, follow-ups, Whisper, Ask Gradia, and
            approvals, with ~300 texts of credits included. Voice receptionist
            + business number is +$29.
          </p>
        </CardHeader>
        <CardContent className="grid gap-5">
          {active ? (
            <>
              <p className="text-sm">
                You&apos;re on{" "}
                <span className="font-medium">
                  {usage.voiceAddon
                    ? "Core + Voice — $49/mo"
                    : "Gradia Core — $20/mo"}
                </span>
                .
              </p>
              <UsageMeters usage={usage} />
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 pt-4">
                <VoiceAddonToggle active={usage.voiceAddon} />
              </div>
            </>
          ) : (
            <BillingSubscribe />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

import Link from "next/link"
import { TriangleAlert } from "lucide-react"

import { getUsageState } from "@/app/actions/billing"
import { TierChooser } from "@/components/gradia/billing-subscribe"
import { UsageMeters } from "@/components/gradia/usage-meters"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { formatUsd, TIERS } from "@/lib/pricing"

export const dynamic = "force-dynamic"

/**
 * Numbers & Billing (P0-013 — three tiers, D-031/D-034). Every price on this
 * page is read from PLAN. Three states: not subscribed (chooser), active
 * (current plan + meters + switch), past_due (what is paused, what to do).
 */
export default async function BillingPage() {
  const usage = await getUsageState()
  const active = usage.plan === "active"
  const pastDue = usage.plan === "past_due"
  const subscribed = active || pastDue
  const tier = TIERS[usage.tier]
  const trialEnds =
    usage.inTrial && usage.trialEndsAt
      ? new Date(usage.trialEndsAt).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        })
      : null

  return (
    <div className="mx-auto flex min-h-svh max-w-3xl flex-col justify-center gap-6 p-6">
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
            {subscribed ? "Your Gradia plan" : "Choose your Gradia plan"}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {subscribed
              ? `You're on ${tier.label} — ${formatUsd(tier.priceCents)}/month.${
                  trialEnds ? ` Trial through ${trialEnds}; the trial allowance applies until then.` : ""
                }`
              : `From ${formatUsd(TIERS.core.priceCents)}/month. Every plan runs the full CRM, Gradia Agent, Whisper, Ask Gradia, approvals and imports; the plans differ in how much Gradia does and through which channels.`}
          </p>
        </CardHeader>
        <CardContent className="grid gap-6">
          {pastDue ? (
            <div
              role="status"
              className="flex items-start gap-3 rounded-md border border-status-danger/30 bg-status-danger-bg px-4 py-3"
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-status-danger-fg" aria-hidden />
              <div className="space-y-1 text-sm">
                <p className="font-medium text-foreground">Your last payment failed.</p>
                <p className="text-muted-foreground">
                  Stripe retries the card over the next few days. Until it clears,
                  sending, agents and the receptionist are paused — nothing leaves the
                  shop and nothing is charged twice. Your data and queue stay put.
                </p>
              </div>
            </div>
          ) : null}

          {subscribed ? <UsageMeters usage={usage} /> : null}

          <div className="space-y-3">
            {subscribed ? (
              <p className="label-eyebrow text-muted-foreground/70">Change plan</p>
            ) : null}
            <TierChooser currentTier={usage.tier} subscribed={subscribed} />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

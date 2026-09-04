"use client"

import * as React from "react"
import { Check, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { changePlanTier, startSubscriptionCheckout } from "@/app/actions/billing"
import { Button } from "@/components/ui/button"
import { formatUsd, PLAN, TIER_ORDER, TIERS, type TierSpec } from "@/lib/pricing"
import type { ShopTier } from "@/lib/types/database"
import { cn } from "@/lib/utils"

/** Full-page navigation — pulled out of the component body per the
 *  react-hooks/immutability rule (external-object mutation belongs in a
 *  plain function, not inlined in a component). */
function navigateTo(url: string): void {
  window.location.href = url
}

function reloadPage(): void {
  window.location.reload()
}

/**
 * The three-tier chooser (P0-013 — D-031/D-034). Every number on screen is
 * read from PLAN — no price literal lives in this file (source-scan locked).
 * Before a subscription: "Start <tier>" → Stripe Checkout (14-day trial,
 * card up front — D-035 interim). On a live subscription: the current tier
 * is marked and the others read "Switch to <tier>" — prorated by Stripe; the
 * tier flips when the webhook confirms, never optimistically.
 */
export function TierChooser({
  currentTier,
  subscribed,
}: {
  /** The shop's tier (meaningful when subscribed). */
  currentTier: ShopTier
  /** True on a live subscription (active or past_due). */
  subscribed: boolean
}) {
  const [busy, setBusy] = React.useState<ShopTier | null>(null)

  async function choose(tier: ShopTier) {
    if (busy) return
    setBusy(tier)
    if (!subscribed) {
      const result = await startSubscriptionCheckout(tier)
      if (!result.ok) {
        setBusy(null)
        toast.error(result.error)
        return
      }
      navigateTo(result.url)
      return
    }
    const result = await changePlanTier(tier)
    setBusy(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(
      `Switching to ${TIERS[tier].label} — Stripe prorates the difference; your plan updates here as soon as it confirms.`
    )
    reloadPage()
  }

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {TIER_ORDER.map((key) => {
        const tier = TIERS[key]
        const isCurrent = subscribed && key === currentTier
        return (
          <TierCard
            key={key}
            tier={tier}
            isCurrent={isCurrent}
            subscribed={subscribed}
            busy={busy === key}
            disabled={busy !== null || isCurrent}
            onChoose={() => choose(key)}
          />
        )
      })}
      <p className="text-xs text-muted-foreground sm:col-span-3">
        {subscribed
          ? "Switching plans is prorated by Stripe. Money and calendar actions always ask first, on every plan."
          : `${PLAN.TRIAL.days}-day trial, card required to start. Trial usage limits apply (${PLAN.TRIAL.credits.toLocaleString("en-US")} credits, ${PLAN.TRIAL.minutes} minutes). Money and calendar actions always ask first, on every plan.`}
      </p>
    </div>
  )
}

/** What each tier includes — derived from the spec, in narrator voice. */
function includes(tier: TierSpec): string[] {
  const lines = [
    `${tier.includedCredits.toLocaleString("en-US")} message credits a month`,
  ]
  if (tier.voice) {
    lines.push(`Voice receptionist + business number · ${tier.includedMinutes} minutes a month`)
  } else {
    lines.push("Texts, emails, follow-ups — approve-first")
  }
  if (tier.autonomy) lines.push("Earned autonomy, per agent, reversible")
  if (tier.teamSeats) lines.push("Team seats, multi-user")
  if (tier.prioritySupport) lines.push("Priority support")
  return lines
}

function TierCard({
  tier,
  isCurrent,
  subscribed,
  busy,
  disabled,
  onChoose,
}: {
  tier: TierSpec
  isCurrent: boolean
  subscribed: boolean
  busy: boolean
  disabled: boolean
  onChoose: () => void
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-md border bg-card p-4",
        isCurrent ? "border-primary/60" : "border-border/60"
      )}
      aria-current={isCurrent ? "true" : undefined}
    >
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-foreground">{tier.label}</p>
          {isCurrent ? (
            <span className="label-eyebrow text-primary">Current plan</span>
          ) : null}
        </div>
        <p className="font-data text-2xl font-semibold text-foreground">
          {formatUsd(tier.priceCents)}
          <span className="ml-1 text-xs font-normal text-muted-foreground">/month</span>
        </p>
        <p className="text-xs text-muted-foreground">{tier.tagline}</p>
      </div>
      <ul className="space-y-1.5 text-xs text-muted-foreground">
        {includes(tier).map((line) => (
          <li key={line} className="flex items-start gap-1.5">
            <Check className="mt-0.5 size-3 shrink-0 text-primary" aria-hidden />
            <span>{line}</span>
          </li>
        ))}
      </ul>
      <Button
        type="button"
        variant={isCurrent ? "outline" : "default"}
        size="sm"
        disabled={disabled}
        onClick={onChoose}
        className="mt-auto gap-2"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
        {isCurrent
          ? "Your plan"
          : subscribed
            ? `Switch to ${tier.label}`
            : `Start ${tier.label} — ${formatUsd(tier.priceCents)}/mo`}
      </Button>
    </div>
  )
}

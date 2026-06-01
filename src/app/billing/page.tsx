import Link from "next/link"

import { getCreditUsage } from "@/app/actions/billing"
import { BillingSubscribe } from "@/components/gradia/billing-subscribe"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export const dynamic = "force-dynamic"

export default async function BillingPage() {
  const usage = await getCreditUsage()
  const active = usage.plan === "active"

  return (
    <div className="mx-auto flex min-h-svh max-w-xl flex-col justify-center gap-6 p-6">
      <Card className="border-border/70">
        <CardHeader className="space-y-1">
          <CardTitle className="font-display text-2xl tracking-tight">
            {active ? "Your Gradia plan" : "Activate Gradia"}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            One plan — $20/month per shop. Voice, chat, calendar, CRM, and
            email, all through one approved brain.
          </p>
        </CardHeader>
        <CardContent className="grid gap-4">
          {active ? (
            <>
              <p className="text-sm">
                You&apos;re on the <span className="font-medium">$20/mo</span>{" "}
                plan — {usage.remaining} of {usage.limit} credits left this
                period.
              </p>
              <Link href="/dashboard" className={buttonVariants()}>
                Back to dashboard
              </Link>
            </>
          ) : (
            <BillingSubscribe />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

"use client"

import * as React from "react"
import { CalendarCheck, CheckCircle2, Loader2 } from "lucide-react"

import { respondToQuote } from "@/app/actions/quote-response"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { QuoteStatus } from "@/lib/types/database"

/**
 * Accept / decline panel on the public quote page. Accepting with a time
 * stages a booking request the shop approves — the page never promises a
 * confirmed slot (calendar writes stay human-approved).
 */
export function QuoteResponsePanel({
  token,
  status,
  expired,
  calendarLink,
  shopPhone,
}: {
  token: string
  status: QuoteStatus
  expired: boolean
  calendarLink: string | null
  shopPhone: string | null
}) {
  const [state, setState] = React.useState<QuoteStatus>(status)
  const [busy, setBusy] = React.useState(false)
  const [bookingStaged, setBookingStaged] = React.useState(false)
  const [when, setWhen] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)

  async function respond(response: "accept" | "decline") {
    setBusy(true)
    setError(null)
    const iso = when ? new Date(when).toISOString() : null
    const result = await respondToQuote(token, response, iso)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setState(result.status)
    setBookingStaged(result.bookingStaged)
  }

  if (expired) return null

  if (state === "accepted") {
    return (
      <section className="rounded-2xl border border-border/60 bg-card p-6 text-center">
        <CheckCircle2 className="mx-auto size-6 text-status-success-fg" aria-hidden />
        <p className="mt-2 font-display text-lg text-foreground">
          You&apos;re in — quote accepted.
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {bookingStaged
            ? "We got your preferred time and will text to confirm the exact slot."
            : calendarLink
              ? "Grab a time that works below."
              : `We'll reach out shortly to schedule.${shopPhone ? ` Or call us at ${shopPhone}.` : ""}`}
        </p>
        {calendarLink ? (
          <a
            href={calendarLink}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex h-11 items-center gap-2 rounded-sm bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <CalendarCheck className="size-4" aria-hidden />
            Pick a time
          </a>
        ) : null}
      </section>
    )
  }

  if (state === "declined") {
    return (
      <section className="rounded-2xl border border-border/60 bg-card p-6 text-center">
        <p className="font-display text-lg text-foreground">No problem.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Thanks for letting us know — the door&apos;s open if plans change.
        </p>
      </section>
    )
  }

  return (
    <section className="space-y-4 rounded-2xl border border-border/60 bg-card p-6">
      {calendarLink ? null : (
        <div className="space-y-1.5">
          <Label htmlFor="quote-when">When works best? (optional)</Label>
          <Input
            id="quote-when"
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            We&apos;ll text to confirm the exact slot — nothing&apos;s locked in yet.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          type="button"
          size="lg"
          className="h-11 flex-1 gap-2"
          disabled={busy}
          onClick={() => respond("accept")}
        >
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Book it
        </Button>
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="h-11"
          disabled={busy}
          onClick={() => respond("decline")}
        >
          Not this time
        </Button>
      </div>
      {error ? <p className="text-sm text-status-danger-fg">{error}</p> : null}
    </section>
  )
}

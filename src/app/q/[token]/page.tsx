import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { loadPublicQuote } from "@/app/actions/quote-response"
import { QuoteResponsePanel } from "@/components/gradia/quote-response-panel"
import { formatPriceUsd } from "@/lib/service-pricing"
import { describeVehicle } from "@/lib/vehicles"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Your quote",
  robots: { index: false, follow: false },
}

/**
 * Branded public quote page (CRM C3b) — /q/[token]. No auth: the unguessable
 * token scopes access to exactly one quote. No vendor names, shop identity
 * up top, one clear action. First open stamps viewed_at (in loadPublicQuote).
 */
export default async function PublicQuotePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const quote = await loadPublicQuote(token)
  if (!quote || !quote.shops) notFound()

  const shop = quote.shops
  const vehicle = describeVehicle(quote.vehicles)
  const bookingMode = shop.voice_config?.booking_mode ?? "propose_booking"
  const calendarLink =
    bookingMode === "calendar_link"
      ? shop.voice_config?.calendar_link?.trim() || null
      : null
  const expired = Boolean(
    quote.valid_until && new Date(quote.valid_until) < new Date()
  )

  return (
    <main className="min-h-screen bg-background px-4 py-10 text-foreground sm:py-16">
      <div className="mx-auto w-full max-w-lg space-y-6">
        <header className="space-y-1 text-center">
          <p className="label-eyebrow text-muted-foreground/70">Quote</p>
          <h1 className="font-display text-3xl">{shop.name}</h1>
          {shop.location ? (
            <p className="text-sm text-muted-foreground">{shop.location}</p>
          ) : null}
        </header>

        <section className="rounded-2xl border border-border/60 bg-card p-6">
          {quote.customers?.name ? (
            <p className="text-sm text-muted-foreground">
              For {quote.customers.name}
              {vehicle ? ` · ${vehicle}` : ""}
            </p>
          ) : null}

          <ul className="mt-4 divide-y divide-border/40">
            {(quote.line_items ?? []).map((li, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3 py-2.5">
                <span className="text-sm text-foreground">{li.name ?? "Service"}</span>
                <span className="font-data text-sm text-foreground">
                  {formatPriceUsd(li.price_cents)}
                </span>
              </li>
            ))}
          </ul>

          {quote.discount_cents > 0 ? (
            <div className="flex items-baseline justify-between border-t border-border/40 pt-2.5 text-sm text-muted-foreground">
              <span>Discount</span>
              <span className="font-data">−{formatPriceUsd(quote.discount_cents)}</span>
            </div>
          ) : null}

          <div className="mt-3 flex items-baseline justify-between border-t border-border/60 pt-3">
            <span className="text-sm font-medium text-foreground">Total</span>
            <span className="font-data text-2xl font-semibold text-foreground">
              {formatPriceUsd(quote.total_cents)}
            </span>
          </div>

          {quote.customer_note ? (
            <p className="mt-4 rounded-lg bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              {quote.customer_note}
            </p>
          ) : null}

          {quote.valid_until ? (
            <p className="mt-3 text-xs text-muted-foreground">
              {expired
                ? `This quote expired on ${quote.valid_until}. Reach out and we'll refresh it.`
                : `Good through ${quote.valid_until}.`}
            </p>
          ) : null}
        </section>

        <QuoteResponsePanel
          token={token}
          status={quote.status}
          expired={expired}
          calendarLink={calendarLink}
          shopPhone={shop.phone}
        />

        <footer className="text-center text-xs text-muted-foreground">
          Questions? {shop.phone ? `Call or text us at ${shop.phone}.` : "Reply to our message anytime."}
        </footer>
      </div>
    </main>
  )
}

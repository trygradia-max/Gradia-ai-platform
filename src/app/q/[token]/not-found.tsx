/**
 * Customer-facing 404 for public quote links — an invalid or revoked token
 * lands here instead of a generic error (2026-07-13 master audit P1). The
 * reader is the SHOP'S customer, not the owner: no dashboard links, no
 * vendor names, one honest instruction.
 */

export default function QuoteNotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <div className="w-full max-w-lg space-y-1 rounded-md border border-border/60 bg-card px-6 py-12 text-center">
        <p className="label-eyebrow text-muted-foreground/70">Quote</p>
        <p className="font-display text-2xl tracking-tight">
          This quote link isn&apos;t active anymore.
        </p>
        <p className="mx-auto max-w-sm pt-1.5 text-sm text-muted-foreground">
          It may have expired or been replaced. Reply to the message that
          sent you here — or call the shop — and they&apos;ll send you a
          fresh one.
        </p>
      </div>
    </main>
  )
}

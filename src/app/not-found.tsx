/**
 * Branded 404 — replaces Next's default for every notFound() call and
 * unmatched route (2026-07-13 master audit P1). Copy is audience-neutral:
 * owners hit this from stale dashboard links; a shop's customers can hit
 * it from expired public links (the /q/[token] segment has its own,
 * quote-specific version).
 */

import Link from "next/link"

import { Button } from "@/components/ui/button"

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6">
      <div className="w-full max-w-md rounded-md border border-border/60 bg-card/40 px-6 py-12 text-center">
        <p className="font-display text-xl tracking-tight text-foreground">
          That page isn&apos;t here.
        </p>
        <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
          The link may be old, or the page may have moved. If someone sent
          you this link, ask them for a fresh one.
        </p>
        <div className="mt-4 flex justify-center">
          <Button variant="outline" render={<Link href="/" />}>
            Go to Home
          </Button>
        </div>
      </div>
    </div>
  )
}

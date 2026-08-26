/**
 * Dashboard-level not-found (P0-010) — renders inside the sidebar shell for
 * notFound() thrown by dashboard segments (missing customer, dead deep link),
 * so the owner keeps their navigation instead of the bare root 404.
 */

import Link from "next/link"

import { Button } from "@/components/ui/button"
import { STRINGS } from "@/lib/strings"

export default function DashboardNotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6">
      <div className="w-full max-w-md rounded-md border border-border/60 bg-card/40 px-6 py-12 text-center">
        <p className="font-display text-xl tracking-tight text-foreground">
          {STRINGS.errors.notFoundTitle}
        </p>
        <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
          {STRINGS.errors.notFoundBody}
        </p>
        <div className="mt-4 flex justify-center">
          <Button variant="outline" render={<Link href="/dashboard" />}>
            {STRINGS.errors.notFoundHome}
          </Button>
        </div>
      </div>
    </div>
  )
}

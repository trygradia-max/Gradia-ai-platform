"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { STRINGS } from "@/lib/strings"

/** Re-reads consent, evidence, definition and CRM state from the database. Never changes anything. */
export function RefreshButton({ label = STRINGS.pages.callReview.refresh }: { label?: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <div className="flex flex-col items-start gap-1">
      <Button type="button" variant="outline" className="min-h-11" disabled={pending} aria-busy={pending} onClick={() => startTransition(() => router.refresh())}>
        <RefreshCw className={pending ? "size-4 animate-spin motion-reduce:animate-none" : "size-4"} aria-hidden />
        {pending ? STRINGS.pages.callReview.refreshing : label}
      </Button>
      <span className="text-xs text-muted-foreground">{STRINGS.pages.callReview.refreshHint}</span>
    </div>
  )
}

"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Loader2, Star } from "lucide-react"
import { toast } from "sonner"

import { saveReviewLink } from "@/app/actions/shop"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MotionCard } from "@/components/gradia/motion/motion-card"

/**
 * Settings card for the shop's public review link (NEXT-1). The link feeds the
 * review-request feature — Gradia drops it into every review ask, so it has to
 * be the shop's real Google/Yelp review URL.
 */
export function ReviewLinkCard({ initial }: { initial: string | null }) {
  const router = useRouter()
  const [value, setValue] = React.useState(initial ?? "")
  const [saving, setSaving] = React.useState(false)

  const dirty = value.trim() !== (initial ?? "")

  async function save() {
    setSaving(true)
    const result = await saveReviewLink({ review_link: value.trim() || null })
    setSaving(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(
      result.reviewLink ? "Review link saved." : "Review link cleared."
    )
    router.refresh()
  }

  return (
    <MotionCard interactive={false} className="space-y-4 p-6">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
          <Star className="size-4" aria-hidden />
        </div>
        <div className="space-y-1">
          <p className="font-medium text-foreground">Review link</p>
          <p className="max-w-prose text-sm text-muted-foreground">
            Paste your Google or Yelp review URL. When you ask a customer for a
            review, we&apos;ll include this link — sent the same way to everyone.
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          type="url"
          inputMode="url"
          placeholder="https://g.page/r/…/review"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="flex-1"
        />
        <Button
          type="button"
          onClick={save}
          disabled={saving || !dirty}
          className="h-10 gap-2 sm:w-28"
        >
          {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Save
        </Button>
      </div>
    </MotionCard>
  )
}

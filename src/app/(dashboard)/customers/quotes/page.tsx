import Link from "next/link"
import { FileText } from "lucide-react"

import { listQuotesForCurrentShop } from "@/app/actions/quotes"
import { QuotesList } from "@/components/gradia/quotes-list"
import { SectionHeader } from "@/components/gradia/section-header"
import { buttonVariants } from "@/components/ui/button"
import { requireShop } from "@/lib/shop"
import { STRINGS } from "@/lib/strings"
import { cn } from "@/lib/utils"

export const dynamic = "force-dynamic"

/** Quotes stay off the daily nav. Open them from a customer or from here. */
export default async function QuotesPage() {
  await requireShop()
  const quotes = await listQuotesForCurrentShop()
  const s = STRINGS.pages.quotes

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <SectionHeader
          level={1}
          eyebrow={s.eyebrow}
          title={s.title}
          subhead={s.subtitle}
        />
        <Link
          href="/customers/quotes/new"
          className={cn(buttonVariants({ size: "lg" }), "h-11 shrink-0 gap-2")}
        >
          <FileText className="size-4" aria-hidden />
          New quote
        </Link>
      </div>
      <QuotesList quotes={quotes} />
    </div>
  )
}

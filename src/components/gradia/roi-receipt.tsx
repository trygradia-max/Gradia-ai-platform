import {
  ArrowRight,
  CalendarCheck,
  Clock,
  HeartHandshake,
  Send,
  UserPlus,
} from "lucide-react"
import Link from "next/link"

import {
  formatReceiptDollars,
  formatReceiptHours,
  getFoundMoneyTotalForCurrentShop,
  getRoiReceiptForCurrentShop,
  type RoiReceipt,
} from "@/lib/data/roi-receipt"
import { SectionHeader } from "@/components/gradia/motion/section-header"
import { STRINGS } from "@/lib/strings"
import { cn } from "@/lib/utils"

/**
 * The ROI receipt, pinned to the top of Home (FOCUS spec NOW-3 / §4.3).
 * Always visible — even at zero, where it shows written, we/us copy that
 * points at the next action instead of a blank panel (BUILD_REFERENCE §1).
 *
 * Every figure traces to a real row (see lib/data/roi-receipt.ts). Money is
 * "in play," not "earned"; hours are a conservative "~" estimate. The receipt
 * under-claims on purpose — it's a trust artifact.
 */
export async function RoiReceipt() {
  const [receipt, found] = await Promise.all([
    getRoiReceiptForCurrentShop(),
    getFoundMoneyTotalForCurrentShop(),
  ])
  return (
    <RoiReceiptView receipt={receipt} foundMoneyCents={found.foundMoneyCents} />
  )
}

function StatCell({
  icon: Icon,
  value,
  label,
}: {
  icon: typeof UserPlus
  value: string
  label: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Icon className="size-4 text-primary" aria-hidden />
      <p className="font-data text-2xl font-semibold leading-none text-foreground">
        {value}
      </p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

export function RoiReceiptView({
  receipt,
  foundMoneyCents = 0,
}: {
  receipt: RoiReceipt
  /** Cumulative all-time "Found Money" from the shop_metrics ledger. */
  foundMoneyCents?: number
}) {
  const {
    leadsCaught,
    messagesSent,
    bookingsMade,
    moneyInPlayCents,
    recoveredLeadsCount,
  } = receipt

  return (
    <section className="space-y-5">
      <SectionHeader
        eyebrow={STRINGS.pages.home.receiptEyebrow}
        title={STRINGS.pages.home.receiptTitle}
        subtitle={STRINGS.pages.home.receiptSubtitle}
      />

      <div
        className={cn(
          "rounded-2xl border border-border/60 bg-card p-6 sm:p-8",
          receipt.isEmpty && "bg-card/40"
        )}
      >
        {receipt.isEmpty ? (
          // Written zero-state — never a blank box.
          <div className="space-y-1.5 py-2">
            <p className="font-data text-xl font-semibold text-foreground">
              Nothing on the books <span className="italic">yet</span>.
            </p>
            <p className="max-w-prose text-sm text-muted-foreground">
              Connect your number and Gradia starts catching leads today — the
              moment we do, it shows up right here.
            </p>
            <Link
              href="/settings#voice"
              className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary transition-colors hover:text-primary/80"
            >
              Connect a channel
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Money in play — the headline figure, framed honestly. */}
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-data text-2xl font-semibold text-foreground">
                {formatReceiptDollars(moneyInPlayCents)}
              </span>
              <span className="text-sm text-muted-foreground">
                in booked work this week
              </span>
            </div>

            {foundMoneyCents > 0 && (
              <p className="-mt-3 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">
                  {formatReceiptDollars(foundMoneyCents)}
                </span>{" "}
                found to date.
              </p>
            )}

            <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-4">
              <StatCell
                icon={UserPlus}
                value={String(leadsCaught)}
                label={leadsCaught === 1 ? "lead caught" : "leads caught"}
              />
              <StatCell
                icon={Send}
                value={String(messagesSent)}
                label={messagesSent === 1 ? "reply sent for you" : "replies sent for you"}
              />
              <StatCell
                icon={CalendarCheck}
                value={String(bookingsMade)}
                label={bookingsMade === 1 ? "booking secured" : "bookings secured"}
              />
              <StatCell
                icon={Clock}
                value={formatReceiptHours(receipt.minutesSaved)}
                label="of your time saved"
              />
              {recoveredLeadsCount > 0 && (
                <StatCell
                  icon={HeartHandshake}
                  value={String(recoveredLeadsCount)}
                  label={
                    recoveredLeadsCount === 1
                      ? "customer revived"
                      : "customers revived"
                  }
                />
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

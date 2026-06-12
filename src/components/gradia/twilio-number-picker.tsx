"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { Check, Loader2, Phone, Search, X } from "lucide-react"
import { toast } from "sonner"

import {
  provisionTwilioNumber,
  searchTwilioNumbers,
} from "@/app/actions/twilio-provision"
import { Button } from "@/components/ui/button"
import { EASE_OUT_EXPO } from "@/components/gradia/motion/page-stagger"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { DEFAULT_PRICING } from "@/lib/pricing"
import type { TwilioAvailableNumber } from "@/lib/twilio"
import { cn } from "@/lib/utils"

/**
 * Inline picker that handles area-code search → candidate list →
 * one-click provision. Sits inside the SMS settings card whenever
 * the operator clicks "Pick a Gradia number."
 *
 * Money note: provisioning starts a monthly rental, billed at Gradia's
 * retail price from pricing_config (white-label shops; metered through
 * the credits ledger) or to the shop's own account (BYO). The picker
 * surfaces the retail price before the Buy click — never vendor cost.
 */
export function TwilioNumberPicker({
  onCancel,
  initialAreaCode,
}: {
  onCancel: () => void
  initialAreaCode?: string
}) {
  const router = useRouter()
  const reduce = useReducedMotion()
  const [areaCode, setAreaCode] = React.useState(initialAreaCode ?? "")
  const [searching, setSearching] = React.useState(false)
  const [candidates, setCandidates] = React.useState<
    TwilioAvailableNumber[]
  >([])
  const [provisioning, setProvisioning] = React.useState<string | null>(null)
  const [didSearch, setDidSearch] = React.useState(false)
  const [retailCents, setRetailCents] = React.useState<number | null>(
    DEFAULT_PRICING.number_monthly.retail_cents
  )

  async function handleSearch(e?: React.FormEvent<HTMLFormElement>) {
    if (e) e.preventDefault()
    setSearching(true)
    const result = await searchTwilioNumbers({
      areaCode: areaCode.trim() || undefined,
    })
    setSearching(false)
    setDidSearch(true)
    if (!result.ok) {
      toast.error(result.error)
      setCandidates([])
      return
    }
    setRetailCents(result.monthlyRetailCents)
    setCandidates(result.numbers)
  }

  const priceLine =
    retailCents == null
      ? "Billed to your connected account."
      : `$${(retailCents / 100).toFixed(2)}/month, billed through Gradia — no other accounts needed.`

  async function handleProvision(phoneNumber: string) {
    setProvisioning(phoneNumber)
    const result = await provisionTwilioNumber({ phoneNumber })
    setProvisioning(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(`${formatPhone(result.phoneNumber)} is yours — texts route to Gradia now.`)
    router.refresh()
  }

  return (
    <AnimatePresence initial={false}>
      <motion.div
        key="picker"
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.35, ease: EASE_OUT_EXPO }}
        className="space-y-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="label-eyebrow text-muted-foreground/70">
              Pick a Gradia number
            </p>
            <p className="text-sm text-foreground">
              Search by area code, pick one, we wire it up. {priceLine}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3"
          onSubmit={handleSearch}
        >
          <div className="grid flex-1 gap-1.5">
            <Label
              htmlFor="twilio-area-code"
              className="label-eyebrow text-muted-foreground/70"
            >
              Area code (optional)
            </Label>
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70"
              />
              <Input
                id="twilio-area-code"
                value={areaCode}
                onChange={(e) => {
                  const next = e.target.value.replace(/\D/g, "").slice(0, 3)
                  setAreaCode(next)
                }}
                placeholder="e.g. 617"
                inputMode="numeric"
                maxLength={3}
                autoComplete="off"
                spellCheck={false}
                className="h-10 pl-9 tabular-nums"
              />
            </div>
          </div>
          <Button
            type="submit"
            disabled={searching || provisioning !== null}
            className="h-10 gap-2"
          >
            {searching ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Search className="size-4" aria-hidden />
            )}
            {searching ? "Searching" : "Show me numbers"}
          </Button>
        </form>

        <AnimatePresence initial={false} mode="wait">
          {searching ? (
            <motion.div
              key="loading"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25, ease: EASE_OUT_EXPO }}
              className="grid gap-2"
            >
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-14 animate-pulse rounded-xl border border-border/40 bg-muted/15"
                />
              ))}
            </motion.div>
          ) : candidates.length > 0 ? (
            <motion.ul
              key="results"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3, ease: EASE_OUT_EXPO }}
              className="grid gap-2"
            >
              {candidates.map((n) => {
                const isBuying = provisioning === n.phoneNumber
                const disabled =
                  provisioning !== null && provisioning !== n.phoneNumber
                return (
                  <li key={n.phoneNumber}>
                    <button
                      type="button"
                      onClick={() => handleProvision(n.phoneNumber)}
                      disabled={disabled || isBuying}
                      className={cn(
                        "group flex w-full items-center gap-3 rounded-xl border border-border/50 bg-muted/15 px-3.5 py-3 text-left transition-colors",
                        "hover:border-border hover:bg-muted/25",
                        "disabled:cursor-not-allowed disabled:opacity-50",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      )}
                    >
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/12 text-emerald-500 ring-1 ring-emerald-500/25 dark:text-emerald-400">
                        <Phone className="size-4" aria-hidden />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground tabular-nums">
                          {formatPhone(n.phoneNumber)}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {[n.locality, n.region].filter(Boolean).join(", ") ||
                            "Local"}
                        </p>
                      </div>
                      <div className="shrink-0">
                        {isBuying ? (
                          <Loader2
                            className="size-4 animate-spin text-muted-foreground"
                            aria-hidden
                          />
                        ) : (
                          <Check
                            className="size-4 text-muted-foreground/60 transition-colors group-hover:text-primary"
                            aria-hidden
                          />
                        )}
                      </div>
                    </button>
                  </li>
                )
              })}
            </motion.ul>
          ) : didSearch ? (
            <motion.p
              key="empty"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25, ease: EASE_OUT_EXPO }}
              className="rounded-xl border border-dashed border-border/40 px-4 py-6 text-center text-sm text-muted-foreground"
            >
              No numbers in that area code right now — try a nearby one or
              leave it blank for nationwide.
            </motion.p>
          ) : (
            <motion.p
              key="hint"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25, ease: EASE_OUT_EXPO }}
              className="text-xs text-muted-foreground"
            >
              Leave the area code blank and we&apos;ll pull a handful of
              nearby numbers from across the US.
            </motion.p>
          )}
        </AnimatePresence>
      </motion.div>
    </AnimatePresence>
  )
}

function formatPhone(e164: string): string {
  const digits = e164.replace(/\D/g, "")
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  }
  return e164
}

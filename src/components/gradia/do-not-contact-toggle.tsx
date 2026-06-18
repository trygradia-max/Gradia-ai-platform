"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { BellOff, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { setCustomerDoNotContact } from "@/app/actions/customers"
import { cn } from "@/lib/utils"

/**
 * Manual do-not-contact switch on a customer file. When on, the audience
 * resolver hard-blocks this person from every outreach (recovered or not). The
 * toggle is optimistic and rolls back on failure — the flag must feel immediate.
 */
export function DoNotContactToggle({
  customerId,
  initial,
}: {
  customerId: string
  initial: boolean
}) {
  const router = useRouter()
  const [on, setOn] = React.useState(initial)
  const [pending, setPending] = React.useState(false)

  async function toggle() {
    if (pending) return
    const next = !on
    setOn(next) // optimistic
    setPending(true)
    const result = await setCustomerDoNotContact({
      customer_id: customerId,
      value: next,
    })
    setPending(false)
    if (!result.ok) {
      setOn(!next) // roll back
      toast.error(result.error)
      return
    }
    toast.success(
      next
        ? "Marked do-not-contact — we won't reach out to them."
        : "Cleared — they're reachable again."
    )
    router.refresh()
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={toggle}
      disabled={pending}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors",
        on
          ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
          : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground"
      )}
    >
      {pending ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <BellOff className="size-4" aria-hidden />
      )}
      {on ? "Do not contact" : "Contactable"}
      <span
        className={cn(
          "ml-0.5 inline-flex h-4 w-7 items-center rounded-full p-0.5 transition-colors",
          on ? "bg-amber-500/70" : "bg-muted-foreground/30"
        )}
        aria-hidden
      >
        <span
          className={cn(
            "size-3 rounded-full bg-background transition-transform",
            on ? "translate-x-3" : "translate-x-0"
          )}
        />
      </span>
    </button>
  )
}

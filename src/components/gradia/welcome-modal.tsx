"use client"

import * as React from "react"
import Link from "next/link"
import {
  ArrowRight,
  Mail,
  MessageSquare,
  Phone,
  Sparkles,
} from "lucide-react"

import { Button, buttonVariants } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export const WELCOME_DISMISSED_COOKIE = "gradia_welcome_v1_dismissed"
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

function writeDismissedCookie(): void {
  try {
    const secure = window.location.protocol === "https:" ? "; Secure" : ""
    document.cookie = `${WELCOME_DISMISSED_COOKIE}=1; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax${secure}`
  } catch {}
}

const STEPS = [
  {
    icon: Phone,
    label: "Voice receptionist",
    detail: "Your receptionist takes calls, books, and quotes — when you're under a car.",
    href: "/settings#voice",
  },
  {
    icon: Mail,
    label: "Email + Calendar",
    detail: "Connect Gmail once — it covers inbound replies + bookings.",
    href: "/settings#email",
  },
  {
    icon: MessageSquare,
    label: "SMS",
    detail: "Your business number with auto-drafts on every inbound text.",
    href: "/settings#sms",
  },
] as const

/**
 * One-time welcome modal that shows on the first /dashboard visit
 * for a shop that hasn't connected anything yet. Dismissal is stored
 * in localStorage so we never nag a shop that already saw it. The
 * channel connection card on the page underneath stays the source
 * of truth — this is just the on-ramp moment.
 */
export function WelcomeModal({
  connectedCount,
  totalChannels,
  initialDismissed,
}: {
  connectedCount: number
  totalChannels: number
  /** Server-read cookie value — matches the SSR snapshot exactly so
   *  there's no hydration flash when the modal "decides" whether to
   *  open. */
  initialDismissed: boolean
}) {
  const [manuallyClosed, setManuallyClosed] = React.useState(initialDismissed)
  const open = connectedCount === 0 && !manuallyClosed

  function handleClose(next: boolean) {
    if (!next) {
      setManuallyClosed(true)
      writeDismissedCookie()
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30">
            <Sparkles className="size-4" aria-hidden />
          </div>
          <DialogTitle>Welcome to Gradia</DialogTitle>
          <DialogDescription>
            We&apos;re your AI office — every inquiry across voice, email,
            SMS, and DMs becomes a Slack approval card. Connect the
            channels below and we&apos;ll start catching leads with you.
          </DialogDescription>
        </DialogHeader>

        <ul className="grid gap-2">
          {STEPS.map((step) => {
            const Icon = step.icon
            return (
              <li key={step.label}>
                <Link
                  href={step.href}
                  onClick={() => handleClose(false)}
                  className="group flex items-start gap-3 rounded-md border border-border/60 bg-muted/15 px-3 py-2.5 transition hover:bg-muted/30"
                >
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background">
                    <Icon className="size-4 text-primary" aria-hidden />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{step.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {step.detail}
                    </p>
                  </div>
                  <ArrowRight
                    className="mt-1 size-3.5 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100"
                    aria-hidden
                  />
                </Link>
              </li>
            )
          })}
        </ul>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => handleClose(false)}
            className="h-11 sm:h-9"
          >
            I&apos;ll set up later
          </Button>
          <Link
            href="/settings#voice"
            onClick={() => handleClose(false)}
            className={`${buttonVariants({ variant: "default" })} h-11 sm:h-9`}
          >
            Start connecting
          </Link>
        </DialogFooter>

        <p className="mt-2 text-center text-[11px] text-muted-foreground">
          {connectedCount} of {totalChannels} live · we&apos;ll keep this
          out of your way once you&apos;re going.
        </p>
      </DialogContent>
    </Dialog>
  )
}

"use client"

import * as React from "react"
import {
  loadConnectAndInitialize,
  type StripeConnectInstance,
} from "@stripe/connect-js"
import {
  ConnectAccountManagement,
  ConnectAccountOnboarding,
  ConnectComponentsProvider,
} from "@stripe/react-connect-js"
import { Loader2, TriangleAlert } from "lucide-react"
import { toast } from "sonner"

import {
  getStripeOnboardingSession,
  refreshStripeAccountStatus,
} from "@/app/actions/stripe-connect"
import { Button } from "@/components/ui/button"

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; instance: StripeConnectInstance }
  | { kind: "error"; message: string }

/**
 * Embedded Connect onboarding rendered inline inside the Payments
 * settings card. Operators never leave Gradia — the entire KYC,
 * identity, and bank-account flow runs as a Stripe-hosted iframe
 * styled to match our card chrome.
 *
 * After they complete (or close) the embedded flow, `onComplete` is
 * called with the latest `chargesEnabled` flag so the parent card
 * can flip its status pill without a page reload.
 *
 * Two modes:
 *   - "onboarding": first-time setup, full KYC walkthrough
 *   - "management": post-onboard, lets the operator update bank /
 *     identity / business info later from the same surface
 */
export function StripeEmbeddedOnboarding({
  mode = "onboarding",
  onComplete,
  onCancel,
}: {
  mode?: "onboarding" | "management"
  onComplete: (chargesEnabled: boolean) => void
  onCancel?: () => void
}) {
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
  // Initialize lazily so the missing-key case shows the error state on
  // first render without a setState-in-effect bounce.
  const [state, setState] = React.useState<LoadState>(() =>
    publishableKey
      ? { kind: "loading" }
      : {
          kind: "error",
          message:
            "Stripe publishable key isn't set — flag the engineer on call.",
        }
  )

  React.useEffect(() => {
    if (!publishableKey) return

    let cancelled = false
    void (async () => {
      try {
        // Stripe's appearance API can't read CSS variables (and doesn't
        // parse oklch), so resolve the design tokens to concrete rgb()
        // values through the browser at runtime — the theme stays the
        // single source of truth (no hardcoded hex here).
        const token = (name: string, fallback: string) => {
          const el = document.createElement("span")
          el.style.color = `var(${name})`
          document.body.appendChild(el)
          const resolved = getComputedStyle(el).color
          el.remove()
          return resolved || fallback
        }

        const instance = await loadConnectAndInitialize({
          publishableKey,
          fetchClientSecret: async () => {
            const result = await getStripeOnboardingSession()
            if (!result.ok) {
              throw new Error(result.error)
            }
            return result.clientSecret
          },
          appearance: {
            overlays: "drawer",
            variables: {
              fontFamily:
                "var(--font-sans), system-ui, -apple-system, sans-serif",
              colorPrimary: token("--accent", "#7c3aed"),
              colorBackground: "transparent",
              colorText: token("--text-primary", "#fafafa"),
              colorDanger: token("--status-danger", "#d83a52"),
              borderRadius: "10px",
              spacingUnit: "6px",
            },
          },
        })
        if (cancelled) return
        setState({ kind: "ready", instance })
      } catch (err) {
        if (cancelled) return
        const message =
          err instanceof Error
            ? err.message
            : "Couldn't load Stripe — try again in a moment."
        setState({ kind: "error", message })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [publishableKey])

  async function handleExit() {
    const result = await refreshStripeAccountStatus()
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    onComplete(result.chargesEnabled)
    if (result.chargesEnabled) {
      toast.success("Stripe's good to go — we can send invoices now.")
    } else {
      toast.message(
        "Stripe still needs a bit more from you — pick it back up anytime."
      )
    }
  }

  if (state.kind === "loading") {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-10 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading the Stripe panel…
      </div>
    )
  }

  if (state.kind === "error") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-6 text-center">
        <TriangleAlert className="size-5 text-destructive" aria-hidden />
        <p className="text-sm text-destructive">{state.message}</p>
        {onCancel ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
          >
            Back
          </Button>
        ) : null}
      </div>
    )
  }

  return (
    <ConnectComponentsProvider connectInstance={state.instance}>
      <div className="rounded-xl border border-border/50 bg-background/60 p-1">
        {mode === "onboarding" ? (
          <ConnectAccountOnboarding onExit={handleExit} />
        ) : (
          <ConnectAccountManagement />
        )}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Powered by Stripe. We never see card numbers or banking details —
          they go straight to Stripe.
        </p>
        {onCancel ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
          >
            Close
          </Button>
        ) : null}
      </div>
    </ConnectComponentsProvider>
  )
}

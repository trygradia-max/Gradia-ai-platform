"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { BadgeCheck, Loader2, Mail, Phone } from "lucide-react"
import { toast } from "sonner"

import { completeOnboarding } from "@/app/actions/onboarding"
import { A2pWizard } from "@/components/gradia/a2p-wizard"
import { TwilioNumberPicker } from "@/components/gradia/twilio-number-picker"
import { VoiceBuilderCard } from "@/components/gradia/voice-builder-card"
import { Button, buttonVariants } from "@/components/ui/button"
import type { A2pState } from "@/app/actions/a2p"
import type { ShopRow } from "@/lib/types/database"
import { cn } from "@/lib/utils"

/**
 * Wizard steps 3–5 (GRADIA_UX_ONBOARDING_SPEC Part 1): inbox, number +
 * carrier verification, receptionist + test call. Each embeds the
 * existing owner card for that job — the wizard is sequencing, not new
 * machinery. Every step is skippable ("Do this later" advances; the
 * Today page nudges what was skipped).
 */

function StepShell({
  title,
  blurb,
  children,
  footer,
}: {
  title: string
  blurb: string
  children: React.ReactNode
  footer: React.ReactNode
}) {
  return (
    <div className="grid gap-5">
      <div className="space-y-1">
        <h2 className="font-display text-2xl tracking-tight text-foreground">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{blurb}</p>
      </div>
      {children}
      <div className="flex items-center justify-between gap-3 border-t border-border/40 pt-4">
        {footer}
      </div>
    </div>
  )
}

function LaterButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      className="text-muted-foreground hover:text-foreground"
    >
      Do this later
    </Button>
  )
}

// ---------- Step 3: Your inbox ----------

export function InboxStep({
  connectedEmail,
  onBack,
  onContinue,
}: {
  connectedEmail: string | null
  onBack: () => void
  onContinue: () => void
}) {
  return (
    <StepShell
      title="Your inbox"
      blurb="One button. Inbound emails get drafted replies waiting on your yes, and your calendar comes with it for bookings."
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onBack}>
            Back
          </Button>
          <div className="flex items-center gap-2">
            {!connectedEmail ? <LaterButton onClick={onContinue} /> : null}
            <Button type="button" onClick={onContinue} disabled={!connectedEmail}>
              Continue
            </Button>
          </div>
        </>
      }
    >
      {connectedEmail ? (
        <div className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/15 px-3.5 py-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/12 text-emerald-500 ring-1 ring-emerald-500/25 dark:text-emerald-400">
            <BadgeCheck className="size-4" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="label-eyebrow text-muted-foreground/70">Connected</p>
            <p className="truncate text-sm text-foreground">{connectedEmail}</p>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-center rounded-xl border border-dashed border-border/60 bg-muted/10 px-6 py-10">
          <a
            href="/api/aurinko/auth/start?next=/onboarding?step=4"
            className={cn(buttonVariants({ size: "lg" }), "gap-2")}
          >
            <Mail className="size-4" aria-hidden />
            Connect Gmail
          </a>
        </div>
      )}
    </StepShell>
  )
}

// ---------- Step 4: Your number ----------

export function NumberStep({
  shop,
  a2pState,
  onBack,
  onContinue,
}: {
  shop: ShopRow
  a2pState: A2pState
  onBack: () => void
  onContinue: () => void
}) {
  const hasNumber = Boolean(shop.twilio_phone_number)
  const isGradiaNumber =
    Boolean(shop.gradia_number_e164) &&
    shop.twilio_phone_number === shop.gradia_number_e164
  const [picking, setPicking] = React.useState(!hasNumber)

  return (
    <StepShell
      title="Your number"
      blurb="A business line customers call and text. Carriers verify every business that texts — two minutes now, 1–3 days for their approval. Calls work right away."
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onBack}>
            Back
          </Button>
          <div className="flex items-center gap-2">
            {!hasNumber ? <LaterButton onClick={onContinue} /> : null}
            <Button type="button" onClick={onContinue} disabled={!hasNumber}>
              Continue
            </Button>
          </div>
        </>
      }
    >
      {hasNumber ? (
        <div className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/15 px-3.5 py-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/12 text-emerald-500 ring-1 ring-emerald-500/25 dark:text-emerald-400">
            <Phone className="size-4" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="label-eyebrow text-muted-foreground/70">Your business number</p>
            <p className="text-sm tabular-nums text-foreground">
              {shop.twilio_phone_number}
            </p>
          </div>
        </div>
      ) : picking ? (
        <TwilioNumberPicker onCancel={() => setPicking(false)} />
      ) : (
        <div className="flex items-center justify-center rounded-xl border border-dashed border-border/60 bg-muted/10 px-6 py-10">
          <Button type="button" size="lg" className="gap-2" onClick={() => setPicking(true)}>
            <Phone className="size-4" aria-hidden />
            Pick a number
          </Button>
        </div>
      )}

      {/* In-flow carrier verification, the moment a Gradia number exists. */}
      {isGradiaNumber && a2pState.status !== "approved" ? (
        <A2pWizard initial={a2pState} />
      ) : null}
    </StepShell>
  )
}

// ---------- Step 5: Your receptionist ----------

export function ReceptionistStep({
  shop,
  voiceOptions,
  vapiConfigured,
  onBack,
}: {
  shop: ShopRow
  voiceOptions: { id: string; label: string; description: string }[]
  vapiConfigured: boolean
  onBack: () => void
}) {
  const router = useRouter()
  const [finishing, setFinishing] = React.useState(false)

  async function finish() {
    if (finishing) return
    setFinishing(true)
    const result = await completeOnboarding()
    setFinishing(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    router.push("/dashboard")
  }

  return (
    <StepShell
      title="Meet your receptionist"
      blurb={
        shop.voice_live
          ? "You're live. Calls answered from now on — texting unlocks when carriers approve (we'll tell you)."
          : "Tell it the facts, hear it on a test call, then go live. Bookings still wait for your approval."
      }
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onBack}>
            Back
          </Button>
          <div className="flex items-center gap-2">
            {!shop.voice_live ? (
              <LaterButton onClick={finish} />
            ) : null}
            <Button type="button" onClick={finish} disabled={finishing} className="gap-2">
              {finishing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {shop.voice_live ? "Open the dashboard" : "Finish setup"}
            </Button>
          </div>
        </>
      }
    >
      {shop.voice_addon ? (
        <VoiceBuilderCard
          shop={shop}
          voiceOptions={voiceOptions}
          vapiConfigured={vapiConfigured}
        />
      ) : (
        <div className="space-y-3 rounded-xl border border-dashed border-border/60 bg-muted/10 px-5 py-8 text-center">
          <p className="font-display text-lg text-foreground">
            The receptionist is part of the <span className="italic">voice</span> add-on.
          </p>
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            +$29/month: it answers your calls, quotes from your menu, and
            proposes bookings — business number and ~20 answered calls
            included.
          </p>
          <Link href="/billing" className={cn(buttonVariants(), "mt-1")}>
            Add it in Billing
          </Link>
        </div>
      )}
    </StepShell>
  )
}

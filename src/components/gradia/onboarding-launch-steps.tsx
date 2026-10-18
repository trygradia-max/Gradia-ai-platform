"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { BadgeCheck, Loader2, Mail, Phone } from "lucide-react"
import { toast } from "sonner"

import { completeOnboarding } from "@/app/actions/onboarding"
import { ByoSmsAttestationCard } from "@/components/gradia/byo-sms-attestation-card"
import { ChannelStatusList } from "@/components/gradia/channel-status-list"
import { readAutonomy } from "@/lib/autonomy"
import type { ByoSmsAttestationState } from "@/lib/byo-sms-attestation"
import type { ChannelKey, ChannelReadiness } from "@/lib/channel-readiness"
import {
  messageApprovalCopy,
  registrationFromA2pState,
  textingActionCopy,
} from "@/lib/onboarding"
import { saveWorkingHours } from "@/app/actions/working-hours"
import { A2pWizard } from "@/components/gradia/a2p-wizard"
import { TwilioNumberPicker } from "@/components/gradia/twilio-number-picker"
import { VoiceBuilderCard } from "@/components/gradia/voice-builder-card"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { A2pState } from "@/app/actions/a2p"
import { STRINGS } from "@/lib/strings"
import type { ShopRow } from "@/lib/types/database"
import { cn } from "@/lib/utils"
import {
  WEEKDAY_LABELS,
  WEEKDAYS,
  type WorkingHours,
} from "@/lib/working-hours"

/**
 * Wizard steps 3–6 (B-16 / GRADIA_UX_ONBOARDING_SPEC Part 1): hours,
 * inbox, number + carrier verification, receptionist + test call. Each
 * embeds the existing owner card for that job — the wizard is sequencing,
 * not new machinery. Inbox/number/receptionist are skippable ("Do this
 * later" advances; the Today page nudges what was skipped). Hours always
 * has a sensible default (readWorkingHours), so its "Continue" saves and
 * moves on rather than offering a skip.
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
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
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
      className="min-h-11 text-muted-foreground hover:text-foreground"
    >
      Do this later
    </Button>
  )
}

// ---------- Step 3: Our hours ----------

export function HoursStep({
  initialHours,
  onBack,
  onContinue,
}: {
  initialHours: WorkingHours
  onBack: () => void
  onContinue: () => void
}) {
  const [hours, setHours] = React.useState<WorkingHours>(initialHours)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  function setDay(
    day: (typeof WEEKDAYS)[number],
    patch: Partial<{ open: string; close: string; closed: boolean }>
  ) {
    setHours((prev) => {
      const current = prev[day]
      if (patch.closed !== undefined) {
        return {
          ...prev,
          [day]: patch.closed ? null : { open: "09:00", close: "17:00" },
        }
      }
      if (!current) return prev
      return { ...prev, [day]: { ...current, ...patch } }
    })
  }

  async function saveAndContinue() {
    setSaving(true)
    setError(null)
    const result = await saveWorkingHours(hours)
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      toast.error(result.error)
      return
    }
    onContinue()
  }

  return (
    <StepShell
      title="Our hours"
      blurb="When we're open — the calendar warns about overbooking on these days, and the receptionist only proposes times inside these hours."
      footer={
        <>
          <Button type="button" variant="ghost" className="min-h-11" onClick={onBack}>
            Back
          </Button>
          <Button
            type="button"
            onClick={saveAndContinue}
            disabled={saving}
            className="min-h-11 gap-2"
          >
            {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Continue
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {WEEKDAYS.map((day) => {
          const h = hours[day]
          return (
            <div key={day} className="flex min-h-11 flex-wrap items-center gap-3">
              <span className="w-24 shrink-0 text-sm text-muted-foreground">
                {WEEKDAY_LABELS[day]}
              </span>
              <label className="flex min-h-11 items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={h === null}
                  onChange={(e) => setDay(day, { closed: e.target.checked })}
                  className="size-4 accent-primary"
                />
                Closed
              </label>
              {h ? (
                <>
                  <Input
                    type="time"
                    value={h.open}
                    onChange={(e) => setDay(day, { open: e.target.value })}
                    className="h-8 w-28"
                    aria-label={`${WEEKDAY_LABELS[day]} opening time`}
                  />
                  <span className="text-xs text-muted-foreground">to</span>
                  <Input
                    type="time"
                    value={h.close}
                    onChange={(e) => setDay(day, { close: e.target.value })}
                    className="h-8 w-28"
                    aria-label={`${WEEKDAY_LABELS[day]} closing time`}
                  />
                </>
              ) : null}
            </div>
          )
        })}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-status-danger-fg">
          {error}
        </p>
      ) : null}
    </StepShell>
  )
}

// ---------- Step 4: Your inbox ----------

export function InboxStep({
  connected,
  connectedEmail,
  onBack,
  onContinue,
}: {
  /** Connection truth from `connectionStatus()` — never the display email. */
  connected: boolean
  /** Display identity; may be null while connected (UX-001 founder repro). */
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
          <Button type="button" variant="ghost" className="min-h-11" onClick={onBack}>
            Back
          </Button>
          <div className="flex items-center gap-2">
            {!connected ? <LaterButton onClick={onContinue} /> : null}
            <Button type="button" className="min-h-11" onClick={onContinue} disabled={!connected}>
              Continue
            </Button>
          </div>
        </>
      }
    >
      {connected ? (
        <div className="flex items-center gap-3 rounded-md border border-border/50 bg-muted/15 px-3.5 py-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-status-success-bg text-status-success-fg ring-1 ring-status-success/25">
            <BadgeCheck className="size-4" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="label-eyebrow text-muted-foreground">
              {STRINGS.connections.connected}
            </p>
            <p className="truncate text-sm text-foreground">
              {connectedEmail ?? STRINGS.connections.identityFallback.email}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-center rounded-md border border-dashed border-border/60 bg-muted/10 px-6 py-10">
          <a
            href="/api/aurinko/auth/start?next=/onboarding?step=5"
            className={cn(buttonVariants({ size: "lg" }), "min-h-11 gap-2")}
          >
            <Mail className="size-4" aria-hidden />
            Connect Gmail
          </a>
        </div>
      )}
    </StepShell>
  )
}

// ---------- Step 5: Your number ----------

export function NumberStep({
  shop,
  a2pState,
  channels,
  byo,
  onBack,
  onContinue,
  onSkip,
}: {
  shop: ShopRow
  a2pState: A2pState
  channels: Record<ChannelKey, ChannelReadiness> | null
  byo: ByoSmsAttestationState | null
  onBack: () => void
  onContinue: () => void
  onSkip: () => void
}) {
  const hasNumber = Boolean(shop.twilio_phone_number)
  const isGradiaNumber =
    Boolean(shop.gradia_number_e164) &&
    shop.twilio_phone_number === shop.gradia_number_e164
  const texting = textingActionCopy(registrationFromA2pState(a2pState).nextAction)
  const [picking, setPicking] = React.useState(!hasNumber)

  return (
    <StepShell
      title="Your number"
      blurb="This is the number customers call and text. Carriers must approve texting. Calls can work before that approval."
      footer={
        <>
          <Button type="button" variant="outline" className="min-h-11 shrink whitespace-normal" onClick={onBack}>
            Back
          </Button>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {!hasNumber ? (
              <Button type="button" variant="outline" className="min-h-11 shrink whitespace-normal" onClick={onSkip}>
                Skip number for now
              </Button>
            ) : null}
            <Button type="button" className="min-h-11 shrink whitespace-normal" onClick={onContinue} disabled={!hasNumber}>
              Continue to help
            </Button>
          </div>
        </>
      }
    >
      {channels ? (
        <ChannelStatusList channels={channels} />
      ) : (
        <ApprovalStatus label="Texting" status={texting} />
      )}

      {hasNumber ? (
        <div className="flex items-center gap-3 rounded-md border border-border/50 bg-muted/15 px-3.5 py-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-status-success-bg text-status-success-fg ring-1 ring-status-success/25">
            <Phone className="size-4" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="label-eyebrow text-muted-foreground">Your business number</p>
            <p className="text-sm tabular-nums text-foreground">
              {shop.twilio_phone_number}
            </p>
          </div>
        </div>
      ) : picking ? (
        <TwilioNumberPicker onCancel={() => setPicking(false)} />
      ) : (
        <div className="flex items-center justify-center rounded-md border border-dashed border-border/60 bg-muted/10 px-6 py-10">
          <Button type="button" size="lg" className="min-h-11 gap-2" onClick={() => setPicking(true)}>
            <Phone className="size-4" aria-hidden />
            Pick a number
          </Button>
        </div>
      )}

      {/* In-flow carrier verification, the moment a Gradia number exists. */}
      {isGradiaNumber && registrationFromA2pState(a2pState).nextAction !== "none" ? (
        <A2pWizard initial={a2pState} />
      ) : null}
      {!isGradiaNumber && byo ? (
        <ByoSmsAttestationCard shopId={shop.id} initial={byo} />
      ) : null}
    </StepShell>
  )
}

// ---------- Step 6: Your receptionist ----------

export function ChooseHelpStep({
  shop,
  voiceOptions,
  vapiConfigured,
  channels,
  onBack,
}: {
  shop: ShopRow
  voiceOptions: { id: string; label: string; description: string }[]
  vapiConfigured: boolean
  channels: Record<ChannelKey, ChannelReadiness> | null
  onBack: () => void
}) {
  const router = useRouter()
  const [finishing, setFinishing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function finish() {
    if (finishing) return
    setFinishing(true)
    setError(null)
    const result = await completeOnboarding()
    setFinishing(false)
    if (!result.ok) {
      setError(result.error)
      toast.error(result.error)
      return
    }
    router.push("/dashboard")
  }

  return (
    <StepShell
      title="Choose your help"
      blurb="Pick what Gradia should handle first. You can change this later in Settings."
      footer={
        <>
          <Button type="button" variant="outline" className="min-h-11 shrink whitespace-normal" onClick={onBack}>
            Back
          </Button>
          <Button type="button" onClick={finish} disabled={finishing} className="min-h-11 shrink gap-2 whitespace-normal">
            {finishing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Finish setup
          </Button>
        </>
      }
    >
      {channels ? <ChannelStatusList channels={channels} /> : null}
      <ApprovalStatus
        label="Message approval"
        status={messageApprovalCopy(readAutonomy(shop).default)}
      />
      <ol className="list-decimal space-y-2 pl-5 text-sm text-foreground">
        <li>Save what the phone should say.</li>
        <li>Place a test call to your own phone and listen.</li>
        <li>Turn it on only after that call sounds right.</li>
      </ol>
      {shop.voice_addon ? (
        <VoiceBuilderCard
          shop={shop}
          voiceOptions={voiceOptions}
          vapiConfigured={vapiConfigured}
        />
      ) : (
        <div className="space-y-3 rounded-md border border-dashed border-border/60 bg-muted/10 px-5 py-8 text-center">
          <p className="font-display text-lg text-foreground">
            Phone help is optional.
          </p>
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            Texts still wait for your approval. Phone answering is +$29/month if you want a test call later.
          </p>
          <Link href="/billing" className={cn(buttonVariants(), "mt-1 min-h-11")}>
            See phone help
          </Link>
        </div>
      )}
      {error ? (
        <p role="alert" className="text-sm text-status-danger-fg">
          {error}
        </p>
      ) : null}
    </StepShell>
  )
}

function ApprovalStatus({
  label,
  status,
}: {
  label: string
  status: { label: string; detail: string }
}) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/15 px-3.5 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-sm font-medium text-foreground">{status.label}</p>
      <p className="mt-1 text-sm text-muted-foreground">{status.detail}</p>
    </div>
  )
}

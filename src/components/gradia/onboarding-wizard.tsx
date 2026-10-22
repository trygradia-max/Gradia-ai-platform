"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  AnimatePresence,
  motion,
  useReducedMotion,
} from "framer-motion"
import { ArrowRight, Check, Loader2, Sparkles } from "lucide-react"

import { saveOnboardingProgress } from "@/app/actions/onboarding"
import { saveShop } from "@/app/actions/shop"
import type { ChannelReadinessResult } from "@/app/actions/channel-readiness"
import type { A2pState } from "@/app/actions/a2p"
import {
  ChooseHelpStep,
  NumberStep,
} from "@/components/gradia/onboarding-launch-steps"
import { FormField } from "@/components/gradia/form-field"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { EASE_OUT_EXPO } from "@/components/gradia/motion/page-stagger"
import { readBusinessKind } from "@/lib/onboarding"
import { STRINGS } from "@/lib/strings"
import { cn } from "@/lib/utils"
import type { ShopRow } from "@/lib/types/database"

type Step = 1 | 2 | 3

const STEP_LABELS: Record<Step, string> = {
  1: STRINGS.pages.onboarding.steps.business,
  2: STRINGS.pages.onboarding.steps.number,
  3: STRINGS.pages.onboarding.steps.help,
}

export function OnboardingWizard({
  initialShop,
  initialStep,
  forceCreate = false,
  a2pState,
  readiness,
  voiceOptions,
  vapiConfigured,
}: {
  initialShop: ShopRow | null
  initialStep: Step
  /** "Add another shop" path — insert a new shop row even if the user
   *  already owns one. */
  forceCreate?: boolean
  readiness?: ChannelReadinessResult
  a2pState: A2pState
  voiceOptions: { id: string; label: string; description: string }[]
  vapiConfigured: boolean
}) {
  const router = useRouter()
  const [step, setStep] = React.useState<Step>(initialStep)
  const [shop, setShop] = React.useState<ShopRow | null>(initialShop)
  const [progressError, setProgressError] = React.useState<string | null>(null)

  const progressBusy = React.useRef(false)
  const reduce = useReducedMotion()

  // Steps 3–5 embed live cards (OAuth, purchase, voice) that refresh the
  // server tree — initialShop arrives fresh on each refresh, so prefer it
  // there over the step-1 client copy.
  const liveShop = initialShop ?? shop

  async function remember(next: Step, numberSkipped?: boolean) {
    if (progressBusy.current) return false
    progressBusy.current = true
    setProgressError(null)
    try {
      const result = await saveOnboardingProgress({ step: next, numberSkipped })
      if (!result.ok) { setProgressError(result.error); return false }
      setStep(next)
      router.refresh()
      return true
    } catch {
      setProgressError("Could not confirm your saved place. Refresh before continuing.")
      return false
    } finally { progressBusy.current = false }
  }

  return (
    <Card className="w-full max-w-2xl overflow-hidden rounded-2xl border-border/60 bg-card/95 shadow-2xl shadow-black/40 ring-1 ring-foreground/5">
      <CardHeader className="space-y-5 border-b border-border/40 pb-5">
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary/12 text-primary ring-1 ring-primary/25">
            <Sparkles className="size-4" aria-hidden />
          </div>
          <span className="font-display text-base tracking-tight text-foreground">
            Gradia
          </span>
        </div>
        <StepIndicator current={step} reduce={reduce ?? false} />
      </CardHeader>
      <CardContent className="space-y-6 pt-6">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step}
            initial={reduce ? { opacity: 0 } : { opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, x: -16 }}
            transition={{ duration: 0.35, ease: EASE_OUT_EXPO }}
          >
            {progressError ? (
              <p className="mb-4 text-sm text-status-danger-fg" role="alert">
                {progressError}
              </p>
            ) : null}
            {step === 1 ? (
              <ShopStep
                shop={shop}
                forceCreate={forceCreate && !shop}
                onSaved={(saved) => {
                  setShop(saved)
                  setStep(2)
                  router.refresh()
                }}
              />
            ) : null}
            {step === 2 && liveShop ? (
              <NumberStep
                shop={liveShop}
                a2pState={a2pState}
                readiness={readiness}
                onBack={() => void remember(1)}
                onSkip={() => void remember(3, true)}
                onContinue={() => void remember(3, false)}
              />
            ) : null}
            {step === 3 && liveShop ? (
              <ChooseHelpStep
                shop={liveShop}
                readiness={readiness}
                voiceOptions={voiceOptions}
                vapiConfigured={vapiConfigured}
                onBack={() => void remember(2)}
              />
            ) : null}
          </motion.div>
        </AnimatePresence>
      </CardContent>
    </Card>
  )
}

const DOT_SPRING = { type: "spring" as const, stiffness: 400, damping: 32 }

function StepIndicator({
  current,
  reduce,
}: {
  current: Step
  reduce: boolean
}) {
  const steps: Step[] = [1, 2, 3]
  return (
    <nav
      className="space-y-3.5"
      aria-label={`Onboarding progress, step ${current} of 3: ${STEP_LABELS[current]}`}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="label-eyebrow text-muted-foreground">
          {STRINGS.pages.onboarding.stepStatus(current)}
        </p>
        <p className="text-xs font-medium tracking-tight text-foreground">
          {STEP_LABELS[current]}
        </p>
      </div>
      <ol className="flex list-none items-center gap-2 p-0">
        {steps.map((id, i) => {
          const isActive = id === current
          const isComplete = id < current
          return (
            <li
              key={id}
              className={cn(
                "flex items-center gap-2",
                i < steps.length - 1 ? "min-w-0 flex-1" : "shrink-0"
              )}
            >
              <StepDot
                id={id}
                label={STEP_LABELS[id]}
                isActive={isActive}
                isComplete={isComplete}
                reduce={reduce}
              />
              {i < steps.length - 1 ? (
                <StepConnector
                  filled={isComplete}
                  reduce={reduce}
                />
              ) : null}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function StepDot({
  id,
  label,
  isActive,
  isComplete,
  reduce,
}: {
  id: Step
  label: string
  isActive: boolean
  isComplete: boolean
  reduce: boolean
}) {
  return (
    <motion.div
      layout={!reduce}
      transition={reduce ? { duration: 0 } : DOT_SPRING}
      className={cn(
        "relative flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-colors duration-(--duration-fast)",
        isComplete
          ? "bg-primary text-primary-foreground"
          : isActive
            ? "bg-primary/12 text-primary ring-1 ring-primary/35"
            : "bg-muted/60 text-muted-foreground"
      )}
      aria-current={isActive ? "step" : undefined}
      aria-label={`${label}${isComplete ? ", complete" : isActive ? ", current" : ""}`}
    >
      {/* Active halo — pulses softly while the operator's on this step. */}
      {isActive && !reduce ? (
        <motion.span
          aria-hidden
          className="absolute inset-0 rounded-full bg-primary/20"
          animate={{ scale: [1, 1.25, 1], opacity: [0.5, 0, 0.5] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
        />
      ) : null}
      <AnimatePresence mode="wait" initial={false}>
        {isComplete ? (
          <motion.span
            key="check"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25, ease: EASE_OUT_EXPO }}
            className="relative"
          >
            <Check className="size-3.5" aria-hidden />
          </motion.span>
        ) : (
          <motion.span
            key="number"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25, ease: EASE_OUT_EXPO }}
            className="relative"
          >
            {id}
          </motion.span>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function StepConnector({
  filled,
  reduce,
}: {
  filled: boolean
  reduce: boolean
}) {
  return (
    <div
      aria-hidden
      className="relative h-px flex-1 overflow-hidden rounded-full bg-border"
    >
      <motion.span
        initial={false}
        animate={{ scaleX: filled ? 1 : 0 }}
        transition={
          reduce
            ? { duration: 0 }
            : { duration: 0.5, ease: EASE_OUT_EXPO }
        }
        style={{ originX: 0 }}
        className="absolute inset-0 bg-primary/70"
      />
    </div>
  )
}

// --- Step 1: Shop ---------------------------------------------------------

function ShopStep({
  shop,
  forceCreate,
  onSaved,
}: {
  shop: ShopRow | null
  forceCreate: boolean
  onSaved: (shop: ShopRow) => void
}) {
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>({})

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setFieldErrors({})
    const fd = new FormData(e.currentTarget)
    const name = String(fd.get("name") ?? "").trim()
    const location = String(fd.get("location") ?? "").trim() || null
    const phone = String(fd.get("phone") ?? "").trim() || null
    const kind = fd.get("businessKind") === "general" ? "general" : "detailing"

    setPending(true)
    const result = await saveShop({
      name,
      location,
      phone,
      businessKind: kind,
      createNew: forceCreate,
    })
    setPending(false)

    if (!result.ok) {
      setError(result.error)
      setFieldErrors(result.fieldErrors ?? {})
      return
    }

    onSaved(result.shop)
  }

  return (
    <form className="grid gap-5" onSubmit={handleSubmit}>
      <div className="space-y-1">
        <h2 className="font-display text-2xl tracking-tight text-foreground">
          {STRINGS.pages.onboarding.steps.business}
        </h2>
        <p className="text-sm text-muted-foreground">
          {STRINGS.pages.onboarding.businessBlurb}
        </p>
      </div>
      <FormField
        id="shop-name"
        label="Business name"
        hint="Shown on quotes and the phone greeting."
        error={fieldErrors.name?.[0]}
      >
        <Input
          name="name"
          required
          maxLength={120}
          defaultValue={shop?.name ?? ""}
          placeholder="North Shore Auto Studio"
          autoComplete="organization"
          className="h-11"
        />
      </FormField>
      <FormField
        id="shop-location"
        label="Where you work"
        hint="A city, or say that you travel to customers."
        error={fieldErrors.location?.[0]}
      >
        <Input
          name="location"
          maxLength={200}
          defaultValue={shop?.location ?? ""}
          placeholder="Boston, MA — or 'Mobile across Greater Boston'"
          className="h-11"
        />
      </FormField>
      <FormField
        id="shop-phone"
        label="Phone"
        error={fieldErrors.phone?.[0]}
      >
        <Input
          name="phone"
          type="tel"
          maxLength={40}
          defaultValue={shop?.phone ?? ""}
          placeholder="+1 (555) 010-2030"
          autoComplete="tel"
          className="h-11"
        />
      </FormField>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium text-foreground">
          What kind of business is this?
        </legend>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="radio"
            name="businessKind"
            value="detailing"
            defaultChecked={readBusinessKind(shop?.settings) === "detailing"}
            className="size-4 accent-primary"
          />
          Detailing
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="radio"
            name="businessKind"
            value="general"
            defaultChecked={readBusinessKind(shop?.settings) === "general"}
            className="size-4 accent-primary"
          />
          Something else
        </label>
        <p className="text-xs text-muted-foreground">
          Detailing service menus include optional vehicle-size and condition pricing.
        </p>
      </fieldset>
      {error ? (
        <p className="text-sm text-status-danger-fg" role="alert">
          {error}
        </p>
      ) : null}
      <Button
        type="submit"
        disabled={pending}
        className="min-h-11 gap-2 transition-transform duration-(--duration-fast) active:scale-[0.99]"
      >
        {pending ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : null}
        {STRINGS.pages.onboarding.saveAndContinue}
        <ArrowRight className="size-4" aria-hidden />
      </Button>
    </form>
  )
}

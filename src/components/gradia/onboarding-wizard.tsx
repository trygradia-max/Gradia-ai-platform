"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  AnimatePresence,
  motion,
  useReducedMotion,
} from "framer-motion"
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  Sparkles,
} from "lucide-react"

import { saveShop } from "@/app/actions/shop"
import type { A2pState } from "@/app/actions/a2p"
import {
  HoursStep,
  InboxStep,
  NumberStep,
  ReceptionistStep,
} from "@/components/gradia/onboarding-launch-steps"
import { ServiceMenuCard } from "@/components/gradia/service-menu-card"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { EASE_OUT_EXPO } from "@/components/gradia/motion/page-stagger"
import { connectionStatus } from "@/lib/data/connections"
import { readWorkingHours } from "@/lib/working-hours"
import { cn } from "@/lib/utils"
import type { ServiceRow, ShopRow } from "@/lib/types/database"

type Step = 1 | 2 | 3 | 4 | 5 | 6

const STEP_LABELS: Record<Step, string> = {
  1: "Our shop",
  2: "What we offer",
  3: "Our hours",
  4: "Your inbox",
  5: "Your number",
  6: "Your receptionist",
}

export function OnboardingWizard({
  initialShop,
  initialServices,
  initialStep,
  forceCreate = false,
  a2pState,
  voiceOptions,
  vapiConfigured,
}: {
  initialShop: ShopRow | null
  initialServices: ServiceRow[]
  initialStep: Step
  /** "Add another shop" path — insert a new shop row even if the user
   *  already owns one. */
  forceCreate?: boolean
  a2pState: A2pState
  voiceOptions: { id: string; label: string; description: string }[]
  vapiConfigured: boolean
}) {
  const router = useRouter()
  const [step, setStep] = React.useState<Step>(initialStep)
  const [shop, setShop] = React.useState<ShopRow | null>(initialShop)
  const [services, setServices] =
    React.useState<ServiceRow[]>(initialServices)

  const reduce = useReducedMotion()

  // Steps 3–5 embed live cards (OAuth, purchase, voice) that refresh the
  // server tree — initialShop arrives fresh on each refresh, so prefer it
  // there over the step-1 client copy.
  const liveShop = initialShop ?? shop

  const goTo = (next: Step) => {
    setStep(next)
    router.refresh() // keep server-derived props current between steps
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
            {step === 1 ? (
              <ShopStep
                shop={shop}
                forceCreate={forceCreate}
                onSaved={(saved) => {
                  setShop(saved)
                  setStep(2)
                }}
              />
            ) : null}
            {step === 2 ? (
              <ServicesStep
                services={services}
                onServicesChange={setServices}
                onBack={() => setStep(1)}
                onContinue={() => goTo(3)}
              />
            ) : null}
            {step === 3 ? (
              <HoursStep
                initialHours={readWorkingHours(liveShop?.settings)}
                onBack={() => goTo(2)}
                onContinue={() => goTo(4)}
              />
            ) : null}
            {step === 4 ? (
              <InboxStep
                connected={connectionStatus(liveShop).email.connected}
                connectedEmail={connectionStatus(liveShop).email.identity}
                onBack={() => goTo(3)}
                onContinue={() => goTo(5)}
              />
            ) : null}
            {step === 5 && liveShop ? (
              <NumberStep
                shop={liveShop}
                a2pState={a2pState}
                onBack={() => goTo(4)}
                onContinue={() => goTo(6)}
              />
            ) : null}
            {step === 6 && liveShop ? (
              <ReceptionistStep
                shop={liveShop}
                voiceOptions={voiceOptions}
                vapiConfigured={vapiConfigured}
                onBack={() => goTo(5)}
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
  const steps: Step[] = [1, 2, 3, 4, 5, 6]
  return (
    <div className="space-y-3.5">
      <div className="flex items-center justify-between gap-3">
        <p className="label-eyebrow text-muted-foreground/70">
          Step {current} of 6
        </p>
        <p className="text-xs font-medium tracking-tight text-foreground">
          {STEP_LABELS[current]}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {steps.map((id, i) => {
          const isActive = id === current
          const isComplete = id < current
          return (
            <React.Fragment key={id}>
              <StepDot
                id={id}
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
            </React.Fragment>
          )
        })}
      </div>
    </div>
  )
}

function StepDot({
  id,
  isActive,
  isComplete,
  reduce,
}: {
  id: Step
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

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const fd = new FormData(e.currentTarget)
    const name = String(fd.get("name") ?? "").trim()
    const location = String(fd.get("location") ?? "").trim() || null
    const phone = String(fd.get("phone") ?? "").trim() || null

    setPending(true)
    const result = await saveShop({
      name,
      location,
      phone,
      createNew: forceCreate,
    })
    setPending(false)

    if (!result.ok) {
      setError(result.error)
      return
    }

    onSaved(result.shop)
  }

  return (
    <form className="grid gap-5" onSubmit={handleSubmit}>
      <div className="space-y-1">
        <h2 className="font-display text-2xl tracking-tight text-foreground">Our shop</h2>
        <p className="text-sm text-muted-foreground">
          Just the basics so we can quote, book, and follow up correctly.
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="shop-name">Shop name</Label>
        <Input
          id="shop-name"
          name="name"
          required
          maxLength={120}
          defaultValue={shop?.name ?? ""}
          placeholder="North Shore Auto Studio"
          autoComplete="organization"
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="shop-location">Location</Label>
        <Input
          id="shop-location"
          name="location"
          maxLength={200}
          defaultValue={shop?.location ?? ""}
          placeholder="Boston, MA — or 'Mobile across Greater Boston'"
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="shop-phone">Phone</Label>
        <Input
          id="shop-phone"
          name="phone"
          type="tel"
          maxLength={40}
          defaultValue={shop?.phone ?? ""}
          placeholder="+1 (555) 010-2030"
          autoComplete="tel"
        />
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button
        type="submit"
        disabled={pending}
        className="h-11 gap-2 transition-transform duration-(--duration-fast) active:scale-[0.99]"
      >
        {pending ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : null}
        Continue
        <ArrowRight className="size-4" aria-hidden />
      </Button>
    </form>
  )
}

// --- Step 2: Services -------------------------------------------------------

function ServicesStep({
  services,
  onServicesChange,
  onBack,
  onContinue,
}: {
  services: ServiceRow[]
  onServicesChange: (services: ServiceRow[]) => void
  onBack: () => void
  onContinue: () => void
}) {
  return (
    <div className="grid gap-5">
      <div className="space-y-1">
        <h2 className="font-display text-2xl tracking-tight text-foreground">What we offer</h2>
        <p className="text-sm text-muted-foreground">
          Our service menu — prices by vehicle size, durations, and condition
          bumps. The AI uses this to quote and book accurately. We can edit
          anytime.
        </p>
      </div>

      <ServiceMenuCard
        initialServices={services}
        onServicesChange={onServicesChange}
      />

      {services.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          Heads up — the AI needs at least one service to quote a customer.
        </p>
      ) : null}

      <Separator />

      <div className="grid grid-cols-2 gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={onBack}
          className="h-11 gap-2"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Back
        </Button>
        <Button
          type="button"
          onClick={onContinue}
          className="h-11 gap-2 transition-transform duration-(--duration-fast) active:scale-[0.99]"
        >
          Continue
          <ArrowRight className="size-4" aria-hidden />
        </Button>
      </div>
    </div>
  )
}

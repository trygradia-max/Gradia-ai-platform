"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  BadgeCheck,
  Clock,
  Loader2,
  RefreshCw,
  ShieldAlert,
} from "lucide-react"
import { toast } from "sonner"

import {
  refreshA2pStatus,
  resendA2pOtp,
  submitA2pRegistration,
  type A2pState,
} from "@/app/actions/a2p"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { A2pFormInput } from "@/lib/a2p-schema"
import { registrationFromA2pState, textingActionCopy } from "@/lib/onboarding"
import type { A2pBusinessDetails } from "@/lib/types/database"

const BUSINESS_TYPES = [
  "Sole Proprietorship",
  "Partnership",
  "Limited Liability Corporation",
  "Corporation",
  "Co-operative",
  "Non-profit Corporation",
] as const

const EMPTY_FORM: A2pFormInput = {
  has_ein: true,
  legal_name: "",
  ein: "",
  mobile_phone: "",
  business_type: "Limited Liability Corporation",
  website_url: "",
  address: { street: "", city: "", region: "", postal_code: "" },
  contact: {
    first_name: "",
    last_name: "",
    email: "",
    phone: "",
    job_position: "Owner",
  },
}

function formFrom(business: A2pBusinessDetails | null): A2pFormInput {
  if (!business) return EMPTY_FORM
  return {
    ...business,
    has_ein: business.has_ein ?? true,
    ein: business.ein ?? "",
    mobile_phone: business.mobile_phone ?? "",
    website_url: business.website_url ?? "",
    business_type:
      (BUSINESS_TYPES as readonly string[]).find((t) => t === business.business_type) ??
      "Limited Liability Corporation",
  } as A2pFormInput
}

/**
 * Carrier-verification wizard for a Gradia-provisioned number (A2P 10DLC).
 * Lives under the SMS settings card whenever the shop's number is ours and
 * texting isn't unlocked yet. One state machine, written states throughout:
 * form (draft/none) → verifying (brand/campaign pending) → verified, with a
 * rejection state that keeps the owner's details for an in-place fix.
 */
export function A2pWizard({ initial }: { initial: A2pState }) {
  const router = useRouter()
  const [state, setState] = React.useState<A2pState>(initial)
  const registration = registrationFromA2pState(state)
  const action = registration.nextAction
  const copy = textingActionCopy(action)
  const [editing, setEditing] = React.useState(
    registrationFromA2pState(initial).nextAction === "submit" ||
      registrationFromA2pState(initial).nextAction === "resume"
  )
  const [form, setForm] = React.useState<A2pFormInput>(formFrom(initial.business))
  const [submitting, setSubmitting] = React.useState(false)
  const [checking, setChecking] = React.useState(false)
  const [resending, setResending] = React.useState(false)

  /** Sole-prop registrations verify by texting the owner's cell. */
  const isSoleProp =
    (state.business?.has_ein ?? form.has_ein ?? true) === false

  async function handleResendOtp() {
    if (resending) return
    setResending(true)
    const result = await resendA2pOtp()
    setResending(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success("Verification text re-sent — answer it within 24 hours.")
  }

  const set = (patch: Partial<A2pFormInput>) => setForm((f) => ({ ...f, ...patch }))
  const setAddr = (patch: Partial<A2pFormInput["address"]>) =>
    setForm((f) => ({ ...f, address: { ...f.address, ...patch } }))
  const setContact = (patch: Partial<A2pFormInput["contact"]>) =>
    setForm((f) => ({ ...f, contact: { ...f.contact, ...patch } }))

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    const result = await submitA2pRegistration(form)
    setSubmitting(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success("Submitted for texting review.")
    setEditing(false)
    setState((s) => ({
      ...s,
      status: "brand_pending",
      failureReason: null,
      registration: {
        status: "brand_pending",
        nextAction: "wait",
        failedStep: null,
        retryable: null,
        failureReason: null,
        attempts: s.registration?.attempts ?? 0,
      },
    }))
    router.refresh()
  }

  async function handleRefresh() {
    if (checking) return
    setChecking(true)
    const next = await refreshA2pStatus()
    setChecking(false)
    setState(next)
    if (next.registration?.nextAction === "none" || next.status === "approved") {
      toast.success("Texting is approved.")
    }
    router.refresh()
  }

  if (action === "none") {
    return (
      <div className="flex items-center gap-3 rounded-md border border-border/50 bg-muted/15 px-3.5 py-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-status-success-bg text-status-success-fg ring-1 ring-status-success/25">
          <BadgeCheck className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="label-eyebrow text-muted-foreground/70">Texting approval</p>
          <p className="text-sm font-medium text-foreground">{copy.label}</p>
          <p className="text-sm text-foreground">{copy.detail}</p>
        </div>
      </div>
    )
  }

  if (action === "wait") {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-status-warning/25 bg-status-warning-bg px-3.5 py-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-status-warning-bg text-status-warning-fg ring-1 ring-status-warning/25">
          <Clock className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="label-eyebrow text-muted-foreground/70">Texting approval</p>
          <p className="text-sm font-medium text-foreground">{copy.label}</p>
          <p className="text-sm text-foreground">
            {isSoleProp && state.status === "brand_pending"
              ? "Carriers texted your cell. Answer that message, then check status here."
              : copy.detail}
          </p>
        </div>
        {isSoleProp && state.status === "brand_pending" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleResendOtp}
            disabled={resending}
            className="gap-2 shrink-0"
          >
            {resending ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : null}
            Didn&apos;t get the text?
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={checking}
          className="min-h-11 shrink-0 gap-2"
        >
          {checking ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="size-3.5" aria-hidden />
          )}
          Check texting status
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {(action === "fix_and_resubmit" || action === "resubmit_campaign") && !editing ? (
        <div className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/8 px-3.5 py-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-destructive/12 text-destructive ring-1 ring-destructive/25">
            <ShieldAlert className="size-4" aria-hidden />
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <p className="label-eyebrow text-muted-foreground/70">Texting approval</p>
            <p className="text-sm font-medium text-foreground">{copy.label}</p>
            <p className="text-sm text-foreground">
              {state.failureReason ?? copy.detail}
            </p>
            <Button type="button" className="min-h-11" onClick={() => setEditing(true)}>
              {copy.button}
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <p className="label-eyebrow text-muted-foreground/70">Texting approval</p>
            <p className="text-sm font-medium text-foreground">{copy.label}</p>
            <p className="text-sm text-muted-foreground">
              Carriers review this business before it can text. Use the legal name as it is registered.
            </p>
          </div>

          {/* The fork: EIN → Low-Volume Standard; no EIN → sole prop with
              mobile OTP. Asked first because it changes what we collect. */}
          <div className="space-y-1.5">
            <Label htmlFor="a2p-has-ein">Do you have an EIN (federal tax ID)?</Label>
            <Select
              value={form.has_ein === false ? "no" : "yes"}
              onValueChange={(v) =>
                set(
                  v === "no"
                    ? { has_ein: false, ein: "", business_type: "Sole Proprietorship" }
                    : { has_ein: true }
                )
              }
            >
              <SelectTrigger id="a2p-has-ein">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="yes">Yes — we have an EIN</SelectItem>
                <SelectItem value="no">No — registering as a sole proprietor</SelectItem>
              </SelectContent>
            </Select>
            {form.has_ein === false ? (
              <p className="text-xs text-muted-foreground">
                Carriers verify sole proprietors by texting your cell — you&apos;ll
                get a message to answer right after you submit. Use your real
                cell: a number only works for three registrations, ever.
              </p>
            ) : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="a2p-legal-name">
                {form.has_ein === false ? "Business name (as customers know it)" : "Legal business name"}
              </Label>
              <Input
                id="a2p-legal-name"
                value={form.legal_name}
                onChange={(e) => set({ legal_name: e.target.value })}
                placeholder={form.has_ein === false ? "Pristine Detailing" : "Pristine Detailing LLC"}
                required
              />
            </div>
            {form.has_ein === false ? (
              <div className="space-y-1.5">
                <Label htmlFor="a2p-mobile">Your cell (gets the verification text)</Label>
                <Input
                  id="a2p-mobile"
                  value={String(form.mobile_phone ?? "")}
                  onChange={(e) => set({ mobile_phone: e.target.value })}
                  placeholder="+16175550142"
                  required
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="a2p-ein">EIN</Label>
                <Input
                  id="a2p-ein"
                  value={String(form.ein ?? "")}
                  onChange={(e) => set({ ein: e.target.value })}
                  placeholder="12-3456789"
                  required
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="a2p-type">Business structure</Label>
              <Select
                value={form.business_type}
                disabled={form.has_ein === false}
                onValueChange={(v) =>
                  set({ business_type: v as A2pFormInput["business_type"] })
                }
              >
                <SelectTrigger id="a2p-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BUSINESS_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="a2p-website">Website (optional)</Label>
              <Input
                id="a2p-website"
                value={form.website_url ?? ""}
                onChange={(e) => set({ website_url: e.target.value })}
                placeholder="https://pristinedetailing.com"
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
            <div className="space-y-1.5">
              <Label htmlFor="a2p-street">Street address</Label>
              <Input
                id="a2p-street"
                value={form.address.street}
                onChange={(e) => setAddr({ street: e.target.value })}
                placeholder="42 Main St"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="a2p-city">City</Label>
              <Input
                id="a2p-city"
                value={form.address.city}
                onChange={(e) => setAddr({ city: e.target.value })}
                placeholder="Boston"
                required
              />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="a2p-state">State</Label>
              <Input
                id="a2p-state"
                value={form.address.region}
                onChange={(e) => setAddr({ region: e.target.value })}
                placeholder="MA"
                maxLength={2}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="a2p-zip">ZIP</Label>
              <Input
                id="a2p-zip"
                value={form.address.postal_code}
                onChange={(e) => setAddr({ postal_code: e.target.value })}
                placeholder="02118"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="a2p-first">Owner first name</Label>
              <Input
                id="a2p-first"
                value={form.contact.first_name}
                onChange={(e) => setContact({ first_name: e.target.value })}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="a2p-last">Last name</Label>
              <Input
                id="a2p-last"
                value={form.contact.last_name}
                onChange={(e) => setContact({ last_name: e.target.value })}
                required
              />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="a2p-email">Contact email</Label>
              <Input
                id="a2p-email"
                type="email"
                value={form.contact.email}
                onChange={(e) => setContact({ email: e.target.value })}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="a2p-phone">Contact phone</Label>
              <Input
                id="a2p-phone"
                value={form.contact.phone}
                onChange={(e) => setContact({ phone: e.target.value })}
                placeholder="+16175550142"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="a2p-role">Role</Label>
              <Input
                id="a2p-role"
                value={form.contact.job_position}
                onChange={(e) => setContact({ job_position: e.target.value })}
                placeholder="Owner"
                required
              />
            </div>
          </div>

          <div className="flex justify-end">
            <Button type="submit" disabled={submitting} className="min-h-11 gap-2">
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Sending to carriers
                </>
              ) : (
                copy.button ?? "Submit for texting approval"
              )}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}

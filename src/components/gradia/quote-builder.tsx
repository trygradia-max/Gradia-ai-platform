"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Check, Loader2, Mail, MessageSquare, Plus } from "lucide-react"
import { toast } from "sonner"

import {
  addCustomerVehicleFromText,
  createOwnerQuote,
  getCustomerVehicles,
  sendQuote,
} from "@/app/actions/quotes"
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
import { buildQuoteLineItem, computeQuoteTotals } from "@/lib/quotes"
import { formatPriceUsd, resolvePriceCents } from "@/lib/service-pricing"
import { describeVehicle, type VehicleLite } from "@/lib/vehicles"
import type { ConditionMultiplier, ServiceRow } from "@/lib/types/database"
import { cn } from "@/lib/utils"

type CustomerOption = {
  id: string
  name: string | null
  phone: string | null
  email: string | null
}

type Selection = { serviceId: string; multiplierKeys: string[] }

/**
 * Quote builder (C3b). Everything prices through lib/service-pricing on the
 * client for live totals, and AGAIN server-side on create — the server is
 * the source of truth; this preview can never disagree because both call
 * the same module.
 */
export function QuoteBuilder({
  customers,
  services,
  initialCustomerId,
  initialVehicles,
  leadId,
}: {
  customers: CustomerOption[]
  services: ServiceRow[]
  initialCustomerId: string | null
  initialVehicles: VehicleLite[]
  leadId: string | null
}) {
  const router = useRouter()
  const [customerId, setCustomerId] = React.useState<string | null>(initialCustomerId)
  const [vehicles, setVehicles] = React.useState<VehicleLite[]>(initialVehicles)
  const [vehicleId, setVehicleId] = React.useState<string | null>(
    initialVehicles[0]?.id ?? null
  )
  const [vehicleText, setVehicleText] = React.useState("")
  const [selections, setSelections] = React.useState<Selection[]>([])
  const [discount, setDiscount] = React.useState("")
  const [note, setNote] = React.useState("")
  const [busy, setBusy] = React.useState<null | "draft" | "sms" | "email">(null)

  const activeServices = services.filter((s) => s.active !== false && !s.is_addon)
  const addons = services.filter((s) => s.active !== false && s.is_addon)
  const customer = customers.find((c) => c.id === customerId) ?? null
  const vehicle = vehicles.find((v) => v.id === vehicleId) ?? null
  const sizeClass = vehicle?.size_class ?? null

  const lineItems = selections
    .map((sel) => {
      const svc = services.find((s) => s.id === sel.serviceId)
      return svc ? buildQuoteLineItem(svc, sizeClass, sel.multiplierKeys) : null
    })
    .filter((li): li is NonNullable<typeof li> => li !== null)
  const totals = computeQuoteTotals(
    lineItems,
    Math.round((Number(discount) || 0) * 100)
  )

  async function pickCustomer(id: string | null) {
    if (!id) return
    setCustomerId(id)
    setVehicleId(null)
    const v = await getCustomerVehicles(id)
    setVehicles(v)
    setVehicleId(v[0]?.id ?? null)
  }

  async function addVehicle() {
    if (!customerId || !vehicleText.trim()) return
    const result = await addCustomerVehicleFromText(customerId, vehicleText)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setVehicles(result.vehicles)
    setVehicleId(result.vehicles[result.vehicles.length - 1]?.id ?? null)
    setVehicleText("")
  }

  function toggleService(serviceId: string) {
    setSelections((prev) =>
      prev.some((s) => s.serviceId === serviceId)
        ? prev.filter((s) => s.serviceId !== serviceId)
        : [...prev, { serviceId, multiplierKeys: [] }]
    )
  }

  function toggleMultiplier(serviceId: string, key: string) {
    setSelections((prev) =>
      prev.map((s) =>
        s.serviceId === serviceId
          ? {
              ...s,
              multiplierKeys: s.multiplierKeys.includes(key)
                ? s.multiplierKeys.filter((k) => k !== key)
                : [...s.multiplierKeys, key],
            }
          : s
      )
    )
  }

  async function submit(mode: "draft" | "sms" | "email") {
    if (!customerId) {
      toast.error("Pick a customer first.")
      return
    }
    if (selections.length === 0) {
      toast.error("Pick at least one service.")
      return
    }
    setBusy(mode)
    const created = await createOwnerQuote({
      customerId,
      vehicleId,
      leadId,
      selections,
      discountDollars: Number(discount) || 0,
      customerNote: note || null,
      validDays: 14,
    })
    if (!created.ok) {
      setBusy(null)
      toast.error(created.error)
      return
    }
    if (mode === "draft") {
      setBusy(null)
      toast.success("Draft saved — find it under Quotes.")
      router.push("/customers?tab=quotes")
      return
    }
    const sent = await sendQuote(created.quoteId, mode)
    setBusy(null)
    if (!sent.ok) {
      toast[sent.held ? "info" : "error"](
        sent.held
          ? `Saved, but the send is waiting in Approvals: ${sent.error}`
          : sent.error
      )
      router.push(sent.held ? "/approvals" : "/customers?tab=quotes")
      return
    }
    toast.success(
      `Quote sent by ${mode === "sms" ? "text" : "email"} — ${formatPriceUsd(created.totalCents)}.`
    )
    router.push("/customers?tab=quotes")
  }

  return (
    <div className="space-y-6">
      <section className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Customer</Label>
          <Select value={customerId ?? ""} onValueChange={pickCustomer}>
            <SelectTrigger>
              <SelectValue placeholder="Who's this for?" />
            </SelectTrigger>
            <SelectContent>
              {customers.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name ?? c.phone ?? c.email ?? "Unnamed"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Vehicle</Label>
          {vehicles.length > 0 ? (
            <Select
              value={vehicleId ?? ""}
              onValueChange={(v) => setVehicleId(v || null)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Which vehicle?" />
              </SelectTrigger>
              <SelectContent>
                {vehicles.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {describeVehicle(v) ?? "Vehicle"}
                    {v.size_class ? "" : " (size unknown)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="flex gap-2">
              <Input
                placeholder='e.g. "2021 Tesla Model Y, white"'
                value={vehicleText}
                onChange={(e) => setVehicleText(e.target.value)}
                disabled={!customerId}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 shrink-0"
                onClick={addVehicle}
                disabled={!customerId || !vehicleText.trim()}
              >
                <Plus className="size-4" aria-hidden />
                Add
              </Button>
            </div>
          )}
          {vehicle && !vehicle.size_class ? (
            <p className="text-xs text-muted-foreground">
              No size class on this vehicle yet — base prices apply.
            </p>
          ) : null}
        </div>
      </section>

      <section className="space-y-2">
        <p className="label-eyebrow text-muted-foreground/70">Services</p>
        {activeServices.length === 0 ? (
          <p className="rounded-md border border-dashed border-border/60 px-4 py-6 text-center text-sm text-muted-foreground">
            Your menu is empty — set up services in Settings first.
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {activeServices.map((s) => {
              const sel = selections.find((x) => x.serviceId === s.id)
              const price = resolvePriceCents(s, sizeClass)
              return (
                <div
                  key={s.id}
                  className={cn(
                    "rounded-md border px-4 py-3 transition-colors",
                    sel ? "border-primary/40 bg-primary/5" : "border-border/60"
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleService(s.id)}
                    className="flex w-full items-center justify-between gap-2 text-left"
                  >
                    <span className="text-sm font-medium text-foreground">{s.name}</span>
                    <span className="flex items-center gap-2">
                      <span className="font-data text-sm text-foreground">
                        {formatPriceUsd(price)}
                      </span>
                      <span
                        className={cn(
                          "flex size-5 items-center justify-center rounded-md border",
                          sel
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border"
                        )}
                        aria-hidden
                      >
                        {sel ? <Check className="size-3.5" /> : null}
                      </span>
                    </span>
                  </button>
                  {sel && (s.condition_multipliers?.length ?? 0) > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {(s.condition_multipliers as ConditionMultiplier[]).map((m) => (
                        <button
                          key={m.key}
                          type="button"
                          onClick={() => toggleMultiplier(s.id, m.key)}
                          className={cn(
                            "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                            sel.multiplierKeys.includes(m.key)
                              ? "border-primary/40 bg-primary/10 text-foreground"
                              : "border-border/60 text-muted-foreground hover:text-foreground"
                          )}
                        >
                          {m.label ?? m.key} ×{m.multiplier}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </section>

      {addons.length > 0 ? (
        <section className="space-y-2">
          <p className="label-eyebrow text-muted-foreground/70">Add-ons</p>
          <div className="flex flex-wrap gap-2">
            {addons.map((s) => {
              const on = selections.some((x) => x.serviceId === s.id)
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => toggleService(s.id)}
                  className={cn(
                    "rounded-full border px-3.5 py-1.5 text-sm transition-colors",
                    on
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : "border-border/60 text-muted-foreground hover:text-foreground"
                  )}
                >
                  {s.name} · {formatPriceUsd(resolvePriceCents(s, sizeClass))}
                </button>
              )
            })}
          </div>
        </section>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="q-discount">Discount ($, optional)</Label>
          <Input
            id="q-discount"
            inputMode="decimal"
            value={discount}
            onChange={(e) => setDiscount(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="q-note">Note to the customer (optional)</Label>
          <Input
            id="q-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Includes pet-hair removal on the rear seats"
          />
        </div>
      </section>

      <section className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-border/60 bg-card px-5 py-4">
        <div>
          <p className="text-xs text-muted-foreground">Total</p>
          <p className="font-data text-2xl font-semibold text-foreground">
            {formatPriceUsd(totals.total_cents)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy !== null}
            onClick={() => submit("draft")}
            className="gap-1.5"
          >
            {busy === "draft" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Save draft
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy !== null || !customer?.email}
            onClick={() => submit("email")}
            className="gap-1.5"
          >
            {busy === "email" ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Mail className="size-4" aria-hidden />
            )}
            Send by email
          </Button>
          <Button
            type="button"
            disabled={busy !== null || !customer?.phone}
            onClick={() => submit("sms")}
            className="gap-1.5"
          >
            {busy === "sms" ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <MessageSquare className="size-4" aria-hidden />
            )}
            Send by text
          </Button>
        </div>
      </section>
    </div>
  )
}

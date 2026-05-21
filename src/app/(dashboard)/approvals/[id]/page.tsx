import Link from "next/link"
import { notFound } from "next/navigation"

import { PendingProposalEditor } from "@/components/gradia/pending-proposal-editor"
import { SmsQuickReply } from "@/components/gradia/sms-quick-reply"
import { buttonVariants } from "@/components/ui/button"
import { normalizePhone } from "@/lib/customers"
import { requireShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { LeadStatus, PendingActionRow, ShopRow } from "@/lib/types/database"

export const dynamic = "force-dynamic"

type LeadPayload = {
  customer_name?: string
  phone?: string
  car_info?: string | null
  pin_notes?: string | null
  status?: LeadStatus
  source?: string
}

type NotePayload = {
  content?: string
  customer_name?: string | null
  phone?: string | null
  source?: string
}

type BookingPayload = {
  customer_name?: string
  phone?: string
  car_info?: string | null
  service?: string | null
  iso_start_time?: string
  duration_minutes?: number
  timezone?: string | null
  pin_notes?: string | null
  source?: string
}

type SmsPayload = {
  to_phone?: string
  body?: string
  customer_name?: string | null
  reason?: string | null
  source?: string
}

type ChargePayload = {
  customer_name?: string
  customer_email?: string
  amount_cents?: number
  description?: string
  source?: string
}

type EmailPayload = {
  to_email?: string
  subject?: string
  body?: string
  customer_name?: string | null
  reason?: string | null
  source?: string
}

type InstagramDmPayload = {
  recipient_id?: string
  body?: string
  customer_name?: string | null
  reason?: string | null
  source?: string
}

type FacebookDmPayload = {
  recipient_id?: string
  body?: string
  customer_name?: string | null
  reason?: string | null
  source?: string
}

export default async function PendingProposalPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const shop = await requireShop()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("pending_actions")
    .select("*")
    .eq("id", id)
    .eq("shop_id", shop.id)
    .maybeSingle()

  if (error) {
    throw new Error(error.message)
  }
  if (!data) {
    notFound()
  }

  const pending = data as PendingActionRow

  if (pending.status === "approved" || pending.status === "rejected") {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          Already decided
        </h1>
        <p className="text-sm text-muted-foreground">
          This one&apos;s already been {pending.status}. Nothing more for us
          to do here.
        </p>
        <Link
          href="/approvals"
          className={buttonVariants({ variant: "default" })}
        >
          Back to approvals
        </Link>
      </div>
    )
  }

  const editorProps = buildEditorProps(pending)
  const quickReplyTarget = await resolveQuickReplyTarget(
    supabase,
    shop.id,
    pending
  )

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Review proposal
        </h1>
        <p className="text-sm text-muted-foreground">
          Tweak the details before we save it — or drop it if it&apos;s noise.
        </p>
      </div>
      <PendingProposalEditor {...editorProps} />
      {quickReplyTarget ? (
        <SmsQuickReply
          toPhone={quickReplyTarget.toPhone}
          customerName={quickReplyTarget.customerName}
        />
      ) : null}
    </div>
  )
}

async function resolveQuickReplyTarget(
  supabase: Awaited<ReturnType<typeof createClient>>,
  shopId: string,
  pending: PendingActionRow
): Promise<{ toPhone: string; customerName: string | null } | null> {
  // Only surface Quick Reply for lead/booking pendings that arrived via
  // SMS — outbound HITL (`send_sms` itself) has its own editor surface,
  // and notes aren't SMS-bound.
  if (pending.action_type === "send_sms" || pending.action_type === "add_note") {
    return null
  }
  const payload = pending.payload as Record<string, unknown>
  const source = typeof payload.source === "string" ? payload.source : ""
  if (source !== "sms") return null

  const phoneCandidate =
    typeof payload.phone === "string"
      ? payload.phone
      : typeof payload.from_phone === "string"
        ? payload.from_phone
        : ""
  const normalized = normalizePhone(phoneCandidate)
  if (!normalized) return null

  const customerName =
    typeof payload.customer_name === "string" && payload.customer_name.trim()
      ? payload.customer_name
      : null

  // Confirm the shop is wired up for outbound SMS — otherwise no point
  // showing the form.
  const { data: shopRow } = await supabase
    .from("shops")
    .select("twilio_phone_number")
    .eq("id", shopId)
    .single()
  const shop = shopRow as Pick<ShopRow, "twilio_phone_number"> | null
  if (!shop?.twilio_phone_number) return null

  return { toPhone: normalized, customerName }
}

function buildEditorProps(
  pending: PendingActionRow
): React.ComponentProps<typeof PendingProposalEditor> {
  const status =
    pending.status === "edit_requested" ? "edit_requested" : "pending"

  if (pending.action_type === "create_lead") {
    const p = pending.payload as LeadPayload
    return {
      pendingId: pending.id,
      source: typeof p.source === "string" ? p.source : null,
      submittedAt: pending.created_at,
      status,
      initial: {
        type: "create_lead",
        customer_name: p.customer_name ?? "",
        phone: p.phone ?? "",
        car_info: p.car_info ?? null,
        pin_notes: p.pin_notes ?? null,
        status: (p.status ?? "new") as LeadStatus,
      },
    }
  }

  if (pending.action_type === "book_appointment") {
    const p = pending.payload as BookingPayload
    return {
      pendingId: pending.id,
      source: typeof p.source === "string" ? p.source : null,
      submittedAt: pending.created_at,
      status,
      initial: {
        type: "book_appointment",
        customer_name: p.customer_name ?? "",
        phone: p.phone ?? "",
        car_info: p.car_info ?? null,
        service: p.service ?? null,
        iso_start_time: p.iso_start_time ?? "",
        duration_minutes:
          typeof p.duration_minutes === "number" ? p.duration_minutes : 90,
        timezone: p.timezone ?? null,
        pin_notes: p.pin_notes ?? null,
      },
    }
  }

  if (pending.action_type === "send_sms") {
    const p = pending.payload as SmsPayload
    return {
      pendingId: pending.id,
      source: typeof p.source === "string" ? p.source : null,
      submittedAt: pending.created_at,
      status,
      initial: {
        type: "send_sms",
        to_phone: p.to_phone ?? "",
        body: p.body ?? "",
        customer_name: p.customer_name ?? null,
        reason: p.reason ?? null,
      },
    }
  }

  if (pending.action_type === "charge_customer") {
    const p = pending.payload as ChargePayload
    return {
      pendingId: pending.id,
      source: typeof p.source === "string" ? p.source : null,
      submittedAt: pending.created_at,
      status,
      initial: {
        type: "charge_customer",
        customer_name: p.customer_name ?? "",
        customer_email: p.customer_email ?? "",
        amount_cents:
          typeof p.amount_cents === "number" ? p.amount_cents : 0,
        description: p.description ?? "",
      },
    }
  }

  if (pending.action_type === "send_email") {
    const p = pending.payload as EmailPayload
    return {
      pendingId: pending.id,
      source: typeof p.source === "string" ? p.source : null,
      submittedAt: pending.created_at,
      status,
      initial: {
        type: "send_email",
        to_email: p.to_email ?? "",
        subject: p.subject ?? "",
        body: p.body ?? "",
        customer_name: p.customer_name ?? null,
        reason: p.reason ?? null,
      },
    }
  }

  if (pending.action_type === "send_instagram_dm") {
    const p = pending.payload as InstagramDmPayload
    return {
      pendingId: pending.id,
      source: typeof p.source === "string" ? p.source : null,
      submittedAt: pending.created_at,
      status,
      initial: {
        type: "send_instagram_dm",
        recipient_id: p.recipient_id ?? "",
        body: p.body ?? "",
        customer_name: p.customer_name ?? null,
        reason: p.reason ?? null,
      },
    }
  }

  if (pending.action_type === "send_facebook_dm") {
    const p = pending.payload as FacebookDmPayload
    return {
      pendingId: pending.id,
      source: typeof p.source === "string" ? p.source : null,
      submittedAt: pending.created_at,
      status,
      initial: {
        type: "send_facebook_dm",
        recipient_id: p.recipient_id ?? "",
        body: p.body ?? "",
        customer_name: p.customer_name ?? null,
        reason: p.reason ?? null,
      },
    }
  }

  const p = pending.payload as NotePayload
  return {
    pendingId: pending.id,
    source: typeof p.source === "string" ? p.source : null,
    submittedAt: pending.created_at,
    status,
    initial: {
      type: "add_note",
      content: p.content ?? "",
      customer_name: p.customer_name ?? null,
      phone: p.phone ?? null,
    },
  }
}

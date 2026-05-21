import { headers } from "next/headers"
import { Shield } from "lucide-react"

import { EmailSettingsCard } from "@/components/gradia/email-settings-card"
import { FacebookSettingsCard } from "@/components/gradia/facebook-settings-card"
import { InstagramSettingsCard } from "@/components/gradia/instagram-settings-card"
import { SmsSettingsCard } from "@/components/gradia/sms-settings-card"
import { StripeSettingsCard } from "@/components/gradia/stripe-settings-card"
import { VoiceSettingsCard } from "@/components/gradia/voice-settings-card"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { requireShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { ShopRow } from "@/lib/types/database"

export const dynamic = "force-dynamic"

async function resolveWebhookBaseUrl(): Promise<string> {
  const configured = process.env.GRADIA_DASHBOARD_URL?.trim()
  if (configured) {
    try {
      return new URL(configured).origin
    } catch {
      // fall through to header-based detection
    }
  }
  const h = await headers()
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000"
  const proto =
    h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")
  return `${proto}://${host}`
}

const KNOWN_EMAIL_STATUSES = new Set([
  "ok",
  "denied",
  "missing_params",
  "state_mismatch",
  "token_exchange_failed",
  "account_fetch_failed",
  "subscription_failed",
  "save_failed",
])

const KNOWN_STRIPE_STATUSES = new Set([
  "ok",
  "needs_more",
  "no_account",
  "fetch_failed",
  "account_create_failed",
  "link_failed",
])

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; stripe?: string }>
}) {
  const shopCtx = await requireShop()
  const supabase = await createClient()

  const { data } = await supabase
    .from("shops")
    .select("*")
    .eq("id", shopCtx.id)
    .single()

  const shop = (data as ShopRow | null) ?? null
  const baseUrl = await resolveWebhookBaseUrl()
  const webhookUrl = `${baseUrl}/api/vapi/webhook`
  const smsWebhookUrl = `${baseUrl}/api/twilio/sms`
  const metaWebhookUrl = `${baseUrl}/api/meta/webhook`
  const webhookSecretConfigured = Boolean(
    process.env.VAPI_WEBHOOK_SECRET?.trim()
  )
  const aurinkoConfigured = Boolean(
    process.env.AURINKO_CLIENT_ID?.trim() &&
      process.env.AURINKO_CLIENT_SECRET?.trim()
  )
  const metaConfigured = Boolean(
    process.env.META_APP_SECRET?.trim() &&
      process.env.META_WEBHOOK_VERIFY_TOKEN?.trim()
  )
  const twilioConfigured = Boolean(
    process.env.TWILIO_ACCOUNT_SID?.trim() &&
      process.env.TWILIO_AUTH_TOKEN?.trim()
  )
  const stripeConfigured = Boolean(
    process.env.STRIPE_SECRET_KEY?.trim() &&
      process.env.STRIPE_CONNECT_CLIENT_ID?.trim()
  )

  const params = await searchParams
  const rawEmailStatus = params.email ?? null
  const emailStatus =
    rawEmailStatus && KNOWN_EMAIL_STATUSES.has(rawEmailStatus)
      ? (rawEmailStatus as
          | "ok"
          | "denied"
          | "missing_params"
          | "state_mismatch"
          | "token_exchange_failed"
          | "account_fetch_failed"
          | "subscription_failed"
          | "save_failed")
      : null

  const rawStripeStatus = params.stripe ?? null
  const stripeStatus =
    rawStripeStatus && KNOWN_STRIPE_STATUSES.has(rawStripeStatus)
      ? (rawStripeStatus as
          | "ok"
          | "needs_more"
          | "no_account"
          | "fetch_failed"
          | "account_create_failed"
          | "link_failed")
      : null

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Shop, integrations, and account.
        </p>
      </div>

      <VoiceSettingsCard
        initialAssistantId={shop?.vapi_assistant_id ?? null}
        webhookUrl={webhookUrl}
        webhookSecretConfigured={webhookSecretConfigured}
      />

      <EmailSettingsCard
        initialAccountEmail={shop?.aurinko_account_email ?? null}
        aurinkoConfigured={aurinkoConfigured}
        callbackStatus={emailStatus}
      />

      <SmsSettingsCard
        initialPhoneNumber={shop?.twilio_phone_number ?? null}
        webhookUrl={smsWebhookUrl}
        twilioConfigured={twilioConfigured}
      />

      <StripeSettingsCard
        connected={Boolean(shop?.stripe_account_id)}
        chargesEnabled={Boolean(shop?.stripe_charges_enabled)}
        stripeConfigured={stripeConfigured}
        callbackStatus={stripeStatus}
      />

      <InstagramSettingsCard
        initialPageId={shop?.instagram_page_id ?? null}
        initialBusinessAccountId={shop?.instagram_business_account_id ?? null}
        initialHandle={shop?.instagram_account_handle ?? null}
        webhookUrl={metaWebhookUrl}
        metaConfigured={metaConfigured}
      />

      <FacebookSettingsCard
        initialPageId={shop?.facebook_page_id ?? null}
        initialPageName={shop?.facebook_page_name ?? null}
        webhookUrl={metaWebhookUrl}
        metaConfigured={metaConfigured}
      />

      <Card className="border-border/80">
        <CardHeader className="flex flex-row items-center gap-3 space-y-0">
          <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60">
            <Shield className="size-5 text-primary" aria-hidden />
          </div>
          <div>
            <CardTitle className="text-base font-medium">
              More coming soon
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Service menu, team, and billing controls land here next.
            </p>
          </div>
        </CardHeader>
        <CardContent>
          <ul className="list-inside list-disc space-y-2 text-sm text-muted-foreground">
            <li>Edit our service menu — prices, durations, descriptions.</li>
            <li>Invite teammates and manage permissions.</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}

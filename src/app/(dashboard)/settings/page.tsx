import { headers } from "next/headers"
import { Briefcase, Calendar, Mail, MessageSquare, Phone, Shield } from "lucide-react"

import { EmailSettingsCard } from "@/components/gradia/email-settings-card"
import { FacebookSettingsCard } from "@/components/gradia/facebook-settings-card"
import { InstagramSettingsCard } from "@/components/gradia/instagram-settings-card"
import { JobberSettingsCard } from "@/components/gradia/jobber-settings-card"
import { CreditsSettingsCard } from "@/components/gradia/credits-settings-card"
import { KnowledgeSettingsCard } from "@/components/gradia/knowledge-settings-card"
import { McpTokensCard } from "@/components/gradia/mcp-tokens-card"
import { SettingsSectionNav } from "@/components/gradia/settings-section-nav"
import { getA2pState } from "@/app/actions/a2p"
import { A2pWizard } from "@/components/gradia/a2p-wizard"
import { SmsSettingsCard } from "@/components/gradia/sms-settings-card"
import { StripeSettingsCard } from "@/components/gradia/stripe-settings-card"
import { VoiceBuilderCard } from "@/components/gradia/voice-builder-card"
import { listVoiceOptions } from "@/lib/voice-provider"
import { ConnectionTile } from "@/components/gradia/connection-tile"
import { SectionHeader } from "@/components/gradia/section-header"
import { AutonomyDefaultCard } from "@/components/gradia/autonomy-default-card"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { listShopKnowledge } from "@/lib/knowledge"
import { listMcpTokensForCurrentShop } from "@/app/actions/mcp"
import { getCreditUsage } from "@/app/actions/billing"
import { getPendingMetaPages } from "@/app/actions/meta-oauth"
import { MetaCallbackToast } from "@/components/gradia/meta-callback-toast"
import { readAutonomy } from "@/lib/autonomy"
import { integrationEnabled } from "@/lib/features"
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

const KNOWN_JOBBER_STATUSES = new Set([
  "ok",
  "denied",
  "missing_params",
  "state_mismatch",
  "token_exchange_failed",
  "account_fetch_failed",
  "save_failed",
])

const KNOWN_META_STATUSES = new Set([
  "ok",
  "pick",
  "denied",
  "missing_params",
  "state_mismatch",
  "not_signed_in",
  "token_exchange_failed",
  "page_list_failed",
  "no_pages",
  "subscribe_failed",
  "save_failed",
])

type MetaCallbackStatus =
  | "ok"
  | "pick"
  | "denied"
  | "missing_params"
  | "state_mismatch"
  | "not_signed_in"
  | "token_exchange_failed"
  | "page_list_failed"
  | "no_pages"
  | "subscribe_failed"
  | "save_failed"

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    email?: string
    stripe?: string
    jobber?: string
    meta?: string
  }>
}) {
  const shopCtx = await requireShop()
  const supabase = await createClient()

  const { data } = await supabase
    .from("shops")
    .select("*")
    .eq("id", shopCtx.id)
    .single()

  const shop = (data as ShopRow | null) ?? null
  const autonomyDefault = readAutonomy(shop).default
  const knowledgeEntries = await listShopKnowledge(supabase, shopCtx.id)
  const mcpTokens = await listMcpTokensForCurrentShop()
  const baseUrl = await resolveWebhookBaseUrl()
  const smsWebhookUrl = `${baseUrl}/api/twilio/sms`
  const metaWebhookUrl = `${baseUrl}/api/meta/webhook`
  const vapiConfigured = Boolean(process.env.VAPI_API_KEY?.trim())
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
  const jobberConfigured = Boolean(
    process.env.JOBBER_CLIENT_ID?.trim() &&
      process.env.JOBBER_CLIENT_SECRET?.trim()
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

  const rawJobberStatus = params.jobber ?? null
  const jobberStatus =
    rawJobberStatus && KNOWN_JOBBER_STATUSES.has(rawJobberStatus)
      ? (rawJobberStatus as
          | "ok"
          | "denied"
          | "missing_params"
          | "state_mismatch"
          | "token_exchange_failed"
          | "account_fetch_failed"
          | "save_failed")
      : null

  const rawMetaStatus = params.meta ?? null
  const metaStatus: MetaCallbackStatus | null =
    rawMetaStatus && KNOWN_META_STATUSES.has(rawMetaStatus)
      ? (rawMetaStatus as MetaCallbackStatus)
      : null

  // Multi-page picker payload — populated when the OAuth callback
  // returned more than one Page and stashed the candidates in a
  // short-lived cookie.
  const pendingMetaPages = await getPendingMetaPages()
  const creditUsage = await getCreditUsage()
  const a2pState = await getA2pState()
  const voiceOptions = listVoiceOptions()

  const sections = [
    { id: "voice", label: "Voice" },
    { id: "email", label: "Email" },
    { id: "sms", label: "SMS" },
    { id: "payments", label: "Payments" },
    { id: "instagram", label: "Instagram" },
    { id: "facebook", label: "Facebook" },
    { id: "jobber", label: "Jobber" },
    { id: "knowledge", label: "Knowledge" },
    { id: "usage", label: "Usage" },
    { id: "developer", label: "Developer" },
    { id: "soon", label: "More" },
  ].filter(
    (s) =>
      !["payments", "instagram", "facebook"].includes(s.id) ||
      integrationEnabled(s.id)
  )

  return (
    <div className="mx-auto w-full max-w-3xl">
      <SectionHeader
        className="pt-2 pb-6"
        eyebrow="Connections"
        title={
          <>
            The <em className="italic">wiring</em> behind the scenes.
          </>
        }
        subhead="The channels and tools we run on. Connect once — we handle the rest."
      />

      <MetaCallbackToast status={metaStatus} />

      <div className="space-y-8 pt-2">
        <div className="space-y-3">
          <p className="label-eyebrow text-muted-foreground/70">Channels</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <ConnectionTile
              icon={Phone}
              name="Voice"
              description="Answers calls, quotes, and books — in our voice."
              connected={Boolean(shop?.vapi_assistant_id)}
              available={vapiConfigured}
              connectedLabel="Assistant linked"
              connectedDetail="Answering calls"
              connectHref="#voice"
              manageHref="#voice"
            />
            <ConnectionTile
              icon={Mail}
              name="Email"
              description="Reads leads and drafts replies for our approval."
              connected={Boolean(shop?.aurinko_account_email)}
              available={aurinkoConfigured}
              connectedLabel={shop?.aurinko_account_email}
              connectedDetail="Reading + drafting"
              connectHref="/api/aurinko/auth/start"
              popup
              manageHref="#email"
            />
            <ConnectionTile
              icon={MessageSquare}
              name="SMS"
              description="Catches every text and drafts a reply in a minute."
              connected={Boolean(shop?.twilio_phone_number)}
              available={twilioConfigured}
              connectedLabel={shop?.twilio_phone_number}
              connectedDetail="Texting back"
              connectHref="#sms"
              manageHref="#sms"
            />
          </div>
        </div>

        <div className="space-y-3">
          <p className="label-eyebrow text-muted-foreground/70">
            Your business
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <ConnectionTile
              icon={Calendar}
              name="Calendar"
              description="Puts approved bookings on our calendar."
              connected={Boolean(shop?.aurinko_account_email)}
              available={aurinkoConfigured}
              connectedLabel={
                shop?.aurinko_account_email ? "Google Calendar" : null
              }
              connectedDetail="On the books"
              connectHref="/api/aurinko/auth/start"
              popup
              manageHref="#email"
            />
            <ConnectionTile
              icon={Briefcase}
              name="Jobs (CRM)"
              description="Pushes approved leads and bookings to Jobber."
              connected={Boolean(shop?.jobber_account_name)}
              available={jobberConfigured}
              connectedLabel={shop?.jobber_account_name}
              connectedDetail="Synced to Jobber"
              connectHref="/api/jobber/auth/start"
              popup
              manageHref="#jobber"
            />
          </div>
        </div>
      </div>

      <div className="pt-8">
        <AutonomyDefaultCard initialMode={autonomyDefault} />
      </div>

      <details className="pt-10">
        <summary className="label-eyebrow cursor-pointer select-none text-muted-foreground/70 transition-colors hover:text-foreground">
          Manage individual connections
        </summary>
        <SettingsSectionNav sections={sections} />

      <div className="space-y-10 pt-8 [&>section]:scroll-mt-24">
        <section id="voice">
          {shop ? (
            <VoiceBuilderCard
              shop={shop}
              voiceOptions={voiceOptions}
              vapiConfigured={vapiConfigured}
            />
          ) : null}
        </section>

        <section id="email">
          <EmailSettingsCard
            initialAccountEmail={shop?.aurinko_account_email ?? null}
            aurinkoConfigured={aurinkoConfigured}
            callbackStatus={emailStatus}
          />
        </section>

        <section id="sms" className="space-y-4">
          <SmsSettingsCard
            initialPhoneNumber={shop?.twilio_phone_number ?? null}
            webhookUrl={smsWebhookUrl}
            twilioConfigured={twilioConfigured}
            byoConnected={Boolean(
              shop?.twilio_account_sid_enc && shop?.twilio_auth_token_enc
            )}
          />
          {/* Carrier verification — only for Gradia-provisioned numbers;
              BYO shops handle A2P on their own Twilio account. */}
          {shop?.gradia_number_e164 &&
          shop.twilio_phone_number === shop.gradia_number_e164 ? (
            <A2pWizard initial={a2pState} />
          ) : null}
        </section>

        {integrationEnabled("payments") && (
          <section id="payments">
            <StripeSettingsCard
              connected={Boolean(shop?.stripe_account_id)}
              chargesEnabled={Boolean(shop?.stripe_charges_enabled)}
              stripeConfigured={stripeConfigured}
              callbackStatus={stripeStatus}
            />
          </section>
        )}

        {integrationEnabled("instagram") && (
          <section id="instagram">
            <InstagramSettingsCard
              initialPageId={shop?.instagram_page_id ?? null}
              initialBusinessAccountId={
                shop?.instagram_business_account_id ?? null
              }
              initialHandle={shop?.instagram_account_handle ?? null}
              webhookUrl={metaWebhookUrl}
              metaConfigured={metaConfigured}
              pendingPages={pendingMetaPages}
            />
          </section>
        )}

        {integrationEnabled("facebook") && (
          <section id="facebook">
            <FacebookSettingsCard
              initialPageId={shop?.facebook_page_id ?? null}
              initialPageName={shop?.facebook_page_name ?? null}
              webhookUrl={metaWebhookUrl}
              metaConfigured={metaConfigured}
              pendingPages={pendingMetaPages}
            />
          </section>
        )}

        <section id="jobber">
          <JobberSettingsCard
            initialAccountName={shop?.jobber_account_name ?? null}
            jobberConfigured={jobberConfigured}
            callbackStatus={jobberStatus}
          />
        </section>

        <section id="knowledge">
          <KnowledgeSettingsCard initialEntries={knowledgeEntries} />
        </section>

        <section id="usage">
          <CreditsSettingsCard
            spent={creditUsage.spent}
            limit={creditUsage.limit}
          />
        </section>

        <section id="developer">
          <McpTokensCard initialTokens={mcpTokens} />
        </section>

        <section id="soon">
          <Card className="border-border/60">
            <CardHeader className="flex flex-row items-center gap-3 space-y-0">
              <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60">
                <Shield className="size-5 text-primary" aria-hidden />
              </div>
              <div>
                <CardTitle className="font-display text-lg tracking-tight">
                  More on the way
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
        </section>
      </div>
      </details>
    </div>
  )
}

import { headers } from "next/headers"
import Link from "next/link"
import { Bot, Briefcase, Calendar, ChevronRight, Mail, MessageSquare, Phone, Shield } from "lucide-react"

import { EmailSettingsCard } from "@/components/gradia/email-settings-card"
import { JobberSettingsCard } from "@/components/gradia/jobber-settings-card"
import { UsageMeters } from "@/components/gradia/usage-meters"
import { KnowledgeSettingsCard } from "@/components/gradia/knowledge-settings-card"
import { ReviewLinkCard } from "@/components/gradia/review-link-card"
import { McpTokensCard } from "@/components/gradia/mcp-tokens-card"
import { AutomationsCard } from "@/components/gradia/automations-card"
import { ClearDemoDataCard } from "@/components/gradia/clear-demo-data-card"
import { DataExportCard } from "@/components/gradia/data-export-card"
import { WorkingHoursCard } from "@/components/gradia/working-hours-card"
import { getAutomationSettings } from "@/app/actions/automations"
import { ServiceMenuCard } from "@/components/gradia/service-menu-card"
import { SettingsSectionNav } from "@/components/gradia/settings-section-nav"
import { getA2pState } from "@/app/actions/a2p"
import { A2pWizard } from "@/components/gradia/a2p-wizard"
import { SmsSettingsCard } from "@/components/gradia/sms-settings-card"
import { StripeSettingsCard } from "@/components/gradia/stripe-settings-card"
import { VoiceBuilderCard } from "@/components/gradia/voice-builder-card"
import { listVoiceOptions } from "@/lib/voice-provider"
import { ConnectionTile } from "@/components/gradia/connection-tile"
import { HelpTip } from "@/components/gradia/help-tip"
import { SectionHeader } from "@/components/gradia/section-header"
import { AutonomyDefaultCard } from "@/components/gradia/autonomy-default-card"
import { SimulationModeCard } from "@/components/gradia/simulation-mode-card"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  connectionStatus,
  integrationAvailability,
} from "@/lib/data/connections"
import { listServicesForCurrentShop } from "@/lib/data/services"
import { listShopKnowledge } from "@/lib/knowledge"
import { listMcpTokensForCurrentShop } from "@/app/actions/mcp"
import { getUsageState } from "@/app/actions/billing"
import { readAutonomy } from "@/lib/autonomy"
import { integrationEnabled } from "@/lib/features"
import { getReviewLink } from "@/lib/review-link"
import { readWorkingHours } from "@/lib/working-hours"
import { requireShop } from "@/lib/shop"
import { STRINGS } from "@/lib/strings"
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

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    email?: string
    stripe?: string
    jobber?: string
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
  // One connection truth + one availability source (UX-001): the tiles, the
  // cards below them, Home, and onboarding all read these same predicates.
  const connection = connectionStatus(shop)
  const availability = integrationAvailability()
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

  const usageState = await getUsageState()
  const a2pState = await getA2pState()
  const voiceOptions = listVoiceOptions()
  const services = await listServicesForCurrentShop()
  const automationEntries = await getAutomationSettings()

  const sections = [
    { id: "services", label: "Service menu" },
    { id: "hours", label: "Working hours" },
    { id: "automations", label: "Automations" },
    { id: "voice", label: "Voice" },
    { id: "email", label: "Email" },
    { id: "sms", label: "SMS" },
    { id: "payments", label: "Payments" },
    { id: "jobber", label: "Jobber" },
    { id: "knowledge", label: "Knowledge" },
    { id: "reviews", label: "Reviews" },
    { id: "usage", label: "Usage" },
    { id: "developer", label: "Developer" },
    { id: "soon", label: "More" },
  ].filter((s) => !["payments"].includes(s.id) || integrationEnabled(s.id))

  return (
    <div className="mx-auto w-full max-w-3xl">
      <SectionHeader
        className="pt-2 pb-6"
        eyebrow="Connections"
        level={1}
        title={<>The wiring behind the scenes.</>}
        subhead="The channels and tools we run on. Connect once — we handle the rest."
      />

      <div className="space-y-8 pt-2">
        {/* "What Gradia does" lives here now that the primary nav is three
            pages (FOCUS spec §4.4) — the capability roster + autonomy dial. */}
        <Link
          href="/receptionist"
          className="group flex items-center gap-4 rounded-2xl border border-border/60 bg-card px-5 py-4 transition-colors hover:border-border"
        >
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/25">
            <Bot className="size-[18px]" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-display text-lg leading-tight tracking-tight text-foreground">
              What Gradia does
            </p>
            <p className="text-sm text-muted-foreground">
              See what&apos;s running for us, and tune how much we act on our own.
            </p>
          </div>
          <ChevronRight
            className="size-5 shrink-0 text-muted-foreground/60 transition-transform duration-200 group-hover:translate-x-0.5"
            aria-hidden
          />
        </Link>

        <div className="space-y-3">
          <p className="label-eyebrow text-muted-foreground/70">Channels</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <ConnectionTile
              icon={Phone}
              name="Voice"
              description="Answers calls, quotes, and books — in our voice."
              connected={connection.voice.connected}
              available={availability.voice}
              unavailableReason={STRINGS.connections.notAvailableReason.voice}
              help={STRINGS.help.settings.voice}
              connectedLabel="Assistant linked"
              connectedDetail="Answering calls"
              connectHref="#voice"
              manageHref="#voice"
            />
            <ConnectionTile
              icon={Mail}
              name="Email"
              description="Reads leads and drafts replies for our approval."
              connected={connection.email.connected}
              available={availability.email}
              unavailableReason={STRINGS.connections.notAvailableReason.email}
              help={STRINGS.help.settings.email}
              connectedLabel={
                connection.email.identity ??
                STRINGS.connections.identityFallback.email
              }
              connectedDetail="Reading + drafting"
              connectHref="/api/aurinko/auth/start"
              popup
              manageHref="#email"
            />
            <ConnectionTile
              icon={MessageSquare}
              name="SMS"
              description="Catches every text and drafts a reply in a minute."
              connected={connection.sms.connected}
              available={availability.sms}
              unavailableReason={STRINGS.connections.notAvailableReason.sms}
              help={STRINGS.help.settings.sms}
              connectedLabel={connection.sms.identity}
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
              connected={connection.calendar.connected}
              available={availability.calendar}
              unavailableReason={STRINGS.connections.notAvailableReason.calendar}
              help={STRINGS.help.settings.calendar}
              connectedLabel={connection.calendar.identity}
              connectedDetail="On the books"
              connectHref="/api/aurinko/auth/start"
              popup
              manageHref="#email"
            />
            <ConnectionTile
              icon={Briefcase}
              name="Jobs — Jobber"
              description="Pushes approved leads and bookings to Jobber."
              connected={connection.crm.connected}
              available={availability.crm}
              unavailableReason={STRINGS.connections.notAvailableReason.crm}
              help={STRINGS.help.settings.crm}
              connectedLabel={
                connection.crm.identity ??
                STRINGS.connections.identityFallback.crm
              }
              connectedDetail="Synced to Jobber"
              connectHref="/api/jobber/auth/start"
              popup
              manageHref="#jobber"
            />
          </div>
        </div>
      </div>

      <div className="grid gap-4 pt-8 lg:grid-cols-2">
        <AutonomyDefaultCard initialMode={autonomyDefault} />
        <SimulationModeCard initialEnabled={shop?.simulation_mode ?? false} />
      </div>

      <details className="pt-10">
        <summary className="label-eyebrow cursor-pointer select-none text-muted-foreground/70 transition-colors hover:text-foreground">
          Manage individual connections
        </summary>
        <SettingsSectionNav sections={sections} />

      <div className="space-y-10 pt-8 [&>section]:scroll-mt-24">
        {/* The shop's brain (CRM C3a): one menu feeds quotes, phone answers,
            and drafts through lib/service-pricing — never edited elsewhere. */}
        <section id="services">
          <ServiceMenuCard initialServices={services} />
        </section>

        {/* Working hours — calendar capacity + the agent's hours line. */}
        <section id="hours">
          <WorkingHoursCard initial={readWorkingHours(shop?.settings)} />
        </section>

        {/* C5 catalog — toggles, not a builder. */}
        <section id="automations">
          <AutomationsCard initial={automationEntries} />
        </section>

        <section id="voice">
          {shop ? (
            <VoiceBuilderCard
              shop={shop}
              voiceOptions={voiceOptions}
              vapiConfigured={availability.voice}
            />
          ) : null}
        </section>

        <section id="email">
          <EmailSettingsCard
            initialConnected={connection.email.connected}
            initialAccountEmail={connection.email.identity}
            available={availability.email}
            callbackStatus={emailStatus}
          />
        </section>

        <section id="sms" className="space-y-4">
          <SmsSettingsCard
            initialPhoneNumber={connection.sms.identity}
            webhookUrl={smsWebhookUrl}
            twilioConfigured={availability.sms}
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

        <section id="jobber">
          <JobberSettingsCard
            initialAccountName={
              connection.crm.connected
                ? (connection.crm.identity ??
                  STRINGS.connections.identityFallback.crm)
                : null
            }
            jobberConfigured={availability.crm}
            callbackStatus={jobberStatus}
          />
        </section>

        <section id="knowledge">
          <KnowledgeSettingsCard initialEntries={knowledgeEntries} />
        </section>

        <section id="reviews">
          <ReviewLinkCard initial={getReviewLink(shop)} />
        </section>

        {/* Human units lead; credits are the fine print (pricing doc copy
            rule + UX spec Part 3). The old credit-limit editor is gone —
            the cap IS the allowance now; packs extend it from Billing. */}
        <section id="usage">
          <Card className="border-border/60">
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5 font-display text-lg tracking-tight">
                Plan &amp; usage
                <HelpTip label="Plan and usage" text={STRINGS.help.settings.usage} />
              </CardTitle>
            </CardHeader>
            <CardContent>
              <UsageMeters usage={usageState} />
            </CardContent>
          </Card>
        </section>

        {/* Developer mode — off (collapsed) by default; everything
            technical relocates here, nothing is deleted
            (GRADIA_UX_ONBOARDING_SPEC Part 2). */}
        <section id="developer">
          <details className="rounded-xl border border-border/40 bg-card/30 px-4 py-1">
            <summary className="cursor-pointer list-none py-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
              Developer — API tokens and integration internals
            </summary>
            <div className="space-y-4 pb-4 pt-2">
              <McpTokensCard initialTokens={mcpTokens} />
              <DataExportCard />
              <ClearDemoDataCard />
            </div>
          </details>
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
                  Team and billing controls land here next.
                </p>
              </div>
            </CardHeader>
            <CardContent>
              <ul className="list-inside list-disc space-y-2 text-sm text-muted-foreground">
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

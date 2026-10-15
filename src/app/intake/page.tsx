import { z } from "zod"
import Link from "next/link"

import { ErrorState } from "@/components/gradia/error-state"
import { FormField } from "@/components/gradia/form-field"
import { IntakeReviewQueue } from "@/components/gradia/intake-review-queue"
import { ListToolbar } from "@/components/gradia/list-toolbar"
import { Pagination } from "@/components/gradia/pagination"
import { QualificationList } from "@/components/gradia/qualification-list"
import { SectionHeader } from "@/components/gradia/section-header"
import { TeamChrome } from "@/components/gradia/team-chrome"
import { buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { loadIntakeReview } from "@/lib/data/intake-review"
import { loadLeadQualifications } from "@/lib/data/lead-qualification"
import { intakeCustomerSchema } from "@/lib/intake-identity"
import { requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { TeamWorkspace } from "@/lib/team-permissions"

export const dynamic = "force-dynamic"

const workspaceLink =
  "inline-flex min-h-11 items-center text-sm text-accent-text underline-offset-4 hover:underline"

export default async function IntakePage({
  searchParams,
}: {
  searchParams: Promise<{ shop?: string; page?: string; qpage?: string; query?: string }>
}) {
  await requireUser()
  const db = await createClient()
  const params = await searchParams
  const workspaces = await db.rpc("team_workspaces")
  if (workspaces.error) throw new Error("Workspace access could not be verified.")
  const allowed = ((workspaces.data ?? []) as TeamWorkspace[]).filter(
    (w) => w.role === "owner" || (w.role === "manager" && w.capabilities.includes("crm.read"))
  )
  const workspace = params.shop ? allowed.find((w) => w.id === params.shop) : allowed[0]
  const rawPage = Number(params.page ?? "1")
  const page =
    Number.isSafeInteger(rawPage) && rawPage > 0 && rawPage < 100000 ? rawPage : 1
  if (!workspace) {
    return (
      <TeamChrome>
        <SectionHeader
          level={1}
          eyebrow="Intake"
          title="Intake review"
          subhead="This shop’s intake and qualification review are not available to your account."
        />
        <ErrorState
          title="Intake unavailable"
          description="Owner access or a manager CRM-read grant is required. Revoked and staff memberships cannot open intake or qualification."
          action={
            <Link href="/team" className={workspaceLink}>
              Back to your workspaces
            </Link>
          }
        />
      </TeamChrome>
    )
  }
  const query = typeof params.query === "string" ? params.query.slice(0, 100) : ""
  const candidates =
    workspace.role === "owner"
      ? await db.rpc("search_intake_customers", { p_shop: workspace.id, p_query: query })
      : null
  const parsed =
    candidates && !candidates.error
      ? z.array(intakeCustomerSchema).safeParse(candidates.data)
      : null
  const customers = parsed?.success ? parsed.data : undefined
  const rawQualificationPage = Number(params.qpage ?? "1")
  const qualificationPage =
    Number.isSafeInteger(rawQualificationPage) &&
    rawQualificationPage > 0 &&
    rawQualificationPage < 100000
      ? rawQualificationPage
      : 1
  const result = await loadIntakeReview(db, workspace.id, (page - 1) * 20)
  const qualifications = await loadLeadQualifications(
    db,
    workspace.id,
    (qualificationPage - 1) * 20
  )
  const pageQuery = query ? `&query=${encodeURIComponent(query)}` : ""
  const base = `/intake?shop=${workspace.id}`
  const start = (page - 1) * 20 + 1
  const shown = result.ok ? result.queue.items.length : 0
  const end = start + Math.max(shown - 1, 0)
  return (
    <TeamChrome>
      <Link href="/team" className={workspaceLink}>
        Your workspaces
      </Link>
      <SectionHeader
        level={1}
        eyebrow="Intake"
        title={`${workspace.name} · Intake review`}
        subhead="Unresolved submissions wait for an identity link. Linked intake can be qualified below. Viewing does not create a customer, record consent, send a message, or start nurture."
      />
      <nav aria-label="Intake workspaces" className="flex flex-wrap gap-4">
        {allowed.map((w) => (
          <Link
            key={w.id}
            href={`/intake?shop=${w.id}`}
            aria-current={w.id === workspace.id ? "page" : undefined}
            className={workspaceLink}
          >
            {w.name}
          </Link>
        ))}
      </nav>
      {workspace.role === "owner" ? (
        <ListToolbar
          label="Find an existing customer for linking"
          search={
            <form method="get" className="space-y-3 sm:max-w-md">
              <input type="hidden" name="shop" value={workspace.id} />
              <input type="hidden" name="page" value={String(page)} />
              <FormField
                id="intake-customer-query"
                label="Find an existing customer for linking"
                hint="Up to 20 matches from this shop. Searching does not select an identity or filter the intake queue. Create a genuinely new customer through the existing CRM first."
              >
                <Input
                  name="query"
                  maxLength={100}
                  defaultValue={query}
                  placeholder="Name, phone or email"
                  className="h-11"
                  autoComplete="off"
                  spellCheck={false}
                />
              </FormField>
              <button type="submit" className={cn(buttonVariants({ variant: "outline" }), "min-h-11")}>
                Search customers
              </button>
              {!customers ? (
                <ErrorState
                  compact
                  title="Customer choices could not be loaded. Linking is unavailable."
                />
              ) : null}
            </form>
          }
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          Identity linking currently requires the owner. Your read grant does not authorize changes.
        </p>
      )}
      <IntakeReviewQueue result={result} shopId={workspace.id} customers={customers} />
      <Pagination
        label="Intake pages"
        status={
          result.ok
            ? result.queue.total === 0
              ? "No unresolved intake in this shop."
              : shown === 0
                ? `No items on this page of ${result.queue.total} unresolved in this shop.`
                : `Showing ${start}–${end} of ${result.queue.total} unresolved in this shop.`
            : undefined
        }
        previous={
          page > 1
            ? { href: `${base}&page=${page - 1}&qpage=${qualificationPage}${pageQuery}` }
            : null
        }
        next={
          result.ok && page * 20 < result.queue.total
            ? { href: `${base}&page=${page + 1}&qpage=${qualificationPage}${pageQuery}` }
            : null
        }
      />
      <QualificationList result={qualifications} shopId={workspace.id} />
      <Pagination
        label="Qualification pages"
        status={
          qualifications.ok
            ? qualifications.data.items.length === 0
              ? "No qualification records in this shop."
              : `Showing qualification page ${qualificationPage}.`
            : undefined
        }
        previous={
          qualificationPage > 1
            ? { href: `${base}&page=${page}&qpage=${qualificationPage - 1}${pageQuery}` }
            : null
        }
        next={
          qualifications.ok && qualifications.data.items.length > 20
            ? { href: `${base}&page=${page}&qpage=${qualificationPage + 1}${pageQuery}` }
            : null
        }
      />
    </TeamChrome>
  )
}

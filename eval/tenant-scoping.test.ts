import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { forShop } from "@/lib/supabase/for-shop"

/**
 * P0-011 — tenant-scoping regression locks.
 *
 * 1. CLAIM CALL SITES: every executeApproval / executeRejection /
 *    markEditRequested call in src passes an explicit shopId argument.
 *    TypeScript already enforces arity; this scan catches the failure mode
 *    the compiler can't — someone passing the PENDING id twice or a decider
 *    object in the shop slot reads fine to tsc if the types line up wrong
 *    in a refactor. The scan asserts the 3rd argument is not an object
 *    literal (deciders are `{ … }`; shop ids are identifiers/strings).
 *
 * 2. SERVICE-ROLE IMPORTER INVENTORY: importing createServiceClient means
 *    RLS is bypassed and tenant scoping is on the author. New importers must
 *    be added here DELIBERATELY — the failure message routes the author to
 *    the P0-011 sweep discipline. This is a review-visibility mechanism,
 *    not a style rule: the list is expected to change; changing it silently
 *    is what this test prevents.
 */

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...walk(p))
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p)
  }
  return out
}

const SRC = walk("src")

describe("claim call sites pass an explicit shop id (C-2 lock)", () => {
  it("no executeApproval/executeRejection/markEditRequested call puts a decider in the shop slot", () => {
    const offenders: string[] = []
    for (const file of SRC) {
      const source = readFileSync(file, "utf8")
      if (!/execute(Approval|Rejection)\(|markEditRequested\(/.test(source)) {
        continue
      }
      // Collapse whitespace so multi-line calls scan as one line.
      const flat = source.replace(/\s+/g, " ")
      for (const match of flat.matchAll(
        /(?:executeApproval|executeRejection|markEditRequested)\(\s*[^,()]+,\s*[^,()]+,\s*(\{)/g
      )) {
        offenders.push(`${file}: 3rd argument is an object — expected a trusted shopId`)
        void match
      }
    }
    expect(offenders).toEqual([])
  })
})

describe("service-role importer inventory (sweep visibility)", () => {
  // The P0-011 sweep classified every file below (completion report table).
  // Adding an importer? Scope every tenant-owned query per the sweep rules
  // (trusted server-side shop resolution; no bare-id mutations; forShop
  // where it fits) and add the file here in the same PR.
  const REVIEWED_IMPORTERS = new Set([
    "src/app/actions/a2p.ts",
    "src/app/actions/jobs.ts",
    "src/app/actions/payments.ts",
    "src/app/actions/quote-response.ts",
    "src/app/actions/twilio-provision.ts",
    "src/app/actions/voice-builder.ts",
    "src/app/api/admin/margin-report/route.ts",
    "src/app/api/aurinko/webhook/route.ts",
    "src/app/api/cron/agents/route.ts",
    "src/app/api/cron/automations/route.ts",
    "src/app/api/cron/no-show-ladder/route.ts",
    "src/app/api/cron/reconcile/route.ts",
    "src/app/api/cron/recovery-retention/route.ts",
    "src/app/api/cron/reminders/route.ts",
    "src/app/api/cron/roi-receipt/route.ts",
    "src/app/api/cron/voice-sync/route.ts",
    "src/app/api/mcp/route.ts",
    "src/app/api/recovery/import/[jobId]/extract/route.ts",
    "src/app/api/recovery/import/route.ts",
    "src/app/api/slack/interactivity/route.ts",
    "src/app/api/stripe/webhook/route.ts",
    "src/app/api/twilio/a2p/status/route.ts",
    "src/app/api/twilio/sms/route.ts",
    "src/app/api/twilio/sms/status/route.ts",
    "src/app/api/vapi/webhook/route.ts",
    "src/lib/agent-events.ts",
    "src/lib/credits.ts",
    "src/lib/mcp/auth.ts",
    "src/lib/rate-limit.ts",
    "src/lib/slack.ts",
    "src/lib/supabase/service.ts",
  ])

  it("every createServiceClient importer is on the reviewed list", () => {
    const current = SRC.filter((f) =>
      readFileSync(f, "utf8").includes("createServiceClient")
    ).map((f) => f.replace(/\\/g, "/"))

    const unreviewed = current.filter((f) => !REVIEWED_IMPORTERS.has(f))
    expect(
      unreviewed,
      `New service-role importer(s) — the service client bypasses RLS. ` +
        `Scope every tenant-owned query (P0-011 sweep rules / ADR-003 forShop) ` +
        `and add the file to REVIEWED_IMPORTERS in the same PR.`
    ).toEqual([])

    // Stale entries rot the list's meaning — prune removed files too.
    const gone = [...REVIEWED_IMPORTERS].filter((f) => !current.includes(f))
    expect(gone, "Remove deleted files from REVIEWED_IMPORTERS").toEqual([])
  })
})

describe("forShop facade (ADR-003 design proof)", () => {
  it("refuses construction without a shop id (fail closed)", () => {
    expect(() =>
      forShop({} as never, "")
    ).toThrowError(/requires a non-empty trusted shopId/)
  })

  it("stamps the authorized shop over a forged shop_id on update (cannot re-tenant)", () => {
    const captured: Record<string, unknown>[] = []
    const builder = {
      eq: () => builder,
    }
    const client = {
      from: () => ({
        update: (values: Record<string, unknown>) => {
          captured.push(values)
          return builder
        },
      }),
    }
    forShop(client as never, "shop-A").update("leads", {
      status: "lost",
      shop_id: "shop-B", // forged — must lose, or the row MOVES tenants
    })
    expect(captured[0].shop_id).toBe("shop-A")
    expect(captured[0].status).toBe("lost")
  })

  it("stamps the authorized shop over a forged shop_id on insert", () => {
    const captured: Record<string, unknown>[] = []
    const client = {
      from: () => ({
        insert: (rows: Record<string, unknown>) => {
          captured.push(rows)
          return { ok: true }
        },
      }),
    }
    forShop(client as never, "shop-A").insert("leads", {
      customer_name: "Mallory",
      shop_id: "shop-B", // forged — must lose
    })
    expect(captured[0].shop_id).toBe("shop-A")
  })

  it("applies the shop predicate on update/delete/select by construction", () => {
    const eqCalls: Array<[string, unknown]> = []
    const builder = {
      eq: (col: string, val: unknown) => {
        eqCalls.push([col, val])
        return builder
      },
    }
    const client = {
      from: () => ({
        update: () => builder,
        delete: () => builder,
        select: () => builder,
      }),
    }
    const db = forShop(client as never, "shop-A")
    db.update("import_jobs", { status: "failed" })
    db.delete("services")
    db.select("leads")
    expect(eqCalls).toEqual([
      ["shop_id", "shop-A"],
      ["shop_id", "shop-A"],
      ["shop_id", "shop-A"],
    ])
  })
})

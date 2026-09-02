import { describe, expect, it } from "vitest"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { STRINGS } from "@/lib/strings"

/**
 * UX-001 — truthful state + polish pass. Source-scan locks so the fixes cannot
 * quietly regress:
 *   1. No "coming soon" anywhere in owner-visible source — a server setting
 *      being absent is a NOT AVAILABLE state, never a roadmap promise.
 *   2. No vendor plumbing or env-var names in owner-visible copy (components,
 *      chrome strings, Home channel copy, Receptionist prerequisites).
 *   3. Every real `(dashboard)` page has its own `loading.tsx` skeleton;
 *      redirect stubs are listed explicitly so a new stub is a deliberate act.
 *   4. Inline help exists for every approval action type, every builder field,
 *      and every Settings card — and reads in narrator voice.
 *   5. Every Settings ConnectionTile carries an honest NOT AVAILABLE reason.
 */

const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname)
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8")

function walk(dir: string, match: RegExp): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p, match))
    else if (match.test(name)) out.push(p)
  }
  return out
}

/** Strip block + line comments so doc-comments explaining the rule don't trip it. */
function withoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
}

const rel = (abs: string) => abs.slice(ROOT.length)

describe("UX-001 §1 — no 'coming soon' in owner-visible source", () => {
  it("components, app routes, strings and data modules", () => {
    const files = [
      ...walk(join(ROOT, "src/components"), /\.tsx?$/),
      ...walk(join(ROOT, "src/app"), /\.tsx$/),
      "src/lib/strings.ts",
      "src/lib/data/channels.ts",
      "src/lib/data/agents.ts",
    ].map((f) => (f.startsWith("/") ? f : join(ROOT, f)))
    const offenders = files.filter((f) =>
      /coming soon/i.test(withoutComments(readFileSync(f, "utf8")))
    )
    expect(offenders.map(rel)).toEqual([])
  })
})

describe("UX-001 §2 — no vendor plumbing or env-var names in owner copy", () => {
  it("components never print env var names", () => {
    const offenders = walk(join(ROOT, "src/components"), /\.tsx$/).filter((f) =>
      /\b(AURINKO|TWILIO|VAPI|JOBBER|STRIPE|HOUSECALLPRO|SLACK)_[A-Z_]+\b/.test(
        withoutComments(readFileSync(f, "utf8")).replace(/process\.env\.\w+/g, "")
      )
    )
    expect(offenders.map(rel)).toEqual([])
  })

  it("owner-visible string literals never name Aurinko or Slack", () => {
    const files = [
      ...walk(join(ROOT, "src/components"), /\.tsx$/),
      join(ROOT, "src/lib/strings.ts"),
      join(ROOT, "src/lib/data/channels.ts"),
      join(ROOT, "src/lib/data/agents.ts"),
      join(ROOT, "src/lib/bi-tools.ts"),
      join(ROOT, "src/lib/owner-agent.ts"),
    ]
    const offenders: string[] = []
    for (const f of files) {
      const src = withoutComments(readFileSync(f, "utf8"))
      // Quoted literals and JSX text only — identifiers/imports are plumbing.
      const literals = src.match(/"[^"\n]*"|'[^'\n]*'|`[^`]*`|>[^<{}]+</g) ?? []
      if (literals.some((s) => /\bAurinko\b|\bSlack\b/.test(s) && !/@\/lib\//.test(s))) {
        offenders.push(rel(f))
      }
    }
    expect(offenders).toEqual([])
  })

  it("Home channel copy and Receptionist prerequisites name products, not vendors", () => {
    for (const relPath of ["src/lib/data/channels.ts", "src/lib/data/agents.ts"]) {
      const literals = withoutComments(read(relPath)).match(/"[^"\n]*"/g) ?? []
      const vendors = literals.filter((s) => /\b(Aurinko|Twilio|Vapi)\b/.test(s))
      expect(vendors, relPath).toEqual([])
    }
  })
})

describe("UX-001 §3 — required states per real dashboard route", () => {
  const DASH = join(ROOT, "src/app/(dashboard)")
  const pages = walk(DASH, /^page\.tsx$/)

  /** A redirect stub: the whole page is a redirect, no JSX returned. */
  const isStub = (src: string) => /redirect\(/.test(src) && !/return \(/.test(src)

  const stubs = pages.filter((p) => isStub(readFileSync(p, "utf8")))
  const real = pages.filter((p) => !isStub(readFileSync(p, "utf8")))

  it("the redirect stubs are exactly the documented consolidation set", () => {
    const expected = [
      "agent",
      "agents",
      "agents/build",
      "chat",
      "leads",
      "recovery",
      "schedule",
    ].sort()
    const got = stubs
      .map((p) => p.slice(DASH.length + 1).replace(/\/page\.tsx$/, ""))
      .sort()
    expect(got).toEqual(expected)
  })

  it("every real page has its own loading.tsx skeleton", () => {
    const missing = real
      .filter((p) => !existsSync(p.replace(/page\.tsx$/, "loading.tsx")))
      .map(rel)
    expect(missing).toEqual([])
  })

  it("skeletons use Skeleton primitives, never spinners", () => {
    for (const p of walk(DASH, /^loading\.tsx$/)) {
      const src = readFileSync(p, "utf8")
      expect(src, rel(p)).toContain("@/components/ui/skeleton")
      expect(src, rel(p)).not.toMatch(/animate-spin|Loader2/)
    }
  })

  it("the dashboard error boundary and not-found remain in place", () => {
    expect(existsSync(join(DASH, "error.tsx"))).toBe(true)
    expect(existsSync(join(DASH, "not-found.tsx"))).toBe(true)
  })
})

describe("UX-001 §4 — inline help coverage + narrator voice", () => {
  it("every pending_actions type has an approval help line", () => {
    const types = read("src/lib/types/database.ts")
      .split("export type PendingActionType =")[1]
      .split("\n\nexport type")[0]
      .match(/"([a-z_]+)"/g)!
      .map((s) => s.replace(/"/g, ""))
    expect(types.length).toBeGreaterThanOrEqual(8)
    for (const t of types) {
      expect(
        (STRINGS.help.approvals as Record<string, string>)[t],
        `help.approvals.${t}`
      ).toBeTruthy()
    }
  })

  it("every voice-builder field has a help line", () => {
    const src = read("src/components/gradia/voice-builder-card.tsx")
    const ids = [...src.matchAll(/htmlFor="vb-(\w+)"/g)].map((m) => m[1])
    expect(ids.length).toBeGreaterThanOrEqual(8)
    for (const id of ids) {
      expect(
        new RegExp(`htmlFor="vb-${id}"[\\s\\S]{0,200}<HelpTip`).test(src),
        `vb-${id} lacks a HelpTip`
      ).toBe(true)
    }
  })

  it("every Settings card renders a HelpTip", () => {
    const cards = [
      "service-menu-card",
      "working-hours-card",
      "automations-card",
      "voice-builder-card",
      "email-settings-card",
      "sms-settings-card",
      "jobber-settings-card",
      "knowledge-settings-card",
      "review-link-card",
      "mcp-tokens-card",
      "clear-demo-data-card",
      "autonomy-default-card",
      "simulation-mode-card",
    ]
    for (const c of cards) {
      expect(read(`src/components/gradia/${c}.tsx`), c).toMatch(/<HelpTip\b/)
    }
    // The inline Plan & usage card lives on the page itself.
    expect(read("src/app/(dashboard)/settings/page.tsx")).toContain(
      "STRINGS.help.settings.usage"
    )
  })

  it("approval cards render the per-type help line", () => {
    expect(read("src/components/gradia/approvals-list.tsx")).toContain(
      "STRINGS.help.approvals[item.action_type]"
    )
  })

  it("help + connection copy obey the narrator rules (≤ 2 sentences, no !, no emoji, no vendors)", () => {
    const all: string[] = [
      ...Object.values(STRINGS.help.settings),
      ...Object.values(STRINGS.help.approvals),
      ...Object.values(STRINGS.help.builder),
      ...Object.values(STRINGS.connections.notAvailableReason),
    ]
    for (const s of all) {
      expect(s, s).not.toMatch(/!/)
      expect(s, s).not.toMatch(/\p{Extended_Pictographic}/u)
      expect(s, s).not.toMatch(/\b(Aurinko|Twilio|Vapi|Slack)\b/)
      expect(s, s).not.toMatch(/\b[A-Z]{3,}_[A-Z_]+\b/)
      expect(s.split(/(?<=[.?])\s+/).length, s).toBeLessThanOrEqual(2)
    }
  })
})

describe("UX-001 §5 — every Settings tile has an honest NOT AVAILABLE reason", () => {
  it("unavailableReason + help on each ConnectionTile", () => {
    const src = read("src/app/(dashboard)/settings/page.tsx")
    const tiles = src.match(/<ConnectionTile[\s\S]*?\/>/g) ?? []
    expect(tiles.length).toBeGreaterThanOrEqual(5)
    for (const t of tiles) {
      expect(t).toMatch(/unavailableReason=\{STRINGS\.connections\.notAvailableReason\./)
      expect(t).toMatch(/help=\{STRINGS\.help\.settings\./)
      expect(t).toMatch(/connected=\{connection\./)
      expect(t).toMatch(/available=\{availability\./)
    }
    // No tile keys "connected" off a raw shop field any more (the flag-hidden
    // Stripe Connect card is not a ConnectionTile and is outside the helper).
    for (const t of tiles) expect(t).not.toMatch(/connected=\{Boolean\(shop\?\./)
    expect(src).not.toMatch(/connected=\{Boolean\(shop\?\.aurinko_account_email\)/)
  })
})

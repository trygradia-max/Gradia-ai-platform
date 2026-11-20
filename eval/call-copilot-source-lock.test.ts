import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * PR D is the ingress and consent-evidence boundary ONLY. These locks keep it that way until a later,
 * reviewed PR changes them on purpose (PR E extraction/proposals, PR F UI, provider activation).
 */
const ROOT = join(__dirname, "..")
const SRC = join(ROOT, "src")
const LIB = join(SRC, "lib", "call-copilot")

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}
const sources = walk(SRC).filter((p) => /\.(ts|tsx)$/.test(p))
const read = (p: string) => readFileSync(p, "utf8")
const rel = (p: string) => relative(ROOT, p)

describe("Call Copilot PR D boundary", () => {
  it("is imported by nothing outside its own module: no route, page, action, cron or worker uses it yet", () => {
    const users = sources.filter((p) => !p.startsWith(LIB)).filter((p) => /call-copilot|call_copilot/.test(read(p)))
    expect(users.map(rel)).toEqual([])
  })

  it("adds no route, no page and no provider webhook", () => {
    const names = walk(SRC).filter((p) => /call-?copilot/i.test(relative(SRC, p)) && !p.startsWith(LIB))
    expect(names.map(rel)).toEqual([])
  })

  it("only the typed adapter files in the module name the three database entry points", () => {
    const rpcUsers = sources.filter((p) => /call_copilot_(record_event|capture_state|assert_capture)/.test(read(p)))
    expect(rpcUsers.map(rel).sort()).toEqual([
      "src/lib/call-copilot/capture-gate.ts",
      "src/lib/call-copilot/ingress.ts",
    ])
  })

  it("imports no model, speech, vendor, CRM or sending code", () => {
    const forbidden = /(from\s+["'](?:@\/lib\/(?:twilio|telephony-provider|voice-provider|vapi|agent|owner-agent|approvals|autonomy|customers|crm|memory|owner|sms|email|whisper)[^"']*|@anthropic-ai[^"']*|@langchain[^"']*|openai|twilio|ai|@ai-sdk[^"']*|stripe)["'])/
    for (const p of walk(LIB)) {
      expect(read(p), rel(p)).not.toMatch(forbidden)
    }
  })

  it("the module can only talk to Supabase through the passed-in client (no service client of its own)", () => {
    for (const p of walk(LIB)) {
      expect(read(p), rel(p)).not.toMatch(/createServiceClient|createClient\(|process\.env/)
    }
  })

  it("leaves the receptionist call-record writer exactly as it was", () => {
    const src = read(join(SRC, "lib", "call-records.ts"))
    expect(src).not.toMatch(/copilot/i)
    expect(src).toContain('onConflict: "shop_id,vapi_call_id"')
  })

  it("the ingress migration is additive: it creates objects and alters or drops nothing that exists", () => {
    const dir = join(ROOT, "supabase", "migrations")
    const file = readdirSync(dir).find((f) => f.endsWith("_call_copilot_ingress.sql"))!
    const sql = readFileSync(join(dir, file), "utf8")
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+public\.(?!call_copilot_)/i)
    expect(sql).not.toMatch(/DROP\s+(TABLE|FUNCTION|TRIGGER|POLICY|INDEX|COLUMN)/i)
    expect(sql).not.toMatch(/INSERT\s+INTO\s+public\.(?!call_copilot_)/i)
    expect(sql).not.toMatch(/UPDATE\s+public\./i)
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+public\.call_records/i) // never alters the receptionist artifact
  })

  describe("the consent fold requires both parties to consent to the SAME disclosure version", () => {
    const dir = join(ROOT, "supabase", "migrations")
    const file = readdirSync(dir).find((f) => f.endsWith("_call_copilot_ingress.sql"))!
    const sql = readFileSync(join(dir, file), "utf8")
    const start = sql.indexOf("CREATE FUNCTION public.call_copilot_capture_state")
    const fold = sql.slice(start, sql.indexOf("END $$;", start))

    it("tracks each party's consented version, never a bare boolean", () => {
      expect(start).toBeGreaterThan(0)
      expect(fold).toMatch(/consent_operator text\b/)
      expect(fold).toMatch(/consent_caller text\b/)
      expect(fold).not.toMatch(/consent_(operator|caller)\s+boolean/)
      expect(fold).not.toMatch(/consent_(operator|caller)\s*:=\s*(true|false)\b/i)
      expect(fold).toMatch(/consent_operator := e\.disclosure_version/)
      expect(fold).toMatch(/consent_caller := e\.disclosure_version/)
    })

    it("a pause voids both parties' recorded versions", () => {
      expect(fold).toMatch(/consent_operator := NULL;\s*consent_caller := NULL;/)
    })

    it("both the first activation and a resume compare the two versions, and neither can pass on presence alone", () => {
      const activation = fold.match(/IF NOT paused AND NOT active[\s\S]*?THEN/)?.[0] ?? ""
      const resume = fold.match(/IF paused AND consent_operator[\s\S]*?THEN/)?.[0] ?? ""
      for (const guard of [activation, resume]) {
        expect(guard).toMatch(/consent_operator IS NOT NULL/)
        expect(guard).toMatch(/consent_caller IS NOT NULL/)
        expect(guard).toMatch(/consent_operator = consent_caller/)
      }
      // the only two places the fold ever turns capture on
      expect((fold.match(/active := true/g) ?? []).length).toBe(2)
    })
  })

  it("stores no content: the ledger has no free-text, audio, transcript, number or name column", () => {
    const dir = join(ROOT, "supabase", "migrations")
    const file = readdirSync(dir).find((f) => f.endsWith("_call_copilot_ingress.sql"))!
    const sql = readFileSync(join(dir, file), "utf8")
    const tables = sql.match(/CREATE TABLE public\.call_copilot_\w+ \([\s\S]*?\n\);/g) ?? []
    expect(tables).toHaveLength(3)
    for (const t of tables) {
      expect(t).not.toMatch(/\b(transcript|audio|recording_url|summary|phone|e164|caller_number|name|email|body|content|text_body|note|notes|message)\b\s+(text|jsonb|bytea)/i)
    }
  })
})

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

import { PR_F_REVIEW_FILES } from "./_call-copilot-pr-f-files"

/**
 * PR F is the post-call REVIEW surface: it reads through two narrow database functions and decides through the existing
 * approval path. These locks keep it that way: no table access for the browser, no second executor, no provider, model,
 * transcription or memory seam, no wider authority than the owner (approve) and an owner / crm.read manager (read).
 */
const ROOT = join(__dirname, "..")
const SRC = join(ROOT, "src")
const MIGRATIONS = join(ROOT, "supabase", "migrations")
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p] })
const read = (p: string) => readFileSync(p, "utf8")
const rel = (p: string) => relative(ROOT, p)
/** Comments removed, so prose about the executor is not mistaken for using it. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
const sqlCode = (s: string) => s.replace(/--.*$/gm, "")

const files = PR_F_REVIEW_FILES.map((f) => join(ROOT, f))
const reviewLib = ["review-dto.ts", "review-read.ts", "review-model.ts"].map((f) => join(SRC, "lib", "call-copilot", f))
const surface = [...files, ...reviewLib, join(SRC, "lib", "call-review", "cursor.ts"), join(SRC, "lib", "call-review", "workspace.ts")]
const migrationFile = readdirSync(MIGRATIONS).find((f) => f.endsWith("_call_copilot_review_reads.sql"))!
const sql = read(join(MIGRATIONS, migrationFile))

describe("PR F surface (TypeScript)", () => {
  it("the review files exist exactly where the allow-list says", () => {
    for (const f of files) expect(() => statSync(f), f).not.toThrow()
    const named = walk(join(SRC, "components", "gradia", "call-review")).map(rel).sort()
    expect(named.every((n) => n.startsWith("src/components/gradia/call-review/"))).toBe(true)
  })

  it("reads only through the two review functions: no table access, no service client, no environment, no network", () => {
    for (const f of surface) {
      const s = code(read(f))
      expect(s, rel(f)).not.toMatch(/\.from\(\s*["'`]/)
      expect(s, rel(f)).not.toMatch(/createServiceClient|process\.env|\bfetch\(|XMLHttpRequest|localStorage|sessionStorage/)
    }
    const rpcs = surface.flatMap((f) => [...code(read(f)).matchAll(/\.rpc\(\s*["'`]([a-z_]+)["'`]/g)].map((m) => m[1]))
    // team_workspaces is the existing signed-in workspace list the team pages already use
    expect([...new Set(rpcs)].sort()).toEqual(["call_copilot_review_detail", "call_copilot_review_list", "team_workspaces"])
  })

  it("only the server-action file runs an approval, and only through the existing executor", () => {
    const action = code(read(join(SRC, "app", "actions", "call-copilot-review.ts")))
    expect(action).toMatch(/executeApproval\(/)
    expect(action).toMatch(/executeRejection\(/)
    expect(action).not.toMatch(/\.(insert|update|upsert|delete)\(/)
    expect(action).not.toMatch(/pending_actions|claim_control_action|control_claim|\.from\(/)
    for (const f of surface.filter((f) => !f.endsWith("call-copilot-review.ts"))) {
      expect(code(read(f)), rel(f)).not.toMatch(/executeApproval|executeRejection|claim_control_action|control_claim/)
    }
    // the decide module takes the executor as an injected dependency; it never imports it
    expect(code(read(join(SRC, "lib", "call-review", "decide.ts")))).not.toMatch(/from\s+["']@\/lib\/approvals["'](?!;?\s*$)[^\n]*(execute)/)
    expect(code(read(join(SRC, "lib", "call-review", "decide.ts")))).toMatch(/import type \{ ApprovalResult, DecisionResult \} from "@\/lib\/approvals"/)
  })

  it("the actions file takes references only: strict schemas, session identity, owner shop", () => {
    const action = code(read(join(SRC, "app", "actions", "call-copilot-review.ts")))
    expect(action).toMatch(/^"use server"/m)
    expect(action.match(/\.strict\(\)/g)!.length).toBeGreaterThanOrEqual(3)
    expect(action).toMatch(/requireUser\(\)/)
    expect(action).toMatch(/getOptionalShop\(\)/)
    expect(action).not.toMatch(/shopId:\s*(parsed|input|data)/)
    // every export of a "use server" file must be an async function
    const exported = [...action.matchAll(/^export\s+(\w+)/gm)].map((m) => m[1])
    expect(exported.every((k) => k === "async")).toBe(true)
  })

  it("only the client list component imports the server actions; pages and panels never do", () => {
    const importers = surface.filter((f) => /@\/app\/actions\/call-copilot-review/.test(code(read(f)))).map(rel).sort()
    expect(importers).toEqual(["src/components/gradia/call-review/proposal-list.tsx"])
  })

  it("adds no provider, model, speech, transcription or memory seam", () => {
    const forbidden = /(from\s+["'](?:@\/lib\/(?:twilio|telephony-provider|voice-provider|vapi|agent-runtime|owner-agent|memory|knowledge|embeddings|sms|email)[^"']*|@anthropic-ai[^"']*|@langchain[^"']*|openai|twilio|ai|@ai-sdk[^"']*|stripe)["'])/
    for (const f of surface) {
      expect(code(read(f)), rel(f)).not.toMatch(forbidden)
      expect(code(read(f)), rel(f)).not.toMatch(/recordTranscriptSegment|sealEvidence|proposeFromCall|requireCaptureGrant|recordCallCopilotEvent|runExtractor/)
    }
  })

  it("never re-adds a customer-memory hand-off, and never offers a memory proposal an action", () => {
    for (const p of walk(SRC).filter((p) => /\.(ts|tsx)$/.test(p))) expect(read(p), rel(p)).not.toMatch(/call_copilot_submit_memory_candidate|submitMemoryCandidate/)
    expect(sql).not.toMatch(/submit_memory_candidate|reviewed_memory/i)
    const model = code(read(join(SRC, "lib", "call-copilot", "review-model.ts")))
    expect(model).toMatch(/memory_candidate: \[\]/)
    expect(model).toMatch(/if \(!isExecutable\(p\)\) return \{ kind: "review_only" \}/)
  })

  it("renders every copy string through the chrome strings file, and raw codes only through the copy maps", () => {
    const strings = read(join(SRC, "lib", "strings.ts"))
    expect(strings).toMatch(/callReview: \{/)
    for (const f of files.filter((f) => f.endsWith(".tsx"))) {
      // a raw review/freshness/status field is never interpolated into the page
      expect(code(read(f)), rel(f)).not.toMatch(/\{(?:p|proposal|capture|detail|sel|r|c|g)\.(?:review_reason|freshness|reason|failure_code|capture_reason|not_current_reason)\}/)
    }
  })
})

describe("PR F migration", () => {
  const body = sqlCode(sql)

  it("adds objects only: no table, column, policy, trigger, grant on a table, row or existing function is touched", () => {
    expect(body).not.toMatch(/\bALTER\s+TABLE\b|\bDROP\b|\bCREATE\s+OR\s+REPLACE\b|\bCREATE\s+POLICY\b|\bCREATE\s+TRIGGER\b|\bCREATE\s+TABLE\b/i)
    expect(body).not.toMatch(/^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\b/im)
    expect(body).not.toMatch(/\bGRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\b/i)
    const created = [...body.matchAll(/CREATE\s+(?:UNIQUE\s+)?(INDEX|FUNCTION)\s+(?:IF NOT EXISTS\s+)?(?:public\.)?(\w+)/gi)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`)
    expect(created.sort()).toEqual([
      "FUNCTION call_copilot_review_ambiguity", "FUNCTION call_copilot_review_detail", "FUNCTION call_copilot_review_freshness",
      "FUNCTION call_copilot_review_list", "FUNCTION call_copilot_review_snippet", "FUNCTION call_copilot_review_viewer",
      "INDEX call_copilot_calls_shop_created_idx",
    ])
  })

  it("grants EXECUTE on exactly the two readers, to authenticated only; helpers and every other role get nothing", () => {
    const grants = [...body.matchAll(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+([\s\S]*?)\s+TO\s+([a-z_, ]+);/gi)]
    expect(grants).toHaveLength(1)
    expect(grants[0]![2]!.trim()).toBe("authenticated")
    expect(grants[0]![1]!.match(/call_copilot_\w+/g)).toEqual(["call_copilot_review_list", "call_copilot_review_detail"])
    expect(body).not.toMatch(/\bGRANT\b[^;]*\bTO\b[^;]*\b(anon|service_role|PUBLIC)\b/i)
    const revoke = body.match(/REVOKE\s+ALL\s+ON\s+FUNCTION([\s\S]*?)FROM\s+PUBLIC,\s*anon,\s*authenticated,\s*service_role;/i)!
    expect(revoke[1]!.match(/call_copilot_\w+/g)!.sort()).toEqual([
      "call_copilot_review_ambiguity", "call_copilot_review_detail", "call_copilot_review_freshness",
      "call_copilot_review_list", "call_copilot_review_snippet", "call_copilot_review_viewer",
    ])
  })

  it("every function is read-only, SECURITY DEFINER with a pinned search_path, and the actor is auth.uid(), never an argument", () => {
    const fns = body.split(/CREATE\s+FUNCTION/i).slice(1)
    expect(fns).toHaveLength(6)
    for (const f of fns) {
      expect(f).toMatch(/\bSTABLE\b|\bIMMUTABLE\b/)
      expect(f).toMatch(/SET search_path = ''/)
      expect(f).not.toMatch(/p_actor|p_user|p_role/i)
    }
    for (const f of fns.filter((f) => /^\s*public\.call_copilot_review_(list|detail|viewer)\b/.test(f))) expect(f).toMatch(/SECURITY DEFINER/)
    expect(fns.filter((f) => /^\s*public\.call_copilot_review_viewer\b/.test(f))[0]).toMatch(/auth\.uid\(\)/)
    for (const reader of fns.filter((f) => /^\s*public\.call_copilot_review_(list|detail)\b/.test(f))) {
      expect(reader).toMatch(/call_copilot_review_viewer\(p_shop\)/)
      expect(reader).toMatch(/USING ERRCODE = '42501'/)
    }
    // no function writes: a read must never lock a row either
    expect(body).not.toMatch(/\bFOR\s+(UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)\b|\bPERFORM\s+pg_advisory/i)
  })

  it("is bounded: capped page size, capped proposals and snippet budget, keyset order", () => {
    expect(body).toMatch(/least\(greatest\(coalesce\(p_limit, 20\), 1\), 25\)/)
    expect(body).toMatch(/LIMIT 60/)
    expect(body).toMatch(/budget integer := 300/)
    expect(body).toMatch(/\(c\.created_at, c\.id\) < \(p_before_created, p_before_id\)/)
  })

  it("transcript text leaves the database only as one verified, bounded, gated cited span", () => {
    const snippet = body.slice(body.indexOf("CREATE FUNCTION public.call_copilot_review_snippet"), body.indexOf("CREATE FUNCTION public.call_copilot_review_list"))
    expect(snippet).toMatch(/substr\(seg\.text, p_start \+ 1, p_end - p_start\)/)
    expect(snippet).toMatch(/encode\(sha256\(convert_to\(q, 'UTF8'\)\), 'hex'\) IS DISTINCT FROM p_digest/)
    expect(snippet).toMatch(/call_copilot_has_card_number\(q\)/)
    expect(snippet).toMatch(/seg\.started_at/)
    expect(snippet).toMatch(/left\(q, 279\)/)
    // outside the snippet function the transcript text column is never projected
    const elsewhere = body.replace(snippet, "")
    expect(elsewhere).not.toMatch(/\.text\b|SELECT[^;]*\btext\b[^;]*FROM\s+public\.call_copilot_transcript_segments/i)
    // snippets are shown only while the call gate AND current evidence permit
    const detail = body.slice(body.indexOf("CREATE FUNCTION public.call_copilot_review_detail"))
    expect(detail).toMatch(/call_copilot_assert_capture\(p_shop, p_call, 'crm_mutation', NULL\)/)
    expect(detail).toMatch(/can_show := gate_ok AND sel_current/)
    expect(detail).toMatch(/IF NOT can_show THEN\s+snip := jsonb_build_object\('state', 'withheld'\)/)
    // provider ids, caller numbers and user ids never leave
    expect(detail).not.toMatch(/provider_call_id|requested_by,|created_by,/)
  })

  it("freshness runs the claim's own checks in the claim's own order", () => {
    const order = (fn: string) => {
      const start = sql.indexOf(`CREATE FUNCTION public.${fn}`)
      const end = sql.indexOf("END $$;", start)
      return [...sqlCode(sql.slice(start, end)).matchAll(/RETURN '(call_[a-z_]+)'/g)].map((m) => m[1])
    }
    const claim = (() => {
      const proposals = read(join(MIGRATIONS, readdirSync(MIGRATIONS).find((f) => f.endsWith("_call_copilot_proposals.sql"))!))
      const start = proposals.indexOf("CREATE FUNCTION public.call_copilot_recheck")
      const end = proposals.indexOf("END $$;", start)
      return [...sqlCode(proposals.slice(start, end)).matchAll(/RETURN '(call_[a-z_]+)'/g)].map((m) => m[1])
    })()
    expect(order("call_copilot_review_freshness")).toEqual(claim)
    expect(claim).toEqual(["call_proposal_unknown", "call_proposal_edited", "call_requester_revoked", "call_proposal_expired", "call_consent_unavailable", "call_evidence_changed", "call_definition_inactive", "call_crm_state_changed"])
  })

  it("is the newest migration, with a unique version, and keeps the fail-closed deploy note", () => {
    const versions = readdirSync(MIGRATIONS).map((f) => f.slice(0, 14))
    expect(new Set(versions).size).toBe(versions.length)
    expect(migrationFile.slice(0, 14) > "20261120140000").toBe(true)
    expect(versions.sort().at(-1)).toBe(migrationFile.slice(0, 14))
    expect(sql).toMatch(/Deploy order: apply this migration BEFORE/)
  })
})

import { PR_F_REVIEW_FILES } from "./_call-copilot-pr-f-files"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * PR E adds source-cited extraction and APPROVAL-REQUIRED proposals, and nothing that can act on its own.
 * These locks keep it that way: no route, no provider, no second executor, no second memory store, and
 * exactly one change to an existing function (a recheck that can only deny).
 */
const ROOT = join(__dirname, "..")
const SRC = join(ROOT, "src")
const LIB = join(SRC, "lib", "call-copilot")
const MIGRATIONS = join(ROOT, "supabase", "migrations")

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}
const read = (p: string) => readFileSync(p, "utf8")
const rel = (p: string) => relative(ROOT, p)
const libFiles = walk(LIB).filter((p) => p.endsWith(".ts"))
/** Code without comments, so prose about the executor is not mistaken for using it. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
const migration = (suffix: string) => read(join(MIGRATIONS, readdirSync(MIGRATIONS).find((f) => f.endsWith(suffix))!))
const sql = migration("_call_copilot_proposals.sql")

describe("Call Copilot PR E boundary (TypeScript)", () => {
  it("only the existing read-only/schema modules are imported from the rest of the app", () => {
    const allowed = new Set([
      "@/lib/supabase/for-shop", "@/lib/contact-destination", "@/lib/control-center/record-command", "@/lib/mcp/proposal",
    ])
    for (const p of libFiles) {
      for (const m of read(p).matchAll(/from\s+["'](@\/[^"']+)["']/g)) {
        expect(allowed.has(m[1]), `${rel(p)} imports ${m[1]}`).toBe(true)
      }
    }
  })

  it("has no executor, provider, model, network, environment or service-client access", () => {
    for (const p of libFiles) {
      const s = code(p)
      expect(s, rel(p)).not.toMatch(/createServiceClient|createClient\(|process\.env|\bfetch\(|XMLHttpRequest|node:(http|https|net|child_process)/)
      expect(s, rel(p)).not.toMatch(/from\s+["'](?:@\/lib\/(?:approvals|autonomy|twilio|telephony|voice|vapi|aurinko|memory|knowledge|embeddings|owner-agent|agent|send-policy|service-purpose|credits)[^"']*|@anthropic-ai[^"']*|openai|ai|@ai-sdk[^"']*|twilio|stripe)["']/)
      expect(s, rel(p)).not.toMatch(/executeApproval|claim_control_action|control_claim|pending_actions/)
    }
  })

  it("never writes a CRM, quote, booking, task, message, interaction or memory row directly", () => {
    for (const p of libFiles) {
      expect(code(p), rel(p)).not.toMatch(/\.from\(["'](?:customers|vehicles|leads|quotes|appointments|interactions|reviewed_memory\w*|pending_actions|call_records)["']\)\s*\.(insert|update|upsert|delete)/)
      expect(code(p), rel(p)).not.toMatch(/\b(?:scoped|db|client|supabase)\.(insert|update|upsert|delete)\(/)
    }
  })

  it("is imported by nothing outside the module except the PR F review surface (no webhook, cron or worker)", () => {
    const users = walk(SRC)
      .filter((p) => /\.(ts|tsx)$/.test(p) && !p.startsWith(LIB))
      .filter((p) => /call-copilot|call_copilot/.test(read(p)))
    // exceptions: the read-only pre-effect recheck the executor calls (it imports nothing from the module) and the PR F review surface
    expect(users.map(rel).sort()).toEqual([join("src", "lib", "approval-pre-effect.ts"), ...PR_F_REVIEW_FILES].sort())
    expect(read(join(SRC, "lib", "approval-pre-effect.ts"))).not.toMatch(/from\s+["']@\/lib\/call-copilot/)
  })

  it("the only existing-module edit is denial wording plus the pre-effect recheck in approvals.ts", () => {
    const s = read(join(SRC, "lib", "approvals.ts"))
    for (const reason of ["call_human_approval_required", "call_proposal_edited", "call_consent_unavailable", "call_evidence_changed", "call_requester_revoked", "call_definition_inactive", "call_crm_state_changed", "call_proposal_expired"]) {
      expect(s).toContain(`${reason}:`)
    }
    expect(s).toContain('import { recheckBeforeEffect } from "@/lib/approval-pre-effect"')
    expect(s).not.toMatch(/call-copilot|call_copilot/)
  })

  it("the planner stages only action types that already exist and never a send, quote or booking directly", () => {
    const planner = read(join(LIB, "planner.ts"))
    const types = new Set([...planner.matchAll(/staged\(\s*b,\s*"([a-z_]+)"/g)].map((m) => m[1]))
    expect([...types].sort()).toEqual(["book_appointment", "create_quote", "record_interaction", "resolve_customer", "send_sms", "update_customer"])
    const enumTypes = migration("_agent_record_action_types.sql") + migration("_create_quote_action_type.sql")
    for (const t of ["update_customer", "resolve_customer", "record_interaction", "create_quote"]) expect(enumTypes).toContain(`'${t}'`)
  })
})

describe("Call Copilot PR E boundary (migration)", () => {
  it("creates objects and changes exactly one existing function; alters no existing table", () => {
    const alters = [...sql.matchAll(/ALTER\s+TABLE\s+([^\s]+)/gi)].map((m) => m[1])
    expect(alters.every((t) => /^public\.%I$|^public\.call_copilot_/.test(t))).toBe(true)
    expect(sql).not.toMatch(/DROP\s+(TABLE|FUNCTION|TRIGGER|POLICY|INDEX|COLUMN|TYPE)/i)
    // outside the verbatim control_claim copy, nothing writes an existing table except staging a pending action
    const own = sql.slice(0, sql.indexOf("CREATE OR REPLACE FUNCTION public.control_claim"))
    expect(own).not.toMatch(/^\s*(UPDATE|DELETE\s+FROM)\s+public\./im)
    // staging a pending action, and ONE audit row (a denial) next to the claim's own decision
    expect([...own.matchAll(/^\s*(?:INSERT\s+INTO)\s+(public\.\w+)/gim)].map((m) => m[1]).filter((t) => !t.startsWith("public.call_copilot_"))).toEqual(["public.pending_actions", "public.control_execution_decisions"])
    const pre = sql.slice(sql.indexOf("CREATE FUNCTION public.call_copilot_pre_effect_recheck"), sql.indexOf("-- control_claim: IDENTICAL"))
    expect(pre).toMatch(/VALUES \(p_shop, p_action, last\.actor_id[\s\S]*?false, reason\)/)
    expect(pre.match(/INSERT INTO/g)).toHaveLength(1)
    const replaced = [...sql.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(public\.\w+)/gi)].map((m) => m[1])
    expect(replaced).toEqual(["public.control_claim"])
  })

  it("control_claim is IDENTICAL to the delegated-approval version except for the recheck hook", () => {
    const body = (s: string, marker: string) => {
      const start = s.indexOf(marker)
      return s.slice(start, s.indexOf("END $$;", start) + 7)
    }
    const before = body(migration("_delegated_message_approval.sql"), "CREATE FUNCTION public.control_claim(")
    const after = body(sql, "CREATE OR REPLACE FUNCTION public.control_claim(")
    const normalised = after
      .replace("CREATE OR REPLACE FUNCTION", "CREATE FUNCTION")
      .replace("; call_reason text;\nBEGIN", ";\nBEGIN")
      .replace(/ -- Call Copilot proposals only:[^\n]*\n -- and CRM identity[^\n]*\n call_reason:=public\.call_copilot_claim_recheck\(p_shop,p_action,action\.payload,p_context\);\n/, "")
      .replace("  WHEN call_reason IS NOT NULL THEN call_reason\n", "")
    expect(normalised).toBe(before)
    // and the recheck runs BEFORE the policy decision and can only deny
    expect(after.indexOf("call_copilot_claim_recheck")).toBeLessThan(after.indexOf("control_pending_mode"))
    expect(after).toMatch(/WHEN call_reason IS NOT NULL THEN call_reason\n  WHEN actor_role='manager'/)
  })

  it("transcript text and transcript conflicts are readable by NO role; every new table has RLS and no browser grant", () => {
    expect(sql).toMatch(/REVOKE ALL ON public\.%I FROM PUBLIC, anon, authenticated, service_role/)
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/)
    const grants = sql.match(/GRANT SELECT ON[\s\S]*?;/)![0]
    expect(grants).not.toMatch(/transcript_segments|transcript_conflicts/)
    expect(grants).not.toMatch(/\b(anon|authenticated)\b/)
    // the ONLY thing granted to an API session role is the read-only pre-effect recheck (caller verified inside).
    // There is no memory hand-off, no submission function and no grant that could reach the shop-wide memory store.
    const execs = [...sql.matchAll(/GRANT EXECUTE ON FUNCTION([\s\S]*?)TO (\w+(?:, \w+)*);/g)].map((m) => ({ fns: m[1], to: m[2] }))
    expect(execs.filter((e) => /authenticated|anon/.test(e.to)).map((e) => e.fns.trim().split("\n").pop())).toEqual(["public.call_copilot_pre_effect_recheck(uuid, uuid)"])
    expect(execs.find((e) => e.to === "service_role")!.fns).not.toMatch(/claim_recheck|control_claim|actor_ok|call_copilot_recheck/)
  })

  it("every proposal starts approval-required and a segment is gated before anything is stored", () => {
    expect(sql).toMatch(/initial_mode text NOT NULL DEFAULT 'approval_required' CHECK \(initial_mode = 'approval_required'\)/)
    const writer = sql.slice(sql.indexOf("CREATE FUNCTION public.call_copilot_record_segment"), sql.indexOf("CREATE FUNCTION public.call_copilot_evidence_snapshot"))
    expect(writer.indexOf("call_copilot_assert_span")).toBeGreaterThan(0)
    expect(writer.indexOf("call_copilot_assert_span")).toBeLessThan(writer.indexOf("INSERT INTO public.call_copilot_transcript_segments"))
    expect(writer.indexOf("call_copilot_assert_span")).toBeLessThan(writer.indexOf("INSERT INTO public.call_copilot_transcript_conflicts"))
  })

  it("staging inserts only ordinary pending actions with the default status (never approved/executed)", () => {
    const rec = sql.slice(sql.indexOf("CREATE FUNCTION public.call_copilot_record_extraction"), sql.indexOf("CREATE FUNCTION public.call_copilot_find_unknown_run"))
    const inserts = [...rec.matchAll(/INSERT INTO public\.pending_actions \(([^)]*)\)/g)].map((m) => m[1].replace(/\s+/g, ""))
    expect(inserts).toEqual(["id,shop_id,requested_by,action_type,payload"])
    expect(rec).not.toMatch(/status\s*=\s*'approved'|decided_at|decided_by|result_id/)
    expect(rec).not.toMatch(/INSERT INTO public\.(customers|vehicles|leads|quotes|appointments|interactions|reviewed_memory)/)
  })

  it("customer-specific memory is REVIEW-ONLY: no path from a call proposal into the shop-wide reviewed-memory store", () => {
    expect(sql).not.toMatch(/create_reviewed_memory_candidate|reviewed_memory|publish_memory_revision|review_memory_revision/)
    expect(sql).not.toMatch(/call_copilot_submit_memory_candidate|call_copilot_memory_submissions/)
    expect(sql).toMatch(/CHECK \(kind <> 'memory_candidate' OR route = 'review_only'\)/)
    expect(sql).toMatch(/Customer memory is review-only/)
    for (const p of libFiles) expect(code(p), rel(p)).not.toMatch(/reviewed_memory|create_reviewed_memory_candidate|submit_memory|submitMemory/)
  })

  it("run and proposal identity cover every execution-critical input", () => {
    const rec = sql.slice(sql.indexOf("CREATE FUNCTION public.call_copilot_record_extraction"), sql.indexOf("CREATE FUNCTION public.call_copilot_find_unknown_run"))
    const runKey = rec.slice(rec.indexOf("v_run_key := encode("), rec.indexOf("IF v_status IN ('completed', 'unknown_outcome') THEN"))
    for (const part of ["rev.evidence_digest", "extractor_id", "extractor_version", "schema_version", "crm_context_digest", "p_actor::text", "v_def_agent", "v_def_rev"]) expect(runKey).toContain(part)
    const propKey = rec.slice(rec.indexOf("v_key := encode("), rec.indexOf("SELECT id INTO v_existing"))
    for (const part of ["p ->> 'kind'", "v_route", "v_atype", "v_payload", "v_fields", "v_reason", "v_conf", "p -> 'ambiguity'", "v_cust", "v_vehicle", "v_binding", "v_def_agent", "v_def_rev", "p_actor"]) expect(propKey).toContain(part)
    // every dedupe and replay answer comes from the run's own ordered list
    expect(rec).toMatch(/call_copilot_run_proposals/)
  })

  it("the shared recheck covers payload edits, requester, consent, evidence, definition, CRM identity and expiry", () => {
    const fn = sql.slice(sql.indexOf("CREATE FUNCTION public.call_copilot_recheck"), sql.indexOf("CREATE FUNCTION public.call_copilot_claim_recheck"))
    for (const reason of ["call_proposal_edited", "call_requester_revoked", "call_consent_unavailable", "call_evidence_changed", "call_definition_inactive", "call_crm_state_changed", "call_proposal_expired"]) {
      expect(fn).toContain(`'${reason}'`)
    }
    expect(fn).toMatch(/'crm_mutation'/)
    expect(fn).toMatch(/FOR SHARE/)
  })

  it("the claim recheck is human-only and delegates to the shared recheck", () => {
    const fn = sql.slice(sql.indexOf("CREATE FUNCTION public.call_copilot_claim_recheck"), sql.indexOf("CREATE FUNCTION public.call_copilot_pre_effect_recheck"))
    expect(fn).toMatch(/p_context IS DISTINCT FROM 'hitl' THEN RETURN 'call_human_approval_required'/)
    expect(fn).toMatch(/RETURN public\.call_copilot_recheck\(p_shop, prop\.id, p_payload\)/)
  })

  it("the pre-effect recheck is bound to the claimed action, re-runs the shared recheck and verifies its caller", () => {
    const fn = sql.slice(sql.indexOf("CREATE FUNCTION public.call_copilot_pre_effect_recheck"), sql.indexOf("-- control_claim: IDENTICAL"))
    expect(fn).toMatch(/pending_action_id = p_action/)
    expect(fn).toMatch(/action\.status::text <> 'approved' OR action\.decided_by_user IS NULL THEN\s+reason := 'call_action_not_claimed'/)
    expect(fn).toMatch(/reason := public\.call_copilot_recheck\(p_shop, prop\.id, action\.payload\)/)
    expect(fn).toMatch(/auth\.role\(\) IS DISTINCT FROM 'service_role' AND NOT \(/)
    // a non-proposal answers yes (the unchanged path); a proposal answers yes only when every check holds
    expect(fn).toMatch(/'call_proposal', false/)
    expect(fn).toMatch(/IF reason IS NULL THEN RETURN jsonb_build_object\('ok', true, 'call_proposal', true\)/)
    expect(fn).not.toMatch(/UPDATE\s+public\.|DELETE\s+FROM/i)
  })
})

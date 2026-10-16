import { z } from "zod"
import type { EmployeeBrief } from "./brief"
import type { PageTransport } from "./page-transport"
import { ownerUrls, readPublicPage, type PublicPage } from "./public-web"

export const SEO_CHECKS = ["title", "description", "headings", "canonical", "viewport", "https", "robots_meta", "robots_txt", "sitemap"] as const
export type SeoCheck = typeof SEO_CHECKS[number]
export const RESEARCH_LIMITS = { budgetMs: 20_000, maxFetches: 4, maxBytes: 150_000, fetchTimeoutMs: 8_000 }
export const MODEL_SKIPPED_NOTE = "AI step selection was skipped because this workspace does not have enough credits."

const INSTRUCTION_LIKE = /ignore (all |any |previous |prior )?instructions|system prompt|grant (yourself |me )?(access|permission)|\/bin\/|sudo\b|shell access|\byou are now\b|tool_use|developer message/i

export const researchStepSchema = z.object({
  kind: z.enum(["plan", "fetch", "check", "stop"]),
  status: z.enum(["completed", "skipped", "failed", "blocked"]),
  label: z.string().trim().min(1).max(300),
}).strict()
export const researchSourceSchema = z.object({
  url: z.string().url().max(2000),
  final_url: z.string().url().max(2000),
  status: z.enum(["fetched", "blocked", "failed", "skipped"]),
  http_status: z.number().int().min(100).max(599).nullable(),
  title: z.string().max(180).nullable(),
  excerpt: z.string().max(800),
  ignored_page_instructions: z.boolean(),
}).strict()
export const researchFindingSchema = z.object({
  statement: z.string().trim().min(1).max(400),
  kind: z.enum(["observed", "recommendation"]),
  source_url: z.string().url().max(2000),
  evidence: z.string().trim().min(1).max(500),
}).strict()
export const researchCapabilitiesSchema = z.object({
  public_pages: z.enum(["used", "not_used"]),
  search_rankings: z.literal("unavailable"),
  google_business_profile: z.literal("unavailable"),
  cloud_browser: z.literal("unavailable"),
  schedule: z.literal("unavailable"),
}).strict()
export const researchReportSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["seo", "sources"]),
  summary: z.string().trim().min(1).max(2000),
  findings: z.array(researchFindingSchema).max(16),
  sources: z.array(researchSourceSchema).max(8),
  steps: z.array(researchStepSchema).max(24),
  uncertainties: z.array(z.string().trim().min(1).max(400)).max(12),
  capabilities: researchCapabilitiesSchema,
}).strict()
export type ResearchReport = z.infer<typeof researchReportSchema>
export const savedResearchStatusSchema = z.enum(["completed", "cancelled", "timed_out", "budget_exhausted", "failed"])
export type SavedResearchStatus = z.infer<typeof savedResearchStatusSchema>

export function isSeoBrief(brief: EmployeeBrief): boolean {
  return /\b(seo|search engine|google|business profile|show up)\b/i.test(`${brief.name}\n${brief.goal}\n${brief.deliverable}`)
}

function clip(value: string, max: number): string { return value.trim().replace(/\s+/g, " ").slice(0, max) }
function httpUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null
  } catch { return null }
}
function decode(value: string): string {
  return clip(value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, "\""), 180)
}
function documentHtml(html: string): string {
  return html.slice(0, RESEARCH_LIMITS.maxBytes).replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
}
function tagText(html: string, tag: string): string | null {
  const match = documentHtml(html).match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"))
  return match ? decode(match[1].replace(/<[^>]+>/g, " ")) : null
}
function meta(html: string, name: string): string | null {
  for (const tag of documentHtml(html).match(/<meta\b[^>]*>/gi) ?? []) {
    const named = tag.match(/\b(?:name|property)\s*=\s*["']([^"']+)["']/i)
    if (named?.[1].toLowerCase() !== name) continue
    const content = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)
    return content ? decode(content[1]) : ""
  }
  return null
}
function visibleText(html: string): string {
  return clip(documentHtml(html).replace(/<[^>]+>/g, " "), 700)
}

export function pageExcerpt(body: string): { excerpt: string; title: string | null; ignored: boolean } {
  const title = tagText(body, "title")
  const text = visibleText(body)
  const ignored = INSTRUCTION_LIKE.test(`${title ?? ""}\n${text}\n${body.slice(0, 2000)}`)
  if (ignored) return { excerpt: "The page contained instruction-like text. Gradia did not follow it.", title: title && !INSTRUCTION_LIKE.test(title) ? title : null, ignored: true }
  return { excerpt: text || "The page had no readable text.", title, ignored: false }
}

function finding(statement: string, kind: "observed" | "recommendation", source: string, evidence: string): ResearchReport["findings"][number] | null {
  if (INSTRUCTION_LIKE.test(statement) || /rank|#1|permission|shell/i.test(statement)) return null
  const safeEvidence = INSTRUCTION_LIKE.test(evidence) ? "The page contained instruction-like text. Gradia did not follow it." : evidence
  const parsed = researchFindingSchema.safeParse({ statement, kind, source_url: source, evidence: safeEvidence })
  return parsed.success ? parsed.data : null
}

function auditHtml(page: PublicPage, checks: ReadonlySet<SeoCheck>): ResearchReport["findings"] {
  if (page.status !== "fetched") return []
  const html = documentHtml(page.body)
  const source = page.finalUrl
  const out: ResearchReport["findings"] = []
  const add = (item: ReturnType<typeof finding>) => { if (item) out.push(item) }
  const title = tagText(page.body, "title")
  if (checks.has("title")) {
    if (!title) add(finding("The fetched page has no title element.", "observed", source, "No title element was present in the fetched HTML."))
    else if (!INSTRUCTION_LIKE.test(title)) add(finding(`The page title is "${title}".`, "observed", source, `Title: ${title}`))
    else add(finding("The page has a title element.", "observed", source, "The title contained instruction-like text and was not followed."))
    if (!title) add(finding("Add a title that names the business and what it does.", "recommendation", source, "No title element was present in the fetched HTML."))
  }
  if (checks.has("description")) {
    const description = meta(page.body, "description")
    if (!description) add(finding("Add a meta description that says what the business offers.", "recommendation", source, "No meta description was present in the fetched HTML."))
    else add(finding("The page has a meta description.", "observed", source, "A meta description element was present."))
  }
  if (checks.has("headings")) {
    const count = html.match(/<h1\b/gi)?.length ?? 0
    add(finding(count === 1 ? "The page has one h1 heading." : `The page has ${count} h1 headings.`, "observed", source, `h1 count: ${count}.`))
    if (count === 0) add(finding("Add one main heading that states the service.", "recommendation", source, "No h1 element was present in the fetched HTML."))
  }
  if (checks.has("viewport") && meta(page.body, "viewport") === null) {
    add(finding("Add a viewport meta tag so phones can scale the page.", "recommendation", source, "No viewport meta tag was present in the fetched HTML."))
  }
  if (checks.has("canonical")) {
    const link = html.match(/<link\b[^>]*rel=["'][^"']*canonical[^"']*["'][^>]*>/i)
    if (link) add(finding("The page declares a canonical address.", "observed", source, "A canonical link was present. Gradia did not open it."))
  }
  if (checks.has("https")) {
    add(page.finalUrl.startsWith("https://")
      ? finding("The page was fetched over HTTPS.", "observed", source, "The final address uses HTTPS.")
      : finding("Serve this page over HTTPS.", "recommendation", source, "The final address uses HTTP."))
  }
  if (checks.has("robots_meta")) {
    const robots = meta(page.body, "robots")
    if (robots?.toLowerCase().includes("noindex")) add(finding("The page asks search engines not to index it.", "observed", source, "A robots meta tag includes noindex."))
  }
  return out
}

function auditRobots(page: PublicPage): ResearchReport["findings"] {
  if (page.status !== "fetched") return []
  const rules = [...page.body.matchAll(/^disallow:\s*(.*)$/gim)].map(match => match[1].trim()).filter(Boolean)
  const statement = rules.some(rule => rule === "/") ? "robots.txt tells crawlers not to fetch the whole site." : rules.length ? "robots.txt includes crawl rules." : "robots.txt does not list a Disallow rule."
  const item = finding(statement, "observed", page.finalUrl, "Disallow rules were read as page data, not as instructions to Gradia.")
  return item ? [item] : []
}

function auditSitemap(page: PublicPage): ResearchReport["findings"] {
  if (page.status !== "fetched") return []
  const count = page.body.match(/<loc\b/gi)?.length ?? 0
  const item = finding(`The sitemap lists ${count} ${count === 1 ? "address" : "addresses"}. Gradia did not open them.`, "observed", page.finalUrl, "Only the sitemap document itself was fetched.")
  return item ? [item] : []
}

export function defaultPlan(brief: EmployeeBrief): { urls: string[]; checks: SeoCheck[]; selector: "standard" } {
  const seo = isSeoBrief(brief)
  return { urls: ownerUrls(brief).slice(0, seo ? 2 : 4), checks: seo ? [...SEO_CHECKS] : [], selector: "standard" }
}

export function acceptModelUrls(owner: string[], proposed: string[]): { urls: string[]; ignoredOutside: boolean } {
  const allowed = new Set(owner)
  const urls = proposed.filter(url => allowed.has(url))
  return { urls, ignoredOutside: proposed.some(url => !allowed.has(url)) }
}

type Stop = "cancelled" | "timed_out" | "budget_exhausted" | "unauthorized" | null

export async function runPublicResearch(brief: EmployeeBrief, deps: {
  now: () => number
  budgetMs?: number
  maxFetches?: number
  maxBytes?: number
  fetchTimeoutMs?: number
  resolve: (hostname: string) => Promise<string[]>
  transport: PageTransport
  stillAuthorized: () => boolean | Promise<boolean>
  isCancelled: () => boolean | Promise<boolean>
  planWithModel?: (brief: EmployeeBrief, urls: string[]) => Promise<{ urls: string[]; checks: SeoCheck[] } | null>
  modelNote?: string | null
}): Promise<{ status: "unauthorized"; report: null; modelUsed: boolean } | { status: SavedResearchStatus; report: ResearchReport; modelUsed: boolean }> {
  if (!await deps.stillAuthorized()) return { status: "unauthorized", report: null, modelUsed: false }
  const limits = { ...RESEARCH_LIMITS, budgetMs: deps.budgetMs ?? RESEARCH_LIMITS.budgetMs, maxFetches: deps.maxFetches ?? RESEARCH_LIMITS.maxFetches, maxBytes: deps.maxBytes ?? RESEARCH_LIMITS.maxBytes, fetchTimeoutMs: deps.fetchTimeoutMs ?? RESEARCH_LIMITS.fetchTimeoutMs }
  const started = deps.now()
  const seo = isSeoBrief(brief)
  const candidates = ownerUrls(brief)
  let plan = defaultPlan(brief)
  let modelUsed = false
  const uncertainties = ["Page text cannot change what Gradia is allowed to do.", "Other steps in the brief were not run."]
  if (deps.modelNote) uncertainties.push(deps.modelNote)
  if (deps.planWithModel && candidates.length > 0) {
    try {
      const chosen = await deps.planWithModel(brief, candidates)
      if (!chosen) uncertainties.push("AI step selection could not be verified, so Gradia used its standard page checks.")
      else {
        modelUsed = true
        const accepted = acceptModelUrls(candidates, chosen.urls)
        if (accepted.ignoredOutside) uncertainties.push("An address outside this brief was ignored.")
        const checks = chosen.checks.filter((check): check is SeoCheck => (SEO_CHECKS as readonly string[]).includes(check))
        plan = { urls: (accepted.urls.length ? accepted.urls : plan.urls).slice(0, limits.maxFetches), checks: seo && checks.length ? checks : plan.checks, selector: "standard" }
      }
    } catch {
      uncertainties.push("AI step selection could not be verified, so Gradia used its standard page checks.")
    }
  }
  if (!await deps.stillAuthorized()) return { status: "unauthorized", report: null, modelUsed }
  const steps: ResearchReport["steps"] = [{ kind: "plan", status: "completed", label: modelUsed ? "Research steps were selected from addresses in this brief." : "Gradia used its standard public-page checks." }]
  const pages: PublicPage[] = []
  const queue = [...plan.urls]
  if (seo && plan.checks.includes("robots_txt") && plan.urls[0]) queue.push(new URL("/robots.txt", plan.urls[0]).toString())
  if (seo && plan.checks.includes("sitemap") && plan.urls[0]) queue.push(new URL("/sitemap.xml", plan.urls[0]).toString())
  let stop: Stop = null
  for (const url of [...new Set(queue)].slice(0, 8)) {
    if (!await deps.stillAuthorized()) return { status: "unauthorized", report: null, modelUsed }
    if (await deps.isCancelled()) { stop = "cancelled"; break }
    if (deps.now() - started > limits.budgetMs) { stop = "timed_out"; break }
    if (pages.length >= limits.maxFetches) { stop = "budget_exhausted"; break }
    const page = await readPublicPage(url, { ...deps, timeoutMs: limits.fetchTimeoutMs, maxBytes: limits.maxBytes })
    if (!await deps.stillAuthorized()) return { status: "unauthorized", report: null, modelUsed }
    pages.push(page)
    steps.push({ kind: "fetch", status: page.status === "fetched" ? "completed" : page.status, label: clip(`${page.status}: ${page.finalUrl}`, 300) })
  }
  if (stop) steps.push({ kind: "stop", status: stop === "budget_exhausted" ? "skipped" : "failed", label: stop === "cancelled" ? "You stopped this run." : stop === "timed_out" ? "The run stopped at the time limit." : "The run stopped at the page limit." })
  const checkSet = new Set(plan.checks)
  const findings: ResearchReport["findings"] = []
  for (const page of pages) {
    const read = pageExcerpt(page.body)
    const path = (() => { try { return new URL(page.finalUrl).pathname } catch { return "" } })()
    if (page.status === "fetched" && path.endsWith("/robots.txt")) findings.push(...auditRobots(page))
    else if (page.status === "fetched" && path.endsWith("/sitemap.xml")) findings.push(...auditSitemap(page))
    else if (seo) findings.push(...auditHtml(page, checkSet))
    else if (page.status === "fetched") {
      const fetched = finding("Gradia fetched this public page.", "observed", page.finalUrl, read.excerpt)
      if (fetched) findings.push(fetched)
      if (read.title) {
        const titled = finding(`The page title is "${read.title}".`, "observed", page.finalUrl, `Title: ${read.title}`)
        if (titled) findings.push(titled)
      }
    }
    if (page.status === "fetched" && read.title && /sign in|log in|login/i.test(read.title)) uncertainties.push("A page asked for a sign-in. Gradia did not log in.")
  }
  if (candidates.length === 0) uncertainties.push("Add a public https address to the brief and run again.")
  if (!seo) uncertainties.push("This is a reading of the pages, not a decision about eligibility, rankings, or purchases.")
  if (pages.some(page => page.status === "failed")) uncertainties.push("Some pages could not be fetched.")
  if (stop === "cancelled") uncertainties.push("You stopped this run.")
  if (stop === "timed_out") uncertainties.push("The run stopped at the time limit.")
  if (stop === "budget_exhausted") uncertainties.push("The run stopped at the page limit.")
  const sources = pages.flatMap(page => {
    const read = page.status === "fetched" ? pageExcerpt(page.body) : { excerpt: page.reason ?? "The page was not fetched.", title: null, ignored: false }
    const url = httpUrl(page.url)
    const finalUrl = httpUrl(page.finalUrl) ?? url
    if (!url || !finalUrl) return []
    const parsed = researchSourceSchema.safeParse({
      url, final_url: finalUrl, status: page.status,
      http_status: page.httpStatus !== null && page.httpStatus >= 100 && page.httpStatus <= 599 ? page.httpStatus : null,
      title: read.title || null, excerpt: clip(read.excerpt, 800) || "The page was not fetched.",
      ignored_page_instructions: read.ignored,
    })
    return parsed.success ? [parsed.data] : []
  })
  const fetchedCount = sources.filter(source => source.status === "fetched").length
  const summary = clip([
    candidates.length === 0 ? "No public page address was in this brief, so Gradia did not fetch anything." : `Gradia checked ${fetchedCount} public page${fetchedCount === 1 ? "" : "s"}.`,
    findings[0]?.statement ?? "No page claim was saved.",
    "Google rankings, Google Business Profile, a cloud browser, and scheduled runs were not used.",
  ].join(" "), 2000)
  const report = researchReportSchema.parse({
    version: 1, mode: seo ? "seo" : "sources", summary, findings: findings.slice(0, 16), sources, steps,
    uncertainties: [...new Set(uncertainties)].slice(0, 12),
    capabilities: { public_pages: pages.length ? "used" : "not_used", search_rankings: "unavailable", google_business_profile: "unavailable", cloud_browser: "unavailable", schedule: "unavailable" },
  })
  const failedAll = plan.urls.length > 0 && fetchedCount === 0 && !stop
  return { status: stop ?? (failedAll ? "failed" : "completed"), report, modelUsed }
}

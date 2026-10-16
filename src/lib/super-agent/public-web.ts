import type { PageTransport, PageTransportResult } from "./page-transport"
import { isBlockedHostname, isBlockedIp, parsePublicUrl } from "./public-href"

export { extractUrls, isBlockedHostname, isBlockedIp, ownerUrls, parsePublicUrl, safePublicHref } from "./public-href"

export type PublicPage = {
  url: string
  finalUrl: string
  status: "fetched" | "blocked" | "failed" | "skipped"
  httpStatus: number | null
  body: string
  reason: string | null
}

const READABLE = new Set(["text/html", "application/xhtml+xml", "text/plain", "text/xml", "application/xml"])

function blocked(url: string, finalUrl = url): PublicPage {
  return { url, finalUrl, status: "blocked", httpStatus: null, body: "", reason: "That address is not a public web page." }
}

async function allowedAddress(url: URL, resolve: (hostname: string) => Promise<string[]>): Promise<string | null> {
  if (isBlockedHostname(url.hostname)) return null
  if (url.hostname.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) return url.hostname
  let addresses: string[]
  try { addresses = await resolve(url.hostname) }
  catch { return null }
  if (addresses.length === 0 || addresses.some(isBlockedIp)) return null
  return addresses[0]
}

/**
 * Fetch one public page, pinned to addresses that were checked immediately
 * beforehand. Redirects are followed only through the same check. Page text
 * is data: this function never evaluates it.
 */
export async function readPublicPage(raw: string, deps: {
  resolve: (hostname: string) => Promise<string[]>
  transport: PageTransport
  timeoutMs: number
  maxBytes: number
  maxRedirects?: number
}): Promise<PublicPage> {
  let current = parsePublicUrl(raw)
  if (!current) return blocked(raw)
  const start = current.toString()
  const seen = new Set<string>()
  for (let hop = 0; hop <= (deps.maxRedirects ?? 2); hop++) {
    const key = current.toString()
    if (seen.has(key)) return blocked(start, key)
    seen.add(key)
    const ip = await allowedAddress(current, deps.resolve)
    if (!ip) return blocked(start, key)
    let result: PageTransportResult
    try {
      result = await deps.transport({ url: key, ip, hostname: current.hostname, timeoutMs: deps.timeoutMs, maxBytes: deps.maxBytes })
    } catch { return { url: start, finalUrl: key, status: "failed", httpStatus: null, body: "", reason: "The page could not be fetched." } }
    if (!result.ok) {
      const reason = result.reason === "too_large" ? "The page was too large to check."
        : result.reason === "timeout" ? "The page took too long to respond." : "The page could not be fetched."
      return { url: start, finalUrl: key, status: "failed", httpStatus: null, body: "", reason }
    }
    if (result.status >= 300 && result.status < 400) {
      if (!result.location || hop === (deps.maxRedirects ?? 2)) {
        return { url: start, finalUrl: key, status: "failed", httpStatus: result.status, body: "", reason: "The page redirected somewhere Gradia did not follow." }
      }
      const next = parsePublicUrl(new URL(result.location, key).toString())
      if (!next || isBlockedHostname(next.hostname)) return blocked(start, next?.toString() ?? key)
      if (next.hostname !== new URL(start).hostname) {
        return { url: start, finalUrl: key, status: "failed", httpStatus: result.status, body: "", reason: "The page redirected to a different address. Gradia did not follow it." }
      }
      current = next
      continue
    }
    if (result.status < 200 || result.status >= 400) {
      return { url: start, finalUrl: key, status: "failed", httpStatus: result.status, body: "", reason: "The page did not return readable content." }
    }
    const type = result.contentType?.split(";")[0]?.trim().toLowerCase() ?? ""
    if (type && !READABLE.has(type)) {
      return { url: start, finalUrl: key, status: "skipped", httpStatus: result.status, body: "", reason: "The page was not a text document." }
    }
    return { url: start, finalUrl: key, status: "fetched", httpStatus: result.status, body: result.body, reason: null }
  }
  return blocked(start)
}

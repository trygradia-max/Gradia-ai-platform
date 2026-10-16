import type { EmployeeBrief } from "./brief"

const V4_NETS: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
  [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
  [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24],
  [0xe0000000, 4], [0xf0000000, 4],
]
const BLOCKED_HOST = /(^|\.)(localhost|local|localdomain|internal|invalid|lan|home|arpa|onion)$/i

function ipv4(address: string): number | null {
  const parts = address.split(".")
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255 || (part.length > 1 && part.startsWith("0")))) return null
  return parts.reduce((total, part) => total * 256 + Number(part), 0)
}

function blockedV4(address: string): boolean {
  const value = ipv4(address)
  if (value === null) return true
  return V4_NETS.some(([base, bits]) => Math.floor(value / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)))
}

function expandV6(address: string): number[] | null {
  const halves = address.split("::")
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(":") : []
  const tail = halves[1] ? halves[1].split(":") : []
  if (halves.length === 1 && head.length !== 8) return null
  const missing = 8 - head.length - tail.length
  if (missing < 0) return null
  const parts = halves.length === 2 ? [...head, ...Array(missing).fill("0"), ...tail] : head
  if (parts.length !== 8 || parts.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null
  return parts.map(part => Number.parseInt(part, 16))
}

/** True when an address must never be fetched. Unknown and unparsable addresses are blocked. */
export function isBlockedIp(address: string): boolean {
  const normalized = address.toLowerCase()
  if (normalized.startsWith("::ffff:") && normalized.includes(".")) return blockedV4(normalized.slice("::ffff:".length))
  if (normalized.includes(".")) return blockedV4(normalized)
  const groups = expandV6(normalized)
  if (!groups) return true
  const [first, second] = groups
  if (groups.every(group => group === 0) || (groups.slice(0, 7).every(group => group === 0) && groups[7] === 1)) return true
  if (first >= 0xfc00 && first <= 0xfdff) return true
  if (first >= 0xfe80 && first <= 0xfeff) return true
  if (first >= 0xff00) return true
  if (first === 0x2001 && second === 0x0db8) return true
  return false
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.replace(/\.+$/, "").trim().toLowerCase()
  if (!host || host.length > 253 || host.includes("%") || host.includes("0x")) return true
  if (BLOCKED_HOST.test(host) || host === "metadata" || host.endsWith(".localhost")) return true
  if (/^\d+$/.test(host)) return true
  if (host.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return isBlockedIp(host)
  if (!host.includes(".")) return true
  return false
}

export function parsePublicUrl(raw: string): URL | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    if (url.username || url.password || url.hostname === "") return null
    if (url.port && url.port !== "80" && url.port !== "443") return null
    return url
  } catch { return null }
}

/** A link is safe to show only when it is still a public http(s) URL. */
export function safePublicHref(raw: string): string | null {
  const url = parsePublicUrl(raw)
  if (!url || isBlockedHostname(url.hostname)) return null
  return url.toString()
}

export function extractUrls(...parts: string[]): string[] {
  const found: string[] = []
  for (const part of parts) {
    for (const match of part.match(/https?:\/\/[^\s<>"'`]+/gi) ?? []) {
      const url = parsePublicUrl(match.replace(/[),.;]+$/g, ""))
      if (url) found.push(url.toString())
    }
  }
  return [...new Set(found)].slice(0, 8)
}

export function ownerUrls(brief: EmployeeBrief): string[] {
  return extractUrls(brief.goal, brief.business_context, brief.deliverable, ...brief.steps)
}

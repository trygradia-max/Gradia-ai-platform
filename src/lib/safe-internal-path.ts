/**
 * Strict same-origin path validation for post-OAuth landing destinations.
 *
 * A `next` value ends up in a cookie, comes back on a later request, and is
 * finally used as a navigation target. Treat it as hostile at every hop.
 * This is an allowlist, not a blocklist: anything that is not an ordinary
 * app-relative path (`/foo`, `/foo?bar=1#baz`) is rejected and the caller
 * falls back to its safe default.
 *
 * Rejected, among others:
 *   - absolute URLs and any scheme (`https://evil`, `javascript:`)
 *   - protocol-relative URLs (`//evil`) and their backslash forms (`/\evil`,
 *     `\\evil`), which browsers normalise to `//`
 *   - angle brackets, quotes, backticks, backslashes, whitespace and control
 *     characters, raw or percent-encoded (including double/triple encoding)
 *   - malformed percent-encoding
 *   - oversized values
 */

export const MAX_INTERNAL_PATH_LENGTH = 512

/** Characters allowed in the raw value. `%` is allowed only as an escape. */
const RAW_ALLOWED = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@/?#%]*$/

/** Characters that must never appear once the value is percent-decoded. */
const DECODED_FORBIDDEN = /[\\<>"'`{}|^\u0000-\u001f\u007f-\u009f\u2028\u2029]/

const MAX_DECODE_PASSES = 3
const PLACEHOLDER_ORIGIN = "https://gradia.invalid"

/** True when `value` is a path that would be rejected as a navigation target. */
function startsAuthorityLike(value: string): boolean {
  return /^\/[/\\]/.test(value)
}

/** `.` / `..` path segments: no legitimate landing path needs them. */
function hasDotSegment(value: string): boolean {
  const pathOnly = value.split(/[?#]/, 1)[0]
  return pathOnly.split("/").some(segment => segment === "." || segment === "..")
}

/**
 * Returns `raw` unchanged when it is a safe same-origin path, else `null`.
 * Never normalises or rewrites: what the caller stores is exactly what was
 * validated.
 */
export function safeInternalPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  if (raw.length === 0 || raw.length > MAX_INTERNAL_PATH_LENGTH) return null
  if (!RAW_ALLOWED.test(raw)) return null
  if (startsAuthorityLike(raw) || hasDotSegment(raw)) return null

  // Every decoded form must also be clean, so `%5C`, `%2F%2F`, `%3C`, and
  // double-encoded variants (`%255C`) cannot be smuggled past a later decode.
  let current = raw
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
    let decoded: string
    try {
      decoded = decodeURIComponent(current)
    } catch {
      return null
    }
    if (DECODED_FORBIDDEN.test(decoded)) return null
    if (startsAuthorityLike(decoded) || hasDotSegment(decoded)) return null
    if (decoded === current) break
    current = decoded
  }
  // Still changing after the last pass: deeper encoding than we accept.
  if (current !== raw) {
    try {
      if (decodeURIComponent(current) !== current) return null
    } catch {
      return null
    }
  }

  // Final structural check with the platform URL parser: must stay on-origin.
  try {
    const parsed = new URL(raw, PLACEHOLDER_ORIGIN)
    if (parsed.origin !== PLACEHOLDER_ORIGIN) return null
  } catch {
    return null
  }

  return raw
}

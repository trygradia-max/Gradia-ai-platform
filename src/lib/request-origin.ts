/**
 * Origin resolution for browser-interactive OAuth "Connect" round trips
 * (Aurinko, Jobber). These flows send the browser away (to Google, to
 * Jobber) and must land it back on the exact host it started from.
 *
 * B-00 (2026-09-03): the Aurinko and Jobber "start" routes previously read
 * `GRADIA_DASHBOARD_URL` *before* the incoming request's own host, so
 * starting a Connect flow from a Vercel Preview deployment sent the
 * browser to production once the OAuth round trip finished — the request
 * simply carried a production `redirect_uri`/`returnUrl` the whole way.
 * That made §6's Preview-acceptance rule unenforceable: nothing that
 * touched a login/connect flow could actually be verified on a Preview.
 *
 * Priority, in order:
 *   1. the incoming request's own host (`x-forwarded-host` / `host`) —
 *      correct on localhost, every Preview, and production alike.
 *   2. `VERCEL_URL` (set automatically by Vercel, no scheme) — a fallback
 *      for the rare case a request arrives with no host header at all.
 *   3. the configured `GRADIA_DASHBOARD_URL` — last resort only.
 *   4. `http://localhost:3000`.
 *
 * This is deliberately narrow: it is for the page the *browser* lands on,
 * not for durable server-to-server callback targets (Twilio status
 * webhooks, Aurinko email-notification subscriptions, quote links texted
 * to a customer). Those must keep preferring the stable configured URL —
 * a Preview deployment disappears; a webhook subscription or a link a
 * customer clicks later must not point at one.
 */
export function resolveInteractiveOrigin(request: Request): string {
  const fromRequest = originFromHeaders(request.headers)
  if (fromRequest) return fromRequest

  const vercelUrl = process.env.VERCEL_URL?.trim()
  if (vercelUrl) {
    try {
      return new URL(
        vercelUrl.startsWith("http") ? vercelUrl : `https://${vercelUrl}`
      ).origin
    } catch {
      // fall through
    }
  }

  const configured = process.env.GRADIA_DASHBOARD_URL?.trim()
  if (configured) {
    try {
      return new URL(configured).origin
    } catch {
      // fall through
    }
  }

  return "http://localhost:3000"
}

function originFromHeaders(headers: Headers): string | null {
  const host = headers.get("x-forwarded-host") ?? headers.get("host")
  if (!host) return null
  const proto =
    headers.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https")
  return `${proto}://${host}`
}

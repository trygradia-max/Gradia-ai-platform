import http from "node:http"
import https from "node:https"

export type PageTransportRequest = {
  url: string
  ip: string
  hostname: string
  timeoutMs: number
  maxBytes: number
}

export type PageTransportResult =
  | { ok: true; status: number; location: string | null; contentType: string | null; body: string }
  | { ok: false; reason: "timeout" | "too_large" | "failed" }

export type PageTransport = (request: PageTransportRequest) => Promise<PageTransportResult>

/** HTTP GET pinned to a previously checked address. No cookies, credentials, or automatic redirects. */
export function nodePageTransport(request: PageTransportRequest): Promise<PageTransportResult> {
  const target = new URL(request.url)
  const lib = target.protocol === "https:" ? https : http
  return new Promise(resolve => {
    let settled = false
    const finish = (result: PageTransportResult) => { if (!settled) { settled = true; resolve(result) } }
    const req = lib.request({
      host: request.ip,
      servername: request.hostname,
      port: target.port ? Number(target.port) : target.protocol === "https:" ? 443 : 80,
      method: "GET",
      path: `${target.pathname}${target.search}`,
      headers: {
        Host: target.host,
        Accept: "text/html,application/xhtml+xml,text/plain,text/xml,application/xml;q=0.9",
        "User-Agent": "GradiaResearch/1.0",
      },
      timeout: request.timeoutMs,
      rejectUnauthorized: true,
    }, res => {
      const locationHeader = res.headers.location
      const location = Array.isArray(locationHeader) ? locationHeader[0] ?? null : locationHeader ?? null
      const contentType = typeof res.headers["content-type"] === "string" ? res.headers["content-type"] : null
      const status = res.statusCode ?? 0
      if ((status >= 300 && status < 400) || status < 200 || status >= 400) {
        res.resume()
        finish({ ok: true, status, location, contentType, body: "" })
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on("data", (chunk: Buffer) => {
        size += chunk.length
        if (size > request.maxBytes) { req.destroy(); finish({ ok: false, reason: "too_large" }) }
        else chunks.push(chunk)
      })
      res.on("end", () => finish({ ok: true, status, location: null, contentType, body: Buffer.concat(chunks).toString("utf8") }))
      res.on("error", () => finish({ ok: false, reason: "failed" }))
    })
    req.on("timeout", () => { req.destroy(); finish({ ok: false, reason: "timeout" }) })
    req.on("error", () => finish({ ok: false, reason: "failed" }))
    req.end()
  })
}

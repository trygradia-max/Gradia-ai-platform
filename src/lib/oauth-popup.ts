import { randomBytes } from "node:crypto"

import { safeInternalPath } from "@/lib/safe-internal-path"

const FALLBACK_PATH = "/settings"

/**
 * JSON.stringify output that is safe inside an inline <script>. JSON alone is
 * not enough: `</script>` ends the script element, `<!--` can switch the
 * parser state, and U+2028/U+2029 were line terminators in older JS. Escaping
 * `<`, `>`, `&` and the two separators as \uXXXX keeps the value identical
 * when parsed while removing every character the HTML parser cares about.
 */
export function jsonForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}

/**
 * Terminal response for an OAuth callback that may have been opened either in a
 * Connect-tile popup or as a full-page redirect. The returned page decides at
 * runtime: if it has a window.opener (it's a popup), it postMessages the result
 * to the opener and closes itself; otherwise it navigates to `path`. One
 * response handles both flows, so callbacks don't need to thread a popup flag.
 *
 * The opener (ConnectionTile) listens for { source: "gradia-oauth" } messages
 * from the same origin and refreshes.
 *
 * `path` is revalidated here as the last line of defence: anything that is not
 * a plain same-origin path falls back to /settings. The value is embedded with
 * `jsonForInlineScript`, and the page carries a nonce-only script CSP so an
 * injected element could not execute even if one slipped through.
 */
export function finishOauth(path: string): Response {
  const safe = jsonForInlineScript(safeInternalPath(path) ?? FALLBACK_PATH)
  const nonce = randomBytes(16).toString("base64")
  // Documented hex exception: this is a standalone popup document — the
  // app's CSS variables don't exist here. Values approximate the dark
  // theme (canvas / secondary text) for the split-second it's visible.
  const html =
    "<!doctype html><meta charset=utf-8><title>Connecting…</title>" +
    '<body style="font:14px system-ui,sans-serif;color:#9aa;background:#0c0d10;' +
    'display:grid;place-items:center;height:100vh;margin:0">Finishing up…' +
    `<script nonce="${nonce}">(function(){try{` +
    "if(window.opener&&window.opener!==window){" +
    "window.opener.postMessage({source:'gradia-oauth',path:" +
    safe +
    "},window.location.origin);window.close();return;}" +
    "}catch(e){}window.location.replace(" +
    safe +
    ");})();</script></body>"
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        `default-src 'none'; script-src 'nonce-${nonce}'; ` +
        "style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    },
  })
}

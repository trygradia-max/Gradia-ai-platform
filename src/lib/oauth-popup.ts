/**
 * Terminal response for an OAuth callback that may have been opened either in a
 * Connect-tile popup or as a full-page redirect. The returned page decides at
 * runtime: if it has a window.opener (it's a popup), it postMessages the result
 * to the opener and closes itself; otherwise it navigates to `path`. One
 * response handles both flows, so callbacks don't need to thread a popup flag.
 *
 * The opener (ConnectionTile) listens for { source: "gradia-oauth" } messages
 * from the same origin and refreshes.
 */
export function finishOauth(path: string): Response {
  const safe = JSON.stringify(path.startsWith("/") ? path : "/settings")
  const html =
    "<!doctype html><meta charset=utf-8><title>Connecting…</title>" +
    '<body style="font:14px system-ui,sans-serif;color:#9aa;background:#0c0d10;' +
    'display:grid;place-items:center;height:100vh;margin:0">Finishing up…' +
    "<script>(function(){try{" +
    "if(window.opener&&window.opener!==window){" +
    "window.opener.postMessage({source:'gradia-oauth',path:" +
    safe +
    "},window.location.origin);window.close();return;}" +
    "}catch(e){}window.location.replace(" +
    safe +
    ");})();</script></body>"
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  })
}

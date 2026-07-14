"use client"

/**
 * Last-resort boundary — fires only when the ROOT layout itself throws, so
 * it must render its own <html>/<body> and cannot rely on globals.css.
 * Styles are inline for that reason. Reports to Sentry like error.tsx.
 */

import { useEffect } from "react"
import * as Sentry from "@sentry/nextjs"

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string }
}) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0a0a0b",
          color: "#fafafa",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
        }}
      >
        <div style={{ maxWidth: 420, padding: 24, textAlign: "center" }}>
          <p style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.01em" }}>
            Gradia hit an error on our side.
          </p>
          <p style={{ marginTop: 8, fontSize: 14, color: "#a1a1aa" }}>
            The error has been reported. Reload to keep working.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: 16,
              padding: "8px 16px",
              borderRadius: 6,
              border: "1px solid #3f3f46",
              background: "#18181b",
              color: "#fafafa",
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  )
}

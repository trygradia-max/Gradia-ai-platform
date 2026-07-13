import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"

import "./globals.css"

import { Providers } from "@/components/providers"

// One UI family (§8-A2): Geist for everything, Geist Mono for data
// numbers. Instrument Serif is retired app-wide — do not re-add it,
// and do not introduce any other font.
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: {
    default: "Gradia — AI operations for detailers",
    template: "%s · Gradia",
  },
  description:
    "The AI office that catches every lead while you're under a car.",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full scroll-smooth antialiased`}
      suppressHydrationWarning
    >
      {/* GrainOverlay moved out of the root: the cinematic layer is
          public-pages-only (§8-A1) — each public page mounts its own. */}
      <body className="min-h-full bg-background font-sans text-foreground flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}

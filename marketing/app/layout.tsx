import type { Metadata } from "next"
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google"

import "./globals.css"

import { SITE } from "@/lib/site"
import { SmoothScroll } from "@/components/smooth-scroll"
import { CustomCursor } from "@/components/custom-cursor"
import { LoadingScreen } from "@/components/loading-screen"
import { SiteNav } from "@/components/site-nav"
import { SiteFooter } from "@/components/site-footer"
import { PageTransition } from "@/components/page-transition"

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] })
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] })
const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
})

export const metadata: Metadata = {
  metadataBase: new URL("https://trygradia.com"),
  title: {
    default: "Gradia — The AI office for auto detailers",
    template: "%s · Gradia",
  },
  description: SITE.description,
  openGraph: {
    title: "Gradia — The AI office for auto detailers",
    description: SITE.description,
    type: "website",
    siteName: "Gradia",
  },
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-screen bg-background font-sans text-foreground">
        <LoadingScreen />
        <CustomCursor />
        <SmoothScroll>
          <SiteNav />
          <PageTransition>
            <main>{children}</main>
          </PageTransition>
          <SiteFooter />
        </SmoothScroll>
      </body>
    </html>
  )
}

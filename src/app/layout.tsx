import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"

import "./globals.css"

import { Providers } from "@/components/providers"

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
    "High-contrast, multi-tenant workspace for modern auto detailing teams.",
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
      <body className="min-h-full bg-background font-sans text-foreground flex flex-col transition-colors duration-300">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}

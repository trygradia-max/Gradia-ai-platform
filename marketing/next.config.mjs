import createMDX from "@next/mdx"

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Let .mdx files act as pages/imports alongside the usual extensions.
  pageExtensions: ["ts", "tsx", "md", "mdx"],
  // Pin the workspace root to /marketing. The parent Gradia app has its own
  // lockfile one level up; without this, Turbopack infers that directory as
  // the root and tries to compile the product app's files. This keeps the
  // marketing build fully isolated.
  turbopack: {
    root: import.meta.dirname,
  },
}

const withMDX = createMDX({
  extension: /\.mdx?$/,
})

export default withMDX(nextConfig)

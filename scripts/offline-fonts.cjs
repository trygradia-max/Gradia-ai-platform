// Build-only fixture: use the matching Geist binaries already bundled with Next.
// No production font configuration or source asset changes.
const path = process.getBuiltinModule("node:path")
module.exports = new Proxy({}, { get(_target, url) {
  if (typeof url !== "string" || !url.startsWith("https://fonts.googleapis.com/css2?family=Geist")) throw new Error("Unexpected font request")
  const mono = url.includes("Geist+Mono")
  const file = path.resolve(__dirname, "../node_modules/next/dist/next-devtools/server/font", mono ? "geist-mono-latin.woff2" : "geist-latin.woff2")
  return `/* latin */\n@font-face { font-family: '${mono ? "Geist Mono" : "Geist"}'; font-style: normal; font-weight: 100 900; font-display: swap; src: url(${file}) format('woff2'); }`
} })

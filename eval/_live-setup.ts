// Never executed by unit/integration verification. Credentials must be supplied
// explicitly by a separately authorized live-evaluation runner; no .env loading.
if (process.env.GRADIA_ALLOW_LIVE_EVAL !== "1" || process.env.EVAL_LIVE !== "1") {
  throw new Error("Live evaluations require separate explicit authorization")
}

import type { Metadata } from "next"

import {
  DocHeader,
  DocProse,
  Callout,
  DocPager,
} from "@/components/docs/doc-shell"

export const metadata: Metadata = {
  title: "Heat Score — Docs",
  description:
    "An honest, transparent lead-scoring heuristic — not black-box ML. The five signals that decide whether a lead is hot, warm, or cold.",
}

const SIGNALS: { signal: string; detail: string; max: string }[] = [
  {
    signal: "Lead age",
    detail: "Fresher leads run hotter. ≤2 days scores highest, fading by two weeks.",
    max: "+30",
  },
  {
    signal: "Lead status",
    detail: "Booked beats quoted beats new. The further along, the warmer.",
    max: "+40",
  },
  {
    signal: "Recent activity",
    detail: "Touchpoints in the last 7 days — more back-and-forth, more heat.",
    max: "+30",
  },
  {
    signal: "Inbound response",
    detail: "Has this customer ever replied to you? A live thread matters.",
    max: "+15",
  },
  {
    signal: "Repeat customer",
    detail: "Any paid invoice on record. People who've paid before pay again.",
    max: "+15",
  },
]

const BUCKETS: { label: string; range: string; tone: string }[] = [
  { label: "Hot 🔥", range: "75–100", tone: "text-primary" },
  { label: "Warm", range: "40–74", tone: "text-amber-400" },
  { label: "Cold", range: "0–39", tone: "text-muted-foreground" },
]

export default function HeatScoreDoc() {
  return (
    <>
      <DocHeader
        eyebrow="Going further"
        title="Heat Score"
        intro="A transparent heuristic for which leads to chase first — built to be explained, not to impress. No black-box model claiming to read the future."
      />

      <DocProse>
        <h2>Why a heuristic, not ML</h2>
        <p>
          At pilot scale there isn&apos;t enough labeled data to train a
          conversion model that&apos;s actually credible. So Heat Score is an{" "}
          <strong>additive, deterministic heuristic</strong> — every point on
          the score traces back to a reason you can see. The framing is honest:{" "}
          <em>&ldquo;based on what we&apos;ve seen,&rdquo;</em> not a fake
          probability.
        </p>

        <h2>The five signals</h2>
      </DocProse>

      <div className="my-7 overflow-hidden rounded-2xl border border-border/60">
        <table className="w-full text-left text-sm">
          <thead className="bg-card/60">
            <tr className="border-b border-border/60">
              <th className="px-4 py-3 font-medium text-foreground">Signal</th>
              <th className="px-4 py-3 font-medium text-foreground">What it reads</th>
              <th className="px-4 py-3 text-right font-medium text-foreground">
                Max
              </th>
            </tr>
          </thead>
          <tbody>
            {SIGNALS.map((s) => (
              <tr
                key={s.signal}
                className="border-b border-border/40 last:border-0"
              >
                <td className="px-4 py-3 font-medium text-foreground/90">
                  {s.signal}
                </td>
                <td className="px-4 py-3 text-muted-foreground">{s.detail}</td>
                <td className="px-4 py-3 text-right font-mono text-primary">
                  {s.max}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <DocProse>
        <p>
          The signals add up, clamp to a 0–100 range, and bucket into three
          honest labels:
        </p>
      </DocProse>

      <div className="my-6 grid gap-3 sm:grid-cols-3">
        {BUCKETS.map((b) => (
          <div
            key={b.label}
            className="rounded-2xl border border-border/60 bg-card/40 p-5 text-center"
          >
            <p className={`font-display text-2xl ${b.tone}`}>{b.label}</p>
            <p className="mt-1 font-mono text-sm text-muted-foreground">
              {b.range}
            </p>
          </div>
        ))}
      </div>

      <DocProse>
        <Callout title="Designed to be replaced">
          The score returns a stable shape — value, label, and the per-signal
          breakdown. When there&apos;s enough data to train something better, we
          can swap the engine without changing a thing on your end.
        </Callout>

        <p>
          The point isn&apos;t a magic number. It&apos;s a defensible answer to a
          real question between jobs: <strong>who do I call back first?</strong>
        </p>
      </DocProse>

      <DocPager href="/docs/heat-score" />
    </>
  )
}

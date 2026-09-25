"use client"
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main className="mx-auto max-w-3xl space-y-4 p-6"><h1 className="text-xl font-semibold">Policy drafts are unavailable</h1><p>Access or draft data could not be verified. No policy was activated.</p><button className="rounded-sm border px-4 py-2" onClick={reset}>Try again</button></main>
}

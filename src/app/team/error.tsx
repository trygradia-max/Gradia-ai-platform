"use client"
export default function TeamError({ reset }: { reset: () => void }) {
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">Team access unavailable</h1>
      <p role="alert">
        We could not verify your current access or load the records. No changes
        were made by this page.
      </p>
      <button className="rounded border px-4 py-2" onClick={reset}>
        Try again
      </button>
    </main>
  )
}

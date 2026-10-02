import Link from "next/link"
import { requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { loadIntakeHistory } from "@/lib/data/intake-history"
import { IntakeHistoryView } from "@/components/gradia/intake-history"

export const dynamic = "force-dynamic"
export default async function IntakeHistoryPage({ params, searchParams }: {
  params: Promise<{ workflowId: string }>
  searchParams: Promise<{ shop?: string; page?: string; revision?: string }>
}) {
  await requireUser()
  const { workflowId } = await params
  const query = await searchParams
  const page = Number(query.page ?? "1")
  const revision = query.revision === undefined ? null : Number(query.revision)
  const offset = Number.isSafeInteger(page) && page > 0 && page < 100000 ? (page - 1) * 20 : -1
  const db = await createClient()
  const result = await loadIntakeHistory(db, query.shop ?? "", workflowId, offset, revision)
  const base = `/intake/${encodeURIComponent(workflowId)}?shop=${encodeURIComponent(query.shop ?? "")}`
  return <main className="mx-auto max-w-3xl space-y-6 p-6">
    <Link href={`/intake?shop=${encodeURIComponent(query.shop ?? "")}`} className="underline">Back to intake review</Link>
    <h1 className="text-2xl font-semibold">Intake history</h1>
    <IntakeHistoryView result={result} />
    <Link href={base} className="underline">Refresh history</Link>
    {result.ok ? <nav aria-label="History pages" className="flex gap-4">
      {page > 1 ? <Link href={`${base}&page=${page - 1}&revision=${result.history.revision}`} className="underline">Previous</Link> : null}
      {page * 20 < result.history.total ? <Link href={`${base}&page=${page + 1}&revision=${result.history.revision}`} className="underline">Next</Link> : null}
    </nav> : null}
  </main>
}

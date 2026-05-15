import { ApprovalsList } from "@/components/gradia/approvals-list"
import { listOpenApprovalsForCurrentShop } from "@/lib/data/pending-actions"

export const dynamic = "force-dynamic"

export default async function ApprovalsPage() {
  const items = await listOpenApprovalsForCurrentShop()

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Waiting on us
        </h1>
        <p className="text-sm text-muted-foreground">
          A quick yes or no before anything lands — approve to save, edit to
          tweak, reject to drop.
        </p>
      </div>
      <ApprovalsList items={items} />
    </div>
  )
}

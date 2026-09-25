import Link from "next/link"
import { requireShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { policyDraftSchema } from "@/lib/control-center/drafts"
import { PolicyDraftEditor } from "./policy-draft-editor"

export const dynamic = "force-dynamic"
export default async function ControlCenterPage() {
  const shop = await requireShop()
  const db = await createClient()
  const [draft, history] = await Promise.all([
    db.from("control_policy_drafts").select("revision,definition").eq("shop_id", shop.id).single(),
    db.from("control_policy_history").select("revision,actor_id,created_at").eq("shop_id", shop.id).order("revision", { ascending: false }).limit(20),
  ])
  const parsed = policyDraftSchema.safeParse(draft.data?.definition)
  if (draft.error || history.error || !parsed.success || !Number.isSafeInteger(draft.data?.revision)) throw new Error("Policy drafts could not be verified. No settings were changed.")
  return <main className="mx-auto min-h-screen max-w-3xl space-y-6 p-6">
    <Link href="/settings" className="text-sm underline">Back to settings</Link>
    <h1 className="text-2xl font-semibold">Control Center · Policy drafts</h1>
    <p className="text-muted-foreground">Plan how Gradia should handle each operation. Saving a draft does not activate these rules or change current execution. These rules are saved for review only.</p>
    <PolicyDraftEditor key={shop.id} shopId={shop.id} revision={draft.data.revision} initial={parsed.data} />
    <section className="space-y-2" aria-labelledby="policy-history">
      <h2 id="policy-history" className="text-lg font-medium">Draft history</h2>
      <p className="text-sm text-muted-foreground">The latest 20 saved revisions. Each revision retains the policy and the owner who saved it.</p>
      <ol className="space-y-2">{history.data?.map(row => <li key={row.revision} className="rounded-md border p-3 text-sm">Revision {row.revision} · {new Date(row.created_at).toISOString()}<br /><span className="text-muted-foreground">{row.revision === 1 ? "Initial draft" : "Saved by the shop owner"}</span></li>)}</ol>
    </section>
  </main>
}

import { BiChat } from "@/components/gradia/bi-chat"
import { requireShop } from "@/lib/shop"

export const dynamic = "force-dynamic"

export default async function ChatPage() {
  // Gate on having a shop so the agent has a scope to query.
  await requireShop()

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Ask Gradia</h1>
        <p className="text-sm text-muted-foreground">
          Anything about our shop — leads, customers, our schedule, what
          people are asking about. Plain English in, straight answers out.
        </p>
      </div>
      <BiChat />
    </div>
  )
}

import { redirect } from "next/navigation"

/** Ask Gradia moved into Conversations (redesign spec §8-A4). Preserve
 *  deep links to a specific thread (?c=). */
export default async function LegacyChatPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>
}) {
  const params = await searchParams
  const c = params.c?.trim()
  redirect(c ? `/conversations?c=${encodeURIComponent(c)}` : "/conversations")
}

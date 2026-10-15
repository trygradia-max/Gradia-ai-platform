import { AppShell } from "@/components/gradia/app-shell"

export const dynamic = "force-dynamic"

export default function ConversationsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <AppShell flush>{children}</AppShell>
}

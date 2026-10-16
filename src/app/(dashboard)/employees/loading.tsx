import { Skeleton } from "@/components/ui/skeleton"

export default function EmployeesLoading() {
  return <div role="status" className="mx-auto max-w-6xl space-y-6" aria-label="Loading digital employees"><p className="text-sm text-muted-foreground">Loading your employee briefs…</p><Skeleton className="h-12 w-64" /><Skeleton className="h-96 rounded-xl" /></div>
}

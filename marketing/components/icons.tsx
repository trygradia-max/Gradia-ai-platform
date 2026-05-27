import {
  Phone,
  Mail,
  MessageSquare,
  AtSign,
  Calendar,
  CreditCard,
  Brain,
  type LucideIcon,
} from "lucide-react"

import type { IconKey } from "@/lib/site"

export const AGENT_ICON: Record<IconKey, LucideIcon> = {
  phone: Phone,
  mail: Mail,
  sms: MessageSquare,
  instagram: AtSign,
  calendar: Calendar,
  billing: CreditCard,
  memory: Brain,
}

/** Per-agent tile tint, echoing the app's channel grid palette. */
export const AGENT_TILE: Record<IconKey, string> = {
  phone: "bg-emerald-500/12 text-emerald-400 ring-emerald-500/25",
  mail: "bg-sky-500/12 text-sky-400 ring-sky-500/25",
  sms: "bg-amber-500/12 text-amber-400 ring-amber-500/25",
  instagram: "bg-pink-500/12 text-pink-400 ring-pink-500/25",
  calendar: "bg-indigo-500/12 text-indigo-400 ring-indigo-500/25",
  billing: "bg-primary/12 text-primary ring-primary/25",
  memory: "bg-violet-500/12 text-violet-400 ring-violet-500/25",
}

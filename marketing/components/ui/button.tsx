import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Marketing button. Mirrors the app's variant names so copy/paste from
 * /how-it-works stays faithful, minus the base-ui primitive — here a
 * plain button/anchor is enough and keeps the dep surface small.
 */
export const buttonVariants = cva(
  "group/button relative inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-transparent text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:brightness-110 hover:-translate-y-0.5 hover:accent-glow active:translate-y-0",
        outline:
          "border-border bg-card/40 text-foreground backdrop-blur-sm hover:border-border/80 hover:bg-card hover:-translate-y-0.5",
        ghost: "text-foreground/80 hover:bg-card hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-9 px-3.5 text-[0.8rem]",
        default: "h-10 px-4",
        lg: "h-12 px-5 text-[0.95rem]",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
)

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>

export function Button({
  className,
  variant,
  size,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}

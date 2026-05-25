/**
 * Gradient mesh anchor — drops behind hero sections to add depth
 * without committing to a full background image. The mesh sits at
 * `position: absolute` so the parent must be relative.
 *
 * Uses the .mesh-hero utility from globals.css so palette changes
 * stay in one place.
 */
export function MeshBackground({
  className = "",
}: {
  className?: string
}) {
  return (
    <div
      aria-hidden
      className={`mesh-hero pointer-events-none absolute inset-0 -z-10 ${className}`}
    />
  )
}

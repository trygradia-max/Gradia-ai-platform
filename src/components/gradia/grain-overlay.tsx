/**
 * Site-wide grain overlay. Fixed, viewport-sized, ignores pointer
 * events. SVG fractal noise scaled to look like 35mm film grain
 * without the file weight of a real noise PNG. mix-blend-overlay
 * keeps it readable on both pure black and lighter surfaces.
 *
 * No animations here — grain that moves looks like a TV glitch,
 * not luxury.
 */
export function GrainOverlay() {
  return (
    <div
      aria-hidden
      className="grain-layer pointer-events-none fixed inset-0 z-[60]"
    />
  )
}

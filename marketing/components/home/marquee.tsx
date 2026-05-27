/**
 * Kinetic marquee — a high-energy strip of everything Gradia handles,
 * sliding past in big display type. Pure CSS animation (no JS), two
 * copies of the list so the loop is seamless; pauses on reduced motion.
 */
const WORDS = [
  "Calls",
  "Texts",
  "DMs",
  "Emails",
  "Bookings",
  "Invoices",
  "Follow-ups",
  "Reminders",
  "Quotes",
  "Reviews",
]

function Row() {
  return (
    <>
      {WORDS.map((w, i) => (
        <span key={`${w}-${i}`} className="flex items-center">
          <span
            className={
              i % 3 === 1
                ? "font-display italic text-primary"
                : "font-display text-foreground/85"
            }
          >
            {w}
          </span>
          <span
            aria-hidden
            className="mx-7 size-2 shrink-0 rounded-full bg-primary/60 sm:mx-10"
          />
        </span>
      ))}
    </>
  )
}

export function Marquee() {
  return (
    <section
      aria-label="What Gradia handles"
      className="relative overflow-hidden border-y border-border/40 bg-card/15 py-6 sm:py-8"
    >
      {/* Fade the edges so words enter/leave cleanly. */}
      <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-24 bg-gradient-to-r from-background to-transparent sm:w-40" />
      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-24 bg-gradient-to-l from-background to-transparent sm:w-40" />

      <div className="marquee-track text-[clamp(1.75rem,4vw,3rem)] leading-none tracking-tight">
        <Row />
        <Row />
      </div>
    </section>
  )
}

/**
 * Keyboard focus paint that cannot be rewritten to ring/50 by Tailwind.
 * Hexes are the founder table (link/focus #A78BFA, raised #222630).
 */
export function FocusStyles() {
  return (
    <style>{`
      :focus-visible {
        outline-style: solid !important;
        outline-width: 3px !important;
        outline-color: #a78bfa !important;
        outline-offset: 2px !important;
      }
      a.whisper-skip:focus,
      a.whisper-skip:focus-visible {
        position: fixed !important;
        top: 1rem !important;
        left: 1rem !important;
        z-index: 50 !important;
        height: auto !important;
        width: auto !important;
        overflow: visible !important;
        padding-block: 0.5rem !important;
        padding-inline: 0.75rem !important;
        border: 1px solid #64748b !important;
        background: #222630 !important;
        color: #f4f5f7 !important;
        outline-style: solid !important;
        outline-width: 3px !important;
        outline-color: #a78bfa !important;
        outline-offset: 2px !important;
      }
    `}</style>
  )
}

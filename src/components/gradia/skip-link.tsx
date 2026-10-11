/**
 * Off-screen until focused. Shared so team chrome, the owner shell, and
 * Whisper panes all expose the same first tab stop.
 */
export function SkipLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} className="whisper-skip">
      {children}
    </a>
  )
}

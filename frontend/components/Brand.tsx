/**
 * The mark. A treadle is the foot lever that drives a machine: a pedal on a pivot, and the bar it
 * turns. Drawn here for the same reason the BPMN notation is — this product does not borrow its
 * vocabulary, and a logo pulled from an icon set would be the one thing on the page that was.
 */
export function Mark({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      role="img"
      aria-label="Therblig"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 16.5 L21 11.5" />
      <path d="M12 14 L8.5 20.5 H15.5 z" fill="currentColor" stroke="none" />
      <circle cx="20" cy="6" r="2.6" />
      <path d="M20 8.6 V11" />
    </svg>
  );
}

export function Wordmark({ subdued = false }: { subdued?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <Mark className={`h-[18px] w-[18px] ${subdued ? 'text-ink-3' : 'text-plot'}`} />
      <span className="text-[13px] font-semibold tracking-tight">
        Therblig<span className="text-ink-3"> Studio</span>
      </span>
    </span>
  );
}

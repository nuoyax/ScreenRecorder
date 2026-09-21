type Props = {
  /** Remaining seconds, 1..n. Render nothing when the countdown is not running. */
  remaining: number | null;
};

/**
 * Full-window countdown overlay shown between pressing record and capture starting.
 *
 * Non-interactive (`pointer-events-none`) so it cannot swallow clicks meant for the
 * controls underneath, and it carries no `WDA_EXCLUDEFROMCAPTURE` affinity itself —
 * the whole window is excluded by the backend, so the overlay never appears in the
 * recording it is counting down to.
 */
export function CountdownOverlay({ remaining }: Props) {
  if (remaining === null) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-canvas/70">
      <span
        key={remaining}
        className="countdown-tick text-[120px] font-bold tabular-nums text-rec drop-shadow-lg"
      >
        {remaining}
      </span>
    </div>
  );
}

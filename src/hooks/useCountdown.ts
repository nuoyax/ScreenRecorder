import { useEffect, useState } from "react";
import { api } from "@/lib/api";

/**
 * Remaining seconds of the pre-recording countdown, or `null` when idle.
 *
 * `start_recording` blocks on the backend while the countdown runs, so this hook
 * reads the `countdown` events the backend emits during that call rather than
 * tracking a timer locally (a local timer would drift from the real start).
 */
export function useCountdown(): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void api
      .onCountdown((n) => {
        if (cancelled) return;
        // 0 means "countdown over, capture is live" — fall back to the recording state.
        setRemaining(n > 0 ? n : null);
      })
      .then((off) => {
        if (cancelled) off();
        else unlisten = off;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return remaining;
}

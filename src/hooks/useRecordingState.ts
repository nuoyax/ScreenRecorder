import { useEffect, useState } from "react";
import { api, type Progress, type RecState } from "@/lib/api";

export function useRecordingState() {
  const [state, setState] = useState<RecState>("idle");
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const apply = (p: Progress | null | undefined) => {
      const next = p?.state ?? "idle";
      setState(next);
      setDuration(next === "idle" ? 0 : (p?.duration_secs ?? 0));
    };
    (async () => {
      try {
        apply(await api.recordingProgress());
      } catch {
        apply(null);
      }
      if (cancelled) return;
      unlisten = await api.onProgress((p) => {
        if (!cancelled) apply(p);
      });
      void api.onCodecFallback((codec) => {
        if (!cancelled && codec === "h265") {
          console.warn("HEVC 不可用，已自动切换 H.264");
        }
      });
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return {
    state,
    duration,
    busy: state === "recording" || state === "paused",
  };
}

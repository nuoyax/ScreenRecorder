import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useRecordingState } from "@/hooks/useRecordingState";

export function IndicatorPage() {
  const { state } = useRecordingState();

  useEffect(() => {
    const win = getCurrentWindow();
    if (state === "recording" || state === "paused") {
      win.show();
    } else {
      win.hide();
    }
  }, [state]);

  return (
    <div
      className={`m-2 h-[18px] w-[18px] rounded-full ${
        state === "paused" ? "bg-pause" : "bg-rec rec-pulse"
      }`}
    />
  );
}

import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Show the current Tauri window after the first paint.
 *
 * The main window starts hidden (`visible: false`) so WebView2 can finish loading
 * against a dark background instead of flashing white. Call once from each entry.
 */
export function revealWindowWhenReady(): void {
  const show = () => {
    void getCurrentWindow()
      .show()
      .catch(() => undefined);
  };

  // Double rAF: first after layout, second after paint of that layout.
  requestAnimationFrame(() => {
    requestAnimationFrame(show);
  });
}

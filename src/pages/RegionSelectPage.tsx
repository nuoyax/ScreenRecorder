import { useCallback, useEffect, useRef, useState } from "react";
import { api, type MonitorPreview } from "@/lib/api";

/** A rectangle in the picker's own CSS pixel space. */
type Box = { x: number; y: number; w: number; h: number };

type Drag = {
  /** Origin in viewport coordinates. */
  ox: number;
  oy: number;
  box: Box;
};

/** Ignore accidental micro-drags so a stray click cannot set a 1px region. */
const MIN_BOX_PX = 8;

function boxFrom(ox: number, oy: number, x: number, y: number, bounds: Box): Box {
  const left = Math.min(ox, x);
  const top = Math.min(oy, y);
  const right = Math.max(ox, x);
  const bottom = Math.max(oy, y);
  // Clamp to the monitor: dragging past the edge must not produce coordinates
  // outside the captured frame, which the recorder would crop away.
  const cl = Math.max(0, Math.min(left, bounds.w));
  const ct = Math.max(0, Math.min(top, bounds.h));
  const cr = Math.max(0, Math.min(right, bounds.w));
  const cb = Math.max(0, Math.min(bottom, bounds.h));
  return { x: cl, y: ct, w: cr - cl, h: cb - ct };
}

/**
 * Downscale the selection to a thumbnail for the settings panel.
 *
 * Drawn from the already-loaded preview, so this costs one canvas and no second
 * screen grab.
 */
function makeThumbnail(
  img: HTMLImageElement,
  box: Box,
  stage: HTMLDivElement | null,
): string {
  const displayW = stage?.clientWidth || 1;
  const displayH = stage?.clientHeight || 1;
  const maxW = 160;
  const ratio = Math.min(1, maxW / Math.max(box.w, 1));
  const tw = Math.max(1, Math.round(box.w * ratio));
  const th = Math.max(1, Math.round(box.h * ratio));

  const canvas = document.createElement("canvas");
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  // The preview is stretched to fill the stage, so CSS pixels have to go through the
  // display size to land on source pixels of the loaded image.
  const sx = img.naturalWidth / displayW;
  const sy = img.naturalHeight / displayH;
  ctx.drawImage(
    img,
    box.x * sx,
    box.y * sy,
    box.w * sx,
    box.h * sy,
    0,
    0,
    tw,
    th,
  );
  return canvas.toDataURL("image/png");
}

/**
 * Monitor pixels per CSS pixel of the stage.
 *
 * The preview may be a downscaled still ('still.scale' monitor px per preview px)
 * shown at some other CSS size, so both hops are needed. Skipping the monitor hop
 * happens to work at 1:1 and is silently wrong on a 4K display.
 */
function realPerCss(preview: MonitorPreview, stage: HTMLDivElement | null): [number, number] {
  const w = stage?.clientWidth || 1;
  const h = stage?.clientHeight || 1;
  return [preview.monitor_width / w, preview.monitor_height / h];
}

/** Selection in absolute virtual-screen coordinates, or null when too small. */
function toRegion(
  preview: MonitorPreview,
  box: Box,
  stage: HTMLDivElement | null,
): [number, number, number, number] | null {
  const [sx, sy] = realPerCss(preview, stage);
  const w = Math.round(box.w * sx);
  const h = Math.round(box.h * sy);
  if (w < MIN_BOX_PX || h < MIN_BOX_PX) return null;
  return [preview.x + Math.round(box.x * sx), preview.y + Math.round(box.y * sy), w, h];
}

/**
 * Full-monitor region picker.
 *
 * Shows a still of the monitor as a backdrop, lets the user drag a rectangle on it,
 * and reports the result in absolute virtual-screen coordinates. It deliberately
 * does not try to be a live mirror: a still is enough to aim with, and it costs one
 * capture instead of a continuous one competing with the recorder.
 */
export function RegionSelectPage() {
  const [preview, setPreview] = useState<MonitorPreview | null>(null);
  const [error, setError] = useState("");
  const [drag, setDrag] = useState<Drag | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async (monitorId: string) => {
    try {
      const p = await api.captureMonitorPreview(monitorId);
      setPreview(p);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // The window is created over a monitor and the backend records which; ask for it
  // rather than guessing, so a second open on another monitor shows the right still.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      const id = await api.regionTarget();
      if (cancelled) return;
      if (id) await load(id);
      else setError("没有指定显示器");
    })();
    api
      .onRegionTarget((id) => {
        if (!cancelled) void load(id);
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
  }, [load]);

  // Esc cancels. Registered on the window so it works before any click lands.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void api.closeRegionPicker();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const bounds = (): Box => ({
    x: 0,
    y: 0,
    w: stageRef.current?.clientWidth ?? 0,
    h: stageRef.current?.clientHeight ?? 0,
  });

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const b = bounds();
    const start = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY };
    setDrag({ ox: start.x, oy: start.y, box: b });
    setBox({ x: start.x, y: start.y, w: 0, h: 0 });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    setBox(
      boxFrom(drag.ox, drag.oy, e.nativeEvent.offsetX, e.nativeEvent.offsetY, drag.box),
    );
  };

  const onPointerUp = () => setDrag(null);

  const confirm = async () => {
    if (!preview || !box || !imgRef.current) return;
    const region = toRegion(preview, box, stageRef.current);
    if (!region) {
      setError(`选区太小（至少 ${MIN_BOX_PX}px）`);
      return;
    }
    const thumbnail = makeThumbnail(imgRef.current, box, stageRef.current);
    try {
      await api.applyRegion(region, thumbnail, await api.regionTarget());
    } catch (e) {
      setError(String(e));
    }
  };

  // Recomputed on every render so the readout follows the drag and stays in the same
  // units the backend will store.
  const pending = preview && box && box.w > 0 ? toRegion(preview, box, stageRef.current) : null;
  const canConfirm = pending !== null;

  return (
    <div className="flex h-screen select-none flex-col text-ink">
      <div
        ref={stageRef}
        className="relative min-h-0 flex-1 cursor-crosshair overflow-hidden"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {preview ? (
          // Dimmed, so the live desktop underneath is visible but out of the way.
          <img
            ref={imgRef}
            src={preview.data_url}
            alt="屏幕预览"
            draggable={false}
            className="pointer-events-none absolute inset-0 h-full w-full opacity-40"
          />
        ) : (
          !error && (
            <div className="absolute inset-0 flex items-center justify-center text-muted">
              正在抓取画面…
            </div>
          )
        )}

        {/*
          WeChat-style selection: the four panes outside the rectangle are dimmed,
          which both marks the selection and makes it obvious that the screen itself
          is still live underneath — the window is transparent, so nothing is drawn
          inside the rectangle at all and the desktop shows through at full strength.
          Panes instead of one overlay with a hole cut in it: the pane edges are the
          border, so there is nothing to recompute on every pointer move.
        */}
        {preview && box && box.w > 0 && box.h > 0 && (
          <div className="pointer-events-none absolute inset-0">
            <div
              className="absolute inset-x-0 top-0 bg-black/45"
              style={{ height: box.y }}
            />
            <div
              className="absolute inset-x-0 bg-black/45"
              style={{ top: box.y + box.h, bottom: 0 }}
            />
            <div
              className="absolute left-0 bg-black/45"
              style={{ top: box.y, height: box.h, width: box.x }}
            />
            <div
              className="absolute right-0 bg-black/45"
              style={{ top: box.y, height: box.h, left: box.x + box.w }}
            />

            <div
              className="absolute border border-rec"
              style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
            >
              {/*
                Handles, as in the screenshot tools they will be recognised from.
                They are decoration only: this picker is drag-to-draw, not
                drag-to-resize, so they are deliberately inert.
              */}
              {[
                [-4, -4],
                [box.w - 4, -4],
                [-4, box.h - 4],
                [box.w - 4, box.h - 4],
              ].map(([x, y]) => (
                <span
                  key={`${x},${y}`}
                  className="absolute h-2 w-2 border border-black/60 bg-white"
                  style={{ left: x, top: y }}
                />
              ))}
            </div>

            {/* Size readout, in the monitor pixels the backend will store rather than
                the CSS pixels the rectangle is drawn in. Hidden while the drag is too
                small to become a region at all. */}
            {pending && (
              <div
                className="absolute rounded bg-black/70 px-1.5 py-0.5 text-[11px] tabular-nums text-white"
                style={{
                  left: Math.max(0, Math.min(box.x, (stageRef.current?.clientWidth ?? 0) - 92)),
                  top: box.y > 26 ? box.y - 24 : box.y + box.h + 6,
                }}
              >
                {pending[2]} × {pending[3]}
              </div>
            )}
          </div>
        )}
      </div>

      {/*
        The controls sit in normal flow under the stage; the stage fills the rest.
        An overlay would either swallow the drag or hide the numbers being read.
      */}
      <div className="flex items-center justify-center gap-3 bg-panel px-3 py-2">
        <span className="tabular-nums text-muted">
          {pending
            ? `${pending[0]}, ${pending[1]}  ·  ${pending[2]} × ${pending[3]}`
            : "拖拽画出要录制的区域"}
        </span>
        {error && <span className="text-rec">{error}</span>}
        <button
          className="rounded-md bg-ctl px-3 py-1 text-ink hover:brightness-125 disabled:opacity-40"
          disabled={!canConfirm}
          onClick={confirm}
        >
          确定
        </button>
        <button
          className="rounded-md bg-ctl px-3 py-1 text-ink hover:brightness-125"
          onClick={() => void api.closeRegionPicker()}
        >
          取消 (Esc)
        </button>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { Typography } from "antd";
import type { Project } from "@/lib/editor/state";
import { durationMs, ops } from "@/lib/editor/state";
import { formatTimecode } from "@/lib/timeline/time";
import { fitSpan, type Span, MIN_SPAN_MS } from "@/lib/timeline/span";

const { Text } = Typography;

type Props = {
  project: Project | null;
  playheadMs: number;
  durationMs: number;
  selectedClipId: string | null;
  onSeek: (ms: number) => void;
  onSelectClip: (id: string | null) => void;
  edit: (fn: (project: Project) => Project) => void;
};

/** Pointer travel, in pixels, below which a gesture counts as a click not a drag. */
const DRAG_THRESHOLD_PX = 3;

/** Lane rows in the timeline, in draw order from the top. */
const LANES = ["clips", "zooms", "annotations"] as const;
type Lane = (typeof LANES)[number];

/**
 * Timeline: ruler, three lanes, and a draggable playhead.
 *
 * Built on native pointer events rather than a drag library — the gesture set is
 * small (seek, move a region, drag one of its edges) and the arithmetic is already
 * in `timeline/span.ts`, so a dependency would only add a second source of truth for
 * where a boundary ended up.
 */
export function Timeline({
  project,
  playheadMs,
  durationMs: total,
  selectedClipId,
  onSeek,
  onSelectClip,
  edit,
}: Props) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  // Track the rendered width so pointer x can be converted to a time. Measured with
  // a ResizeObserver instead of window resize events, which miss layout changes that
  // do not change the window size (like the inspector panel being toggled).
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const safeTotal = Math.max(1, total);

  const msToPx = (ms: number) => (ms / safeTotal) * width;
  const pxToMs = (px: number) => (px / Math.max(1, width)) * safeTotal;

  const seekFromEvent = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    onSeek(Math.max(0, Math.min(safeTotal, pxToMs(clientX - rect.left))));
  };

  if (!project) {
    return (
      <div className="mt-2 rounded-xl border border-ctl bg-panel p-4 text-center text-xs text-muted">
        打开一个录制后即可编辑
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-xl border border-ctl bg-panel p-3">
      <div className="mb-1 flex items-center justify-between">
        <Text type="secondary" className="text-xs">
          时间轴
        </Text>
        <Text type="secondary" className="text-xs tabular-nums">
          {formatTimecode(playheadMs)}
        </Text>
      </div>

      <div
        ref={trackRef}
        className="relative select-none"
        onPointerDown={(e) => {
          // A press on a region is that region's business; only bare-track presses
          // move the playhead, so dragging a clip does not also scrub.
          if (e.target === e.currentTarget) seekFromEvent(e.clientX);
        }}
      >
        {/* Ruler */}
        <div className="relative h-5 cursor-pointer border-b border-ctl" onPointerDown={(e) => seekFromEvent(e.clientX)}>
          {ticks(safeTotal, width).map((t) => (
            <div
              key={t.ms}
              className="absolute top-0 h-full border-l border-ctl/60 pl-1 text-[10px] text-muted"
              style={{ left: t.px }}
            >
              {t.label}
            </div>
          ))}
        </div>

        {LANES.map((lane) => (
          <LaneRow
            key={lane}
            lane={lane}
            project={project}
            total={safeTotal}
            msToPx={msToPx}
            pxToMs={pxToMs}
            selectedClipId={selectedClipId}
            onSelectClip={onSelectClip}
            edit={edit}
          />
        ))}

        {/* Playhead: drawn last so it is never hidden by a region. */}
        <div
          className="pointer-events-none absolute top-0 z-10 w-px bg-rec"
          style={{ left: msToPx(playheadMs), height: "100%" }}
        >
          <div className="absolute -left-[3px] top-0 h-2 w-[7px] rounded-b bg-rec" />
        </div>
      </div>

      <p className="mt-1.5 text-[11px] text-muted">
        拖拽区段移动，拖拽两端调整时长；点击空白处定位播放头。最短 {MIN_SPAN_MS}ms。
      </p>
    </div>
  );
}

function LaneRow({
  lane,
  project,
  total,
  msToPx,
  pxToMs,
  selectedClipId,
  onSelectClip,
  edit,
}: {
  lane: Lane;
  project: Project;
  total: number;
  msToPx: (ms: number) => number;
  pxToMs: (px: number) => number;
  selectedClipId: string | null;
  onSelectClip: (id: string | null) => void;
  edit: (fn: (project: Project) => Project) => void;
}) {
  const regions =
    lane === "clips"
      ? project.clips.map((c) => ({ id: c.id, startMs: c.startMs, endMs: c.endMs, label: `${c.speed}×` }))
      : lane === "zooms"
        ? project.zooms.map((z) => ({ id: z.id, startMs: z.startMs, endMs: z.endMs, label: `${z.depth}×` }))
        : project.annotations.map((a) => ({
            id: a.id,
            startMs: a.startMs,
            endMs: a.endMs,
            label: a.textContent.slice(0, 8),
          }));

  const rowClass =
    lane === "clips" ? "h-7" : lane === "zooms" ? "h-5" : "h-5";
  const regionClass =
    lane === "clips"
      ? "bg-ctl border-ink/30"
      : lane === "zooms"
        ? "bg-rec/30 border-rec/60"
        : "bg-pause/30 border-pause/60";

  return (
    <div className={`relative mt-0.5 ${rowClass}`}>
      {regions.map((region) => (
        <Region
          key={region.id}
          region={region}
          total={total}
          msToPx={msToPx}
          pxToMs={pxToMs}
          className={regionClass}
          selected={selectedClipId === region.id}
          onSelect={() => onSelectClip(region.id)}
          onCommit={(span) => {
            edit((p) => {
              if (lane === "clips") return ops.moveClip(region.id, span.startMs, span.endMs)(p);

              if (lane === "zooms") {
                const zoom = p.zooms.find((z) => z.id === region.id);
                if (!zoom) return p;
                // A pure shift and a resize take different paths: a resize is clamped
                // edge by edge against the other edge, which a single delta or a
                // wholesale span write cannot express.
                if (span.endMs - span.startMs === zoom.endMs - zoom.startMs) {
                  return ops.moveZoom(zoom.id, span.startMs - zoom.startMs)(p);
                }
                return ops.resizeZoom(zoom.id, "end", span.endMs)(
                  ops.resizeZoom(zoom.id, "start", span.startMs)(p),
                );
              }

              const ann = p.annotations.find((a) => a.id === region.id);
              if (!ann) return p;
              const fitted = fitSpan(span.startMs, span.endMs, durationMs(p));
              return fitted
                ? ops.updateAnnotation(ann.id, { startMs: fitted.startMs, endMs: fitted.endMs })(p)
                : p;
            });
          }}
        />
      ))}
    </div>
  );
}

/**
 * One draggable region.
 *
 * The span is held in local state while dragging and only committed on pointer-up,
 * so a drag produces exactly one undo step instead of one per animation frame.
 */
function Region({
  region,
  total,
  msToPx,
  pxToMs,
  className,
  selected,
  onSelect,
  onCommit,
}: {
  region: { id: string; startMs: number; endMs: number; label: string };
  total: number;
  msToPx: (ms: number) => number;
  pxToMs: (px: number) => number;
  className: string;
  selected: boolean;
  onSelect: () => void;
  onCommit: (span: Span) => void;
}) {
  const [draft, setDraft] = useState<Span | null>(null);
  const drag = useRef<{ startX: number; edge: "start" | "end" | "move"; origin: Span } | null>(
    null,
  );

  const shown = draft ?? { startMs: region.startMs, endMs: region.endMs };

  const begin = (e: React.PointerEvent, edge: "start" | "end" | "move") => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    onSelect();
    drag.current = {
      startX: e.clientX,
      edge,
      origin: { startMs: region.startMs, endMs: region.endMs },
    };
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const deltaMs = pxToMs(e.clientX - d.startX);
    if (Math.abs(e.clientX - d.startX) < DRAG_THRESHOLD_PX && d.edge === "move") return;

    if (d.edge === "move") {
      const length = d.origin.endMs - d.origin.startMs;
      const maxStart = Math.max(0, total - length);
      const start = Math.max(0, Math.min(d.origin.startMs + deltaMs, maxStart));
      setDraft({ startMs: Math.round(start), endMs: Math.round(start + length) });
    } else if (d.edge === "start") {
      const start = Math.max(0, Math.min(d.origin.startMs + deltaMs, d.origin.endMs - MIN_SPAN_MS));
      setDraft({ startMs: Math.round(start), endMs: d.origin.endMs });
    } else {
      const end = Math.min(total, Math.max(d.origin.endMs + deltaMs, d.origin.startMs + MIN_SPAN_MS));
      setDraft({ startMs: d.origin.startMs, endMs: Math.round(end) });
    }
  };

  const finish = () => {
    if (drag.current && draft) onCommit(draft);
    drag.current = null;
    setDraft(null);
  };

  const left = msToPx(shown.startMs);
  const w = Math.max(2, msToPx(shown.endMs) - left);

  return (
    <div
      className={`absolute top-0 h-full cursor-grab rounded border ${className} ${
        selected ? "ring-2 ring-rec" : ""
      }`}
      style={{ left, width: w }}
      onPointerDown={(e) => begin(e, "move")}
      onPointerMove={move}
      onPointerUp={finish}
      onPointerCancel={finish}
    >
      {/* Edge handles are wider than they look, so they can actually be grabbed. */}
      <div
        className="absolute left-0 top-0 h-full w-2 cursor-ew-resize"
        onPointerDown={(e) => begin(e, "start")}
        onPointerMove={move}
        onPointerUp={finish}
      />
      <div
        className="absolute right-0 top-0 h-full w-2 cursor-ew-resize"
        onPointerDown={(e) => begin(e, "end")}
        onPointerMove={move}
        onPointerUp={finish}
      />
      <span className="pointer-events-none block truncate px-1 text-[10px] leading-[inherit] text-ink">
        {region.label}
      </span>
    </div>
  );
}

/** Ruler ticks at a spacing that stays readable at any zoom level. */
function ticks(totalMs: number, width: number): Array<{ ms: number; px: number; label: string }> {
  if (width <= 0) return [];
  // Aim for a tick roughly every 80px, then snap to a round interval.
  const targetMs = (80 / width) * totalMs;
  const candidates = [250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 300_000];
  const step = candidates.find((c) => c >= targetMs) ?? candidates[candidates.length - 1];
  const out: Array<{ ms: number; px: number; label: string }> = [];
  for (let ms = 0; ms <= totalMs; ms += step) {
    out.push({ ms, px: (ms / totalMs) * width, label: formatTimecode(ms) });
    if (out.length > 200) break;
  }
  return out;
}

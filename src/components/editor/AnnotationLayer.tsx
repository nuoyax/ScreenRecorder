import { useEffect, useRef, useState } from "react";
import { Button, ColorPicker, Input, InputNumber, Segmented, Select, Typography } from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { annotationsAt, ops, type Project } from "@/lib/editor/state";
import {
  DEFAULT_ANNOTATION_STYLE,
  type AnnotationRegion,
  type AnnotationType,
} from "@/lib/timeline/types";

const { Text } = Typography;

type Props = {
  project: Project | null;
  playheadMs: number;
  edit: (fn: (project: Project) => Project) => void;
  /** Composed frame size, in composition pixels. */
  frameWidth: number;
  frameHeight: number;
};

/** Default size of a freshly added annotation, as a fraction of the video box. */
const NEW_TEXT_SIZE = { width: 0.4, height: 0.08 };
const NEW_ARROW_SIZE = { width: 0.2, height: 0.06 };

/** How long a new annotation stays on screen when added at the playhead. */
const NEW_ANNOTATION_MS = 3000;

/**
 * Interactive layer over the preview canvas.
 *
 * The canvas already *draws* annotations; this layer exists only so they can be
 * grabbed. It therefore has to place its boxes exactly where the compositor draws
 * them, which means applying the same background padding inset — and it does that in
 * percentages so the two stay aligned at any preview size.
 */
export function AnnotationLayer({ project, playheadMs, edit, frameWidth, frameHeight }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (selectedId && !project?.annotations.some((a) => a.id === selectedId)) {
      setSelectedId(null);
    }
  }, [project, selectedId]);

  if (!project) return null;

  const padding = project.background.padding;
  const boxFrac = Math.max(0.01, 1 - padding * 2);
  const visible = annotationsAt(project, playheadMs);
  const selected = project.annotations.find((a) => a.id === selectedId) ?? null;

  const add = (type: AnnotationType) => {
    const size = type === "text" ? NEW_TEXT_SIZE : NEW_ARROW_SIZE;
    const annotation = {
      startMs: playheadMs,
      endMs: playheadMs + NEW_ANNOTATION_MS,
      type,
      textContent: type === "text" ? "双击输入文字" : "",
      position: { x: 0.5, y: 0.5 },
      size,
      style: { ...DEFAULT_ANNOTATION_STYLE },
      rotation: type === "arrow" ? 0 : 0,
    };
    edit(ops.addAnnotation(annotation));
  };

  return (
    <>
      {/* Draggable boxes for whatever is on screen at the playhead. */}
      <div className="pointer-events-none absolute inset-0">
        {visible.map((annotation) => (
          <DraggableAnnotation
            key={annotation.id}
            annotation={annotation}
            padding={padding}
            boxFrac={boxFrac}
            frameWidth={frameWidth}
            frameHeight={frameHeight}
            selected={annotation.id === selectedId}
            onSelect={() => setSelectedId(annotation.id)}
            edit={edit}
          />
        ))}
      </div>

      {/* Controls live outside the frame so they never overlap what is being composed. */}
      <div className="absolute bottom-2 left-2 right-2 flex flex-wrap items-center gap-1.5 rounded-lg bg-panel/95 p-1.5 backdrop-blur">
        <Button size="small" icon={<PlusOutlined />} onClick={() => add("text")}>
          文字
        </Button>
        <Button size="small" icon={<PlusOutlined />} onClick={() => add("arrow")}>
          箭头
        </Button>

        {selected ? (
          <>
            <Segmented
              size="small"
              value={selected.type}
              onChange={(v) =>
                edit(ops.updateAnnotation(selected.id, { type: v as AnnotationType }))
              }
              options={[
                { label: "文字", value: "text" },
                { label: "箭头", value: "arrow" },
              ]}
            />
            {selected.type === "text" && (
              <Input
                size="small"
                className="w-[160px]"
                value={selected.textContent}
                onChange={(e) =>
                  edit(ops.updateAnnotation(selected.id, { textContent: e.target.value }))
                }
                placeholder="文字内容"
              />
            )}
            <ColorPicker
              size="small"
              value={selected.style.color}
              onChange={(c) =>
                edit(ops.updateAnnotation(selected.id, { style: { ...selected.style, color: c.toHexString() } }))
              }
            />
            <InputNumber
              size="small"
              className="w-[68px]"
              min={8}
              max={200}
              value={selected.style.fontSize}
              onChange={(v) =>
                edit(
                  ops.updateAnnotation(selected.id, {
                    style: { ...selected.style, fontSize: Number(v ?? 32) },
                  }),
                )
              }
              addonAfter="px"
            />
            {selected.type === "arrow" && (
              <InputNumber
                size="small"
                className="w-[76px]"
                min={0}
                max={359}
                value={Math.round(selected.rotation)}
                onChange={(v) => edit(ops.updateAnnotation(selected.id, { rotation: Number(v ?? 0) }))}
                addonAfter="°"
              />
            )}
            <Select
              size="small"
              className="w-[104px]"
              value={selected.endMs}
              onChange={(v) => edit(ops.updateAnnotation(selected.id, { endMs: v }))}
              options={END_OPTIONS(playheadMs, selected.endMs)}
            />
            <Button
              size="small"
              danger
              type="text"
              icon={<DeleteOutlined />}
              onClick={() => {
                edit(ops.removeAnnotation(selected.id));
                setSelectedId(null);
              }}
            />
          </>
        ) : (
          <Text type="secondary" className="text-[11px]">
            点选画面里的注释即可编辑；此处的新注释只出现在播放头附近 {NEW_ANNOTATION_MS / 1000}s 内。
          </Text>
        )}
      </div>
    </>
  );
}

/**
 * One annotation the user can drag.
 *
 * Position is written back as a normalized fraction of the video box, which is the
 * same space the compositor reads from — so dragging here moves the drawn annotation
 * by exactly the distance dragged, at any preview size.
 */
function DraggableAnnotation({
  annotation,
  padding,
  boxFrac,
  frameWidth,
  frameHeight,
  selected,
  onSelect,
  edit,
}: {
  annotation: AnnotationRegion;
  padding: number;
  boxFrac: number;
  frameWidth: number;
  frameHeight: number;
  selected: boolean;
  onSelect: () => void;
  edit: (fn: (project: Project) => Project) => void;
}) {
  const drag = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(
    null,
  );
  const [draft, setDraft] = useState<{ x: number; y: number } | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);

  const position = draft ?? annotation.position;

  const begin = (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    onSelect();
    drag.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: annotation.position.x,
      originY: annotation.position.y,
    };
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = frameRef.current;
    if (!d || !el) return;
    const rect = el.getBoundingClientRect();
    // The box is a fraction of the *video* box, which starts one padding in — so the
    // denominator is the video box's pixel size, not the frame's.
    const boxW = Math.max(1, rect.width * boxFrac);
    const boxH = Math.max(1, rect.height * boxFrac);
    const x = clamp01(d.originX + (e.clientX - d.startX) / boxW);
    const y = clamp01(d.originY + (e.clientY - d.startY) / boxH);
    setDraft({ x, y });
  };

  const finish = () => {
    if (drag.current && draft) {
      // A drag that moved nothing must not push an undo step; `applyEdit` drops the
      // no-op for us as long as the patch is identical.
      edit(ops.updateAnnotation(annotation.id, { position: draft }));
    }
    drag.current = null;
    setDraft(null);
  };

  const leftPct = (padding + position.x * boxFrac) * 100;
  const topPct = (padding + position.y * boxFrac) * 100;
  const widthPct = annotation.size.width * boxFrac * 100;
  const heightPct = annotation.size.height * boxFrac * 100;

  return (
    <div
      ref={frameRef}
      className={`pointer-events-auto absolute cursor-move rounded border border-dashed ${
        selected ? "border-rec bg-rec/10" : "border-transparent hover:border-ink/40"
      }`}
      style={{
        left: `${leftPct}%`,
        top: `${topPct}%`,
        width: `${widthPct}%`,
        height: `${heightPct}%`,
        transform: "translate(-50%, -50%)",
        // Matches the compositor's own rotation so the handle follows the drawing.
        rotate: annotation.type === "arrow" ? `${annotation.rotation}deg` : undefined,
      }}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={finish}
      onPointerCancel={finish}
      title={annotation.type === "text" ? annotation.textContent : "箭头"}
    >
      <span className="sr-only">
        {frameWidth}x{frameHeight} 上的注释
      </span>
    </div>
  );
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** A few convenient "ends at" choices, plus whatever the annotation already has. */
function END_OPTIONS(playheadMs: number, currentEndMs: number) {
  const options = [1000, 2000, 3000, 5000].map((ms) => ({
    value: Math.round(playheadMs + ms),
    label: `播放头 +${ms / 1000}s`,
  }));
  if (!options.some((o) => o.value === currentEndMs)) {
    options.push({ value: Math.round(currentEndMs), label: `当前 ${Math.round(currentEndMs)}ms` });
  }
  return options;
}

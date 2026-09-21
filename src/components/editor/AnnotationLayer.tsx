import { useEffect, useRef, useState } from "react";
import { Button, ColorPicker, Input, InputNumber, Select, Tooltip, Typography } from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { annotationsAt, durationMs, ops, type Project } from "@/lib/editor/state";
import {
  HANDLE_FRACTION,
  annotationBox,
  moveAnnotation,
  resizeAnnotation,
  setRotation,
  type AnnotationHandle,
} from "@/lib/editor/annotationOps";
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
};

/** Default size of a freshly added annotation, as a fraction of the video box. */
const NEW_TEXT_SIZE = { width: 0.4, height: 0.08 };
const NEW_ARROW_SIZE = { width: 0.2, height: 0.06 };

/** How long a new annotation stays on screen when added at the playhead. */
const NEW_ANNOTATION_MS = 3000;

const HANDLES: AnnotationHandle[] = ["nw", "ne", "sw", "se"];

/**
 * Interactive layer over the preview canvas.
 *
 * The canvas already *draws* annotations; this layer exists only so they can be
 * grabbed. It therefore has to place its boxes exactly where the compositor draws
 * them, so it applies the same background padding inset as `appearance.ts` — in
 * percentages, so the two stay aligned at any preview size.
 */
export function AnnotationLayer({ project, playheadMs, edit }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    // A deleted or never-visible annotation must not stay selected, or the inspector
    // would keep editing something that is not on screen.
    if (selectedId && !project?.annotations.some((a) => a.id === selectedId)) {
      setSelectedId(null);
    }
  }, [project, selectedId]);

  if (!project) return null;

  const visible = annotationsAt(project, playheadMs);
  const selected = project.annotations.find((a) => a.id === selectedId) ?? null;

  const add = (type: AnnotationType) => {
    edit(
      ops.addAnnotation({
        startMs: playheadMs,
        endMs: playheadMs + NEW_ANNOTATION_MS,
        type,
        textContent: type === "text" ? "输入文字" : "",
        position: { x: 0.5, y: 0.5 },
        size: type === "text" ? NEW_TEXT_SIZE : NEW_ARROW_SIZE,
        style: { ...DEFAULT_ANNOTATION_STYLE },
        rotation: 0,
      }),
    );
  };

  return (
    <>
      <div className="pointer-events-none absolute inset-0">
        {visible.map((annotation) => (
          <AnnotationBox
            key={annotation.id}
            annotation={annotation}
            padding={project.background.padding}
            selected={annotation.id === selectedId}
            onSelect={() => setSelectedId(annotation.id)}
            edit={edit}
          />
        ))}
      </div>

      {/* Controls sit below the frame so they never cover what is being composed. */}
      <div className="absolute inset-x-2 bottom-2 flex flex-wrap items-center gap-1.5 rounded-lg bg-panel/95 p-1.5 backdrop-blur">
        <Button size="small" icon={<PlusOutlined />} onClick={() => add("text")}>
          文字
        </Button>
        <Button size="small" icon={<PlusOutlined />} onClick={() => add("arrow")}>
          箭头
        </Button>

        {selected ? (
          <>
            <Input
              size="small"
              className="w-[150px]"
              value={selected.textContent}
              disabled={selected.type === "arrow"}
              onChange={(e) =>
                edit(ops.updateAnnotation(selected.id, { textContent: e.target.value }))
              }
              placeholder={selected.type === "text" ? "文字内容" : "箭头无文字"}
            />
            <Tooltip title="颜色">
              <ColorPicker
                size="small"
                value={selected.style.color}
                onChange={(c) =>
                  edit(
                    ops.updateAnnotation(selected.id, {
                      style: { ...selected.style, color: c.toHexString() },
                    }),
                  )
                }
              />
            </Tooltip>
            <InputNumber
              size="small"
              className="w-[74px]"
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
            <InputNumber
              size="small"
              className="w-[80px]"
              min={0}
              max={359}
              value={Math.round(selected.rotation)}
              onChange={(v) =>
                edit((p) => {
                  const ann = p.annotations.find((a) => a.id === selected.id);
                  if (!ann) return p;
                  const rotated = setRotation(ann, Number(v ?? 0));
                  return ops.updateAnnotation(ann.id, { rotation: rotated.rotation })(p);
                })
              }
              addonAfter="°"
            />
            <Select
              size="small"
              className="w-[118px]"
              value={selected.endMs}
              onChange={(v) => edit(ops.updateAnnotation(selected.id, { endMs: v }))}
              options={endOptions(playheadMs, selected.endMs, durationMs(project))}
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
            点选画面里的注释即可拖动、缩放、旋转；新加的文字只出现在播放头之后{" "}
            {NEW_ANNOTATION_MS / 1000}s 内。
          </Text>
        )}
      </div>
    </>
  );
}

/**
 * One annotation the user can drag, resize and rotate.
 *
 * Position and size are written back as fractions of the video box — the same space the
 * compositor reads from — so dragging here moves the drawn annotation by exactly the
 * distance dragged, at any preview size. The drag is committed on pointer-up so a
 * gesture produces one undo step rather than one per frame.
 */
function AnnotationBox({
  annotation,
  padding,
  selected,
  onSelect,
  edit,
}: {
  annotation: AnnotationRegion;
  padding: number;
  selected: boolean;
  onSelect: () => void;
  edit: (fn: (project: Project) => Project) => void;
}) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<
    | { kind: "move"; startX: number; startY: number; origin: AnnotationRegion }
    | { kind: "resize"; startX: number; startY: number; handle: AnnotationHandle; origin: AnnotationRegion }
    | null
  >(null);
  const [draft, setDraft] = useState<AnnotationRegion | null>(null);

  const shown = draft ?? annotation;
  const box = annotationBox(shown);

  const boxFrac = Math.max(0.01, 1 - padding * 2);

  /** Pixel size of the video box inside the frame, for turning a drag into a fraction. */
  const videoBoxSize = () => {
    const el = layerRef.current?.parentElement;
    const rect = el?.getBoundingClientRect();
    return {
      w: Math.max(1, (rect?.width ?? 1) * boxFrac),
      h: Math.max(1, (rect?.height ?? 1) * boxFrac),
    };
  };

  const begin = (e: React.PointerEvent, kind: "move" | AnnotationHandle) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    onSelect();
    drag.current =
      kind === "move"
        ? { kind: "move", startX: e.clientX, startY: e.clientY, origin: annotation }
        : { kind: "resize", startX: e.clientX, startY: e.clientY, handle: kind, origin: annotation };
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const { w, h } = videoBoxSize();
    const dx = (e.clientX - d.startX) / w;
    const dy = (e.clientY - d.startY) / h;
    setDraft(
      d.kind === "move"
        ? moveAnnotation(d.origin, dx, dy)
        : resizeAnnotation(d.origin, d.handle, dx, dy),
    );
  };

  const finish = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || !draft) {
      setDraft(null);
      return;
    }
    // `applyEdit` drops a patch that changes nothing, so a click without a drag does
    // not consume an undo step.
    edit(ops.updateAnnotation(annotation.id, { position: draft.position, size: draft.size }));
    setDraft(null);
  };

  const leftPct = (padding + box.x * boxFrac) * 100;
  const topPct = (padding + box.y * boxFrac) * 100;
  const widthPct = box.width * boxFrac * 100;
  const heightPct = box.height * boxFrac * 100;
  const handlePx = Math.max(8, widthPct * HANDLE_FRACTION);

  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0">
      <div
        className={`pointer-events-auto absolute cursor-move border border-dashed ${
          selected ? "border-rec bg-rec/10" : "border-transparent hover:border-ink/40"
        }`}
        style={{
          left: `${leftPct}%`,
          top: `${topPct}%`,
          width: `${widthPct}%`,
          height: `${heightPct}%`,
          transform: `translate(-50%, -50%) rotate(${shown.rotation}deg)`,
        }}
        onPointerDown={(e) => begin(e, "move")}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={finish}
        title={annotation.type === "text" ? annotation.textContent : "箭头"}
      >
        {selected &&
          HANDLES.map((handle) => (
            <span
              key={handle}
              className="absolute cursor-nwse-resize rounded-full border border-rec bg-canvas"
              style={{
                width: handlePx,
                height: handlePx,
                left: handle === "nw" || handle === "sw" ? -handlePx / 2 : undefined,
                right: handle === "ne" || handle === "se" ? -handlePx / 2 : undefined,
                top: handle === "nw" || handle === "ne" ? -handlePx / 2 : undefined,
                bottom: handle === "sw" || handle === "se" ? -handlePx / 2 : undefined,
              }}
              onPointerDown={(e) => begin(e, handle)}
              onPointerMove={move}
              onPointerUp={finish}
            />
          ))}
      </div>
    </div>
  );
}

/** "Ends at" choices: a few convenient offsets, plus whatever the annotation has. */
function endOptions(playheadMs: number, currentEndMs: number, totalMs: number) {
  const options = [1000, 2000, 3000, 5000]
    .map((ms) => Math.round(playheadMs + ms))
    .filter((value) => value <= totalMs)
    .map((value) => ({ value, label: `播放头 +${(value - playheadMs) / 1000}s` }));
  if (!options.some((o) => o.value === Math.round(currentEndMs))) {
    options.push({ value: Math.round(currentEndMs), label: `当前 ${Math.round(currentEndMs)}ms` });
  }
  return options;
}

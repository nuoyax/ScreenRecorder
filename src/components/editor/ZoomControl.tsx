import { Button, InputNumber, List, Select, Slider, Typography } from "antd";
import { DeleteOutlined, PlusOutlined, ThunderboltOutlined } from "@ant-design/icons";
import type { Project } from "@/lib/editor/state";
import { durationMs, ops, zoomAt } from "@/lib/editor/state";
import { ZOOM_DEPTH_SCALES, type ZoomDepth } from "@/lib/timeline/types";
import { formatTimecode } from "@/lib/timeline/time";
import type { ZoomSuggestion } from "@/lib/editor/zoomSuggest";

const { Text } = Typography;

type Props = {
  project: Project;
  playheadMs: number;
  edit: (fn: (project: Project) => Project) => void;
  /** Cursor-derived suggestions, or `null` when the recording has no track. */
  suggestions: ZoomSuggestion[] | null;
  onApply: (suggestion: ZoomSuggestion) => void;
  onApplyAll: () => void;
};

/**
 * Zoom regions: what is there, what is suggested, and the parameters of both.
 *
 * The suggestion list is shown rather than applied automatically. Auto-zooming a
 * recording changes every frame of it, and a user who did not ask for that would have
 * to hunt down and delete each region — offering them costs one click instead.
 */
export function ZoomControl({
  project,
  playheadMs,
  edit,
  suggestions,
  onApply,
  onApplyAll,
}: Props) {
  const total = durationMs(project);
  const active = zoomAt(project, playheadMs);

  return (
    <div>
      <div className="mb-2 flex gap-2">
        <Button
          size="small"
          icon={<PlusOutlined />}
          onClick={() =>
            edit(
              ops.addZoom({ startMs: playheadMs, endMs: playheadMs + 2000 }, 3, {
                cx: 0.5,
                cy: 0.5,
              }),
            )
          }
        >
          在播放头加一段
        </Button>
      </div>

      {project.zooms.length === 0 ? (
        <p className="mb-2 text-xs text-muted">还没有缩放区段。</p>
      ) : (
        <List
          size="small"
          dataSource={project.zooms}
          renderItem={(zoom) => (
            <List.Item className={`!rounded-lg !border-none !px-2 ${zoom === active ? "!bg-ctl" : ""}`}>
              <div className="w-full">
                <div className="flex items-center gap-2 text-xs">
                  <span className="flex-1 truncate tabular-nums">
                    {formatTimecode(zoom.startMs)} → {formatTimecode(zoom.endMs)}
                  </span>
                  <Select
                    size="small"
                    className="w-[70px]"
                    value={zoom.depth}
                    onChange={(v) =>
                      edit((p) => ({
                        ...p,
                        zooms: p.zooms.map((z) =>
                          z.id === zoom.id ? { ...z, depth: v as ZoomDepth } : z,
                        ),
                      }))
                    }
                    options={([1, 2, 3, 4, 5, 6] as ZoomDepth[]).map((d) => ({
                      value: d,
                      label: `${ZOOM_DEPTH_SCALES[d]}×`,
                    }))}
                  />
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => edit(ops.removeZoom(zoom.id))}
                  />
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11px]">
                  <span className="w-[52px] shrink-0 text-muted">焦点 X</span>
                  <Slider
                    className="!m-0 flex-1"
                    min={0}
                    max={1}
                    step={0.01}
                    value={zoom.focus.cx}
                    onChange={(v) =>
                      edit((p) => ({
                        ...p,
                        zooms: p.zooms.map((z) =>
                          z.id === zoom.id ? { ...z, focus: { ...z.focus, cx: v } } : z,
                        ),
                      }))
                    }
                  />
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[11px]">
                  <span className="w-[52px] shrink-0 text-muted">焦点 Y</span>
                  <Slider
                    className="!m-0 flex-1"
                    min={0}
                    max={1}
                    step={0.01}
                    value={zoom.focus.cy}
                    onChange={(v) =>
                      edit((p) => ({
                        ...p,
                        zooms: p.zooms.map((z) =>
                          z.id === zoom.id ? { ...z, focus: { ...z.focus, cy: v } } : z,
                        ),
                      }))
                    }
                  />
                </div>
                <div className="mt-1 flex items-center gap-1 text-[11px]">
                  <InputNumber
                    size="small"
                    className="w-[84px]"
                    min={0}
                    max={zoom.endMs - 200}
                    step={100}
                    value={zoom.startMs}
                    onChange={(v) => edit(ops.resizeZoom(zoom.id, "start", Number(v ?? zoom.startMs)))}
                    addonAfter="ms"
                  />
                  <InputNumber
                    size="small"
                    className="w-[84px]"
                    min={zoom.startMs + 200}
                    max={total}
                    step={100}
                    value={zoom.endMs}
                    onChange={(v) => edit(ops.resizeZoom(zoom.id, "end", Number(v ?? zoom.endMs)))}
                    addonAfter="ms"
                  />
                </div>
              </div>
            </List.Item>
          )}
        />
      )}

      {suggestions === null ? (
        <p className="mt-3 text-[11px] text-muted">
          这次录制没有光标轨迹，无法给出缩放建议。
        </p>
      ) : suggestions.length === 0 ? (
        <p className="mt-3 text-[11px] text-muted">
          光标轨迹里没有值得放大的时刻——建议只覆盖「快速移动」和「长时间停留」两类。
        </p>
      ) : (
        <div className="mt-3 rounded-lg bg-panel p-2">
          <div className="flex items-center gap-2">
            <ThunderboltOutlined className="text-rec" />
            <Text type="secondary" className="flex-1 text-xs">
              根据光标轨迹的建议（{suggestions.length}）
            </Text>
            <Button size="small" onClick={onApplyAll}>
              全部添加
            </Button>
          </div>
          <List
            size="small"
            dataSource={suggestions}
            renderItem={(s) => (
              <List.Item className="!border-none !px-0 !py-1">
                <div className="flex w-full items-center gap-2 text-[11px]">
                  <span className="flex-1 truncate tabular-nums">
                    {formatTimecode(s.startMs)} → {formatTimecode(s.endMs)}
                    <span className="ml-1 text-muted">
                      {s.reason === "movement" ? "快速移动" : "停留"} · {s.travelPx}px
                    </span>
                  </span>
                  <Button size="small" type="link" className="!px-0" onClick={() => onApply(s)}>
                    添加
                  </Button>
                </div>
              </List.Item>
            )}
          />
        </div>
      )}
    </div>
  );
}

import { Button, InputNumber, List, Select, Slider, Typography } from "antd";
import { DeleteOutlined, ScissorOutlined } from "@ant-design/icons";
import type { Project } from "@/lib/editor/state";
import { durationMs, ops } from "@/lib/editor/state";
import { getClipSourceEndMs, getClipSourceStartMs } from "@/lib/timeline/types";
import { SPEED_OPTIONS, type PlaybackSpeed } from "@/lib/timeline/types";
import { formatTimecode } from "@/lib/timeline/time";

const { Text } = Typography;

type Props = {
  project: Project;
  selectedClipId: string | null;
  onSelect: (id: string | null) => void;
  edit: (fn: (project: Project) => Project) => void;
};

/**
 * The clip list: cut, delete, retime.
 *
 * Every row shows the source range it reads from as well as its timeline position,
 * because after a split or a speed change those two are *different numbers* and the
 * source range is the one that explains what the clip will actually show.
 */
export function ClipList({ project, selectedClipId, onSelect, edit }: Props) {
  return (
    <div>
      <div className="mb-2 flex gap-2">
        <Button
          size="small"
          icon={<ScissorOutlined />}
          disabled={project.clips.length === 0}
          onClick={() => onSelect(project.clips[0]?.id ?? null)}
        >
          选中首段
        </Button>
        <Button
          size="small"
          danger
          icon={<DeleteOutlined />}
          disabled={!selectedClipId || project.clips.length <= 1}
          onClick={() => selectedClipId && edit(ops.deleteClip(selectedClipId))}
        >
          删除
        </Button>
      </div>

      <List
        size="small"
        dataSource={project.clips}
        renderItem={(clip) => {
          const selected = clip.id === selectedClipId;
          return (
            <List.Item
              className={`!cursor-pointer !rounded-lg !border-none !px-2 ${
                selected ? "!bg-ctl ring-1 ring-rec" : "hover:!bg-ctl"
              }`}
              onClick={() => onSelect(clip.id)}
            >
              <div className="w-full min-w-0">
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate">
                    {formatTimecode(clip.startMs)} → {formatTimecode(clip.endMs)}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted">
                    源 {formatTimecode(getClipSourceStartMs(clip))}–
                    {formatTimecode(getClipSourceEndMs(clip))}
                  </span>
                </div>
                {selected && (
                  <div className="mt-1.5 flex items-center gap-2">
                    <Text type="secondary" className="text-[11px]">
                      速度
                    </Text>
                    <Select
                      size="small"
                      className="w-[88px]"
                      value={clip.speed}
                      onChange={(v) => edit(ops.setClipSpeed(clip.id, v as PlaybackSpeed))}
                      options={SPEED_OPTIONS.map((o) => ({ value: o.speed, label: o.label }))}
                    />
                  </div>
                )}
              </div>
            </List.Item>
          );
        }}
      />

      <TrimControl project={project} edit={edit} />

      {project.zooms.length > 0 && (
        <div className="mt-3">
          <Text type="secondary" className="text-xs">
            缩放区段（{project.zooms.length}）
          </Text>
          <List
            size="small"
            dataSource={project.zooms}
            renderItem={(zoom) => (
              <List.Item className="!border-none !px-2 !py-1">
                <div className="flex w-full items-center gap-2 text-xs">
                  <span className="flex-1 truncate tabular-nums">
                    {formatTimecode(zoom.startMs)} → {formatTimecode(zoom.endMs)}
                  </span>
                  <Select
                    size="small"
                    className="w-[64px]"
                    value={zoom.depth}
                    onChange={(v) =>
                      edit((p) => ({
                        ...p,
                        zooms: p.zooms.map((z) => (z.id === zoom.id ? { ...z, depth: v } : z)),
                      }))
                    }
                    options={[1, 2, 3, 4, 5, 6].map((d) => ({ value: d, label: `${d}×` }))}
                  />
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => edit(ops.removeZoom(zoom.id))}
                  />
                </div>
              </List.Item>
            )}
          />
        </div>
      )}

      {project.annotations.length > 0 && (
        <div className="mt-3">
          <Text type="secondary" className="text-xs">
            注释（{project.annotations.length}）
          </Text>
          <List
            size="small"
            dataSource={project.annotations}
            renderItem={(ann) => (
              <List.Item className="!border-none !px-2 !py-1">
                <div className="flex w-full items-center gap-2 text-xs">
                  <span className="flex-1 truncate tabular-nums">
                    {formatTimecode(ann.startMs)} → {formatTimecode(ann.endMs)}{" "}
                    {ann.type === "text" ? ann.textContent.slice(0, 12) : "箭头"}
                  </span>
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => edit(ops.removeAnnotation(ann.id))}
                  />
                </div>
              </List.Item>
            )}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Keep only `[startMs, endMs]` of the recording.
 *
 * Deliberately destructive to the clip list rather than additive: the common case is
 * "cut the dead time off both ends", and expressing that as one edit keeps it a
 * single undo step. Undo brings the full recording back.
 */
function TrimControl({
  project,
  edit,
}: {
  project: Project;
  edit: (fn: (project: Project) => Project) => void;
}) {
  const total = durationMs(project);
  const clip = project.clips[0];
  const start = getClipSourceStartMs(clip);
  const end = Math.min(project.sourceDurationMs, getClipSourceEndMs(clip));

  return (
    <div className="mt-3 rounded-lg bg-panel p-2">
      <Text type="secondary" className="text-xs">
        裁剪首尾
      </Text>
      <div className="mt-1 flex items-center gap-2 text-xs">
        <span className="text-muted">入点</span>
        <InputNumber
          size="small"
          className="w-[92px]"
          min={0}
          max={Math.max(0, end - 200)}
          step={100}
          value={Math.round(start)}
          onChange={(v) => {
            const next = Number(v ?? 0);
            edit(ops.trimTo(next, end));
          }}
          addonAfter="ms"
        />
        <span className="text-muted">出点</span>
        <InputNumber
          size="small"
          className="w-[92px]"
          min={Math.min(project.sourceDurationMs, start + 200)}
          max={project.sourceDurationMs}
          step={100}
          value={Math.round(end)}
          onChange={(v) => edit(ops.trimTo(start, Number(v ?? total)))}
          addonAfter="ms"
        />
      </div>
      <Slider
        className="mt-1"
        range
        min={0}
        max={Math.max(1, project.sourceDurationMs)}
        value={[Math.round(start), Math.round(end)]}
        onChange={([a, b]) => edit(ops.trimTo(a, b))}
        tooltip={{ formatter: (v) => formatTimecode(Number(v ?? 0)) }}
      />
    </div>
  );
}

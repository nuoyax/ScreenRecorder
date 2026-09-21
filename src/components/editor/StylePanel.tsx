import { Button, InputNumber, Select, Slider, Switch, Typography } from "antd";
import type { Project } from "@/lib/editor/state";
import { ops, zoomAt } from "@/lib/editor/state";
import {
  BACKGROUND_PRESETS,
  DEFAULT_ANNOTATION_STYLE,
  ZOOM_DEPTH_SCALES,
  type ZoomDepth,
} from "@/lib/timeline/types";
import { formatTimecode } from "@/lib/timeline/time";

const { Text } = Typography;

type Props = {
  project: Project;
  playheadMs: number;
  edit: (fn: (project: Project) => Project) => void;
};

/**
 * Style inspector: backdrop, the zoom under the playhead, and cursor behaviour.
 *
 * Everything shown here is something the canvas compositor implements, so nothing in
 * this panel can promise an effect the renderer ignores.
 */
export function StylePanel({ project, playheadMs, edit }: Props) {
  const zoom = zoomAt(project, playheadMs);

  return (
    <div className="space-y-3">
      <section>
        <Text type="secondary" className="text-xs">
          背景
        </Text>
        <div className="mt-1 grid grid-cols-3 gap-1.5">
          {BACKGROUND_PRESETS.map((preset) => {
            const active =
              preset.style.color === project.background.color &&
              preset.style.gradient === project.background.gradient;
            return (
              <Button
                key={preset.id}
                size="small"
                className={active ? "ring-2 ring-rec" : ""}
                onClick={() => edit(ops.setBackground(preset.style))}
              >
                {preset.label}
              </Button>
            );
          })}
        </div>

        <Row label="内边距">
          <Slider
            className="m-0 w-[130px]"
            min={0}
            max={0.15}
            step={0.005}
            value={project.background.padding}
            onChange={(v) => edit(ops.setBackground({ padding: v }))}
            tooltip={{ formatter: (v) => `${(Number(v ?? 0) * 100).toFixed(1)}%` }}
          />
        </Row>
        <Row label="圆角">
          <Slider
            className="m-0 w-[130px]"
            min={0}
            max={0.2}
            step={0.005}
            value={project.background.radius}
            onChange={(v) => edit(ops.setBackground({ radius: v }))}
            tooltip={{ formatter: (v) => `${(Number(v ?? 0) * 100).toFixed(1)}%` }}
          />
        </Row>
        <Row label="阴影">
          <Switch
            size="small"
            checked={project.background.shadow}
            onChange={(v) => edit(ops.setBackground({ shadow: v }))}
          />
        </Row>
      </section>

      <section>
        <Text type="secondary" className="text-xs">
          缩放 @ {formatTimecode(playheadMs)}
        </Text>
        {zoom ? (
          <div className="mt-1">
            <Row label="倍率">
              <Select
                size="small"
                className="w-[80px]"
                value={zoom.depth}
                onChange={(v) =>
                  edit((p) => ({
                    ...p,
                    zooms: p.zooms.map((z) => (z.id === zoom.id ? { ...z, depth: v as ZoomDepth } : z)),
                  }))
                }
                options={([1, 2, 3, 4, 5, 6] as ZoomDepth[]).map((d) => ({
                  value: d,
                  label: `${ZOOM_DEPTH_SCALES[d]}×`,
                }))}
              />
            </Row>
            <Row label="水平焦点">
              <Slider
                className="m-0 w-[130px]"
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
            </Row>
            <Row label="垂直焦点">
              <Slider
                className="m-0 w-[130px]"
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
            </Row>
            <Row label="起点 / 终点 (ms)">
              <div className="flex gap-1">
                <InputNumber
                  size="small"
                  className="w-[76px]"
                  value={zoom.startMs}
                  min={0}
                  max={zoom.endMs - 200}
                  onChange={(v) =>
                    edit(ops.resizeZoom(zoom.id, "start", Number(v ?? zoom.startMs)))
                  }
                />
                <InputNumber
                  size="small"
                  className="w-[76px]"
                  value={zoom.endMs}
                  min={zoom.startMs + 200}
                  onChange={(v) => edit(ops.resizeZoom(zoom.id, "end", Number(v ?? zoom.endMs)))}
                />
              </div>
            </Row>
            <Button
              size="small"
              danger
              className="mt-1 w-full"
              onClick={() => edit(ops.removeZoom(zoom.id))}
            >
              删除该缩放
            </Button>
          </div>
        ) : (
          <p className="mt-1 text-xs text-muted">播放头不在任何缩放区段内。</p>
        )}
      </section>

      <section>
        <Text type="secondary" className="text-xs">
          注释默认样式
        </Text>
        <p className="mt-1 text-[11px] text-muted">
          新建的文本注释使用这套样式：字号 {DEFAULT_ANNOTATION_STYLE.fontSize}px，
          {DEFAULT_ANNOTATION_STYLE.fontWeight === "bold" ? "粗体" : "常规"}。
          单条注释的颜色在预览里直接调整。
        </p>
      </section>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-1 flex min-h-7 items-center justify-between gap-2">
      <span className="shrink-0 text-xs text-muted">{label}</span>
      {children}
    </div>
  );
}

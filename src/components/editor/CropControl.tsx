import { Button, InputNumber, Segmented, Typography } from "antd";
import { BorderOutlined, ExpandOutlined, FullscreenOutlined } from "@ant-design/icons";
import type { Project } from "@/lib/editor/state";
import type { CropRect } from "@/lib/editor/state";

const { Text } = Typography;

type Props = {
  project: Project;
  edit: (fn: (project: Project) => Project) => void;
};

/** Preset crops, as fractions of the source frame. */
const PRESETS: Array<{ id: string; label: string; icon: React.ReactNode; rect: CropRect }> = [
  {
    id: "full",
    label: "全画面",
    icon: <FullscreenOutlined />,
    rect: { x: 0, y: 0, width: 1, height: 1 },
  },
  {
    id: "padded",
    label: "内缩 5%",
    icon: <BorderOutlined />,
    rect: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 },
  },
  {
    id: "center80",
    label: "中间 80%",
    icon: <ExpandOutlined />,
    rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
  },
];

/**
 * Spatial crop: which part of the recording is shown at all.
 *
 * This is the non-destructive counterpart to the clip list's "cut both ends". Cutting
 * time is already the clips' job; what is missing is cutting *space* — recording a full
 * screen and then dropping the browser chrome off the top. Expressed as fractions of
 * the source frame, so it composes with zoom (the crop picks the base rectangle, zoom
 * picks a smaller one inside it) and survives an export at any output size.
 */
export function CropControl({ project, edit }: Props) {
  const crop = project.crop;

  const patch = (partial: Partial<CropRect>) =>
    edit((p) => ({ ...p, crop: normalizeCrop({ ...p.crop, ...partial }) }));

  return (
    <div className="rounded-lg bg-panel p-2">
      <div className="flex items-center gap-2">
        <ExpandOutlined className="text-rec" />
        <Text type="secondary" className="flex-1 text-xs">
          画面裁剪
        </Text>
        <Button size="small" onClick={() => patch(PRESETS[0].rect)}>
          重置
        </Button>
      </div>

      <div className="mt-1.5 flex items-center gap-1 text-[11px]">
        {(["x", "y", "width", "height"] as const).map((key) => (
          <label key={key} className="flex flex-1 items-center gap-1">
            <span className="text-muted">
              {key === "x" ? "X" : key === "y" ? "Y" : key === "width" ? "宽" : "高"}
            </span>
            <InputNumber
              size="small"
              className="w-full"
              min={key === "width" || key === "height" ? 0.1 : 0}
              max={1}
              step={0.01}
              value={Number(crop[key].toFixed(3))}
              onChange={(v) => patch({ [key]: Number(v ?? crop[key]) } as Partial<CropRect>)}
            />
          </label>
        ))}
      </div>

      {/* A miniature of the source with the kept rectangle drawn over it. */}
      <div className="relative mt-1.5 aspect-video w-full rounded border border-ctl bg-canvas">
        <div
          className="absolute border border-rec bg-rec/20"
          style={{
            left: `${crop.x * 100}%`,
            top: `${crop.y * 100}%`,
            width: `${crop.width * 100}%`,
            height: `${crop.height * 100}%`,
          }}
        />
      </div>

      <div className="mt-1.5">
        <Segmented
          size="small"
          block
          value={matchPreset(crop)}
          onChange={(v) => {
            const preset = PRESETS.find((p) => p.id === v);
            if (preset) patch(preset.rect);
          }}
          options={PRESETS.map((p) => ({
            value: p.id,
            label: (
              <span className="inline-flex items-center gap-1">
                {p.icon}
                {p.label}
              </span>
            ),
          }))}
        />
      </div>

      <p className="mt-1.5 text-[11px] text-muted">
        输出尺寸按裁剪后的宽高比计算；裁剪与缩放叠加，缩放作用于裁剪后的画面。
      </p>
    </div>
  );
}

/** Snap a crop back into the frame and keep it from collapsing to nothing. */
function normalizeCrop(rect: CropRect): CropRect {
  const width = clamp01(rect.width, 0.05, 1);
  const height = clamp01(rect.height, 0.05, 1);
  return {
    width,
    height,
    x: clamp01(rect.x, 0, 1 - width),
    y: clamp01(rect.y, 0, 1 - height),
  };
}

function clamp01(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function matchPreset(crop: CropRect): string {
  const preset = PRESETS.find(
    (p) =>
      Math.abs(p.rect.x - crop.x) < 1e-6 &&
      Math.abs(p.rect.y - crop.y) < 1e-6 &&
      Math.abs(p.rect.width - crop.width) < 1e-6 &&
      Math.abs(p.rect.height - crop.height) < 1e-6,
  );
  return preset?.id ?? "";
}

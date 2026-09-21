import { useState } from "react";
import { Alert, Button, Card, Select, Tag, Typography } from "antd";
import type { RefObject } from "react";
import type { Project } from "@/lib/editor/state";
import { durationMs } from "@/lib/editor/state";
import {
  EXPORT_QUALITIES,
  exportBitrateBps,
  formatBitrate,
  sourceBitrateBps,
  type ExportQuality,
} from "@/lib/export/bitrate";
import { formatTimecode } from "@/lib/timeline/time";
import type { MouseTrack } from "@/lib/api";

const { Text } = Typography;

type Props = {
  project: Project;
  playheadMs: number;
  videoRef: RefObject<HTMLVideoElement | null>;
  track: MouseTrack | null;
};

/** Composition size the exporter renders at. Matches the editor preview. */
const EXPORT_W = 1280;
const EXPORT_H = 720;

/**
 * Export inspector.
 *
 * The bitrate line below is real — it comes from the same `exportBitrateBps` the
 * transcoder will use, so the number shown here is the number that gets encoded. The
 * action buttons are not wired yet: the export commands land in the next task, and a
 * button that looks ready but writes nothing would be worse than a disabled one.
 */
export function ExportPanel({ project, playheadMs, videoRef, track }: Props) {
  const [quality, setQuality] = useState<ExportQuality>("high");
  const [fps, setFps] = useState(project.fps || 30);

  const sourceBps = sourceBitrateBps(project.sourceWidth, project.sourceHeight);
  const targetBps = exportBitrateBps({
    width: EXPORT_W,
    height: EXPORT_H,
    fps,
    quality,
    source: {
      width: project.sourceWidth,
      height: project.sourceHeight,
      bitrateBps: sourceBps,
    },
  });

  return (
    <div className="space-y-3">
      <Card size="small" className="!bg-panel" styles={{ body: { padding: 10 } }}>
        <Text type="secondary" className="text-xs">
          成片
        </Text>
        <div className="mt-1 space-y-1 text-xs">
          <Line label="时长" value={formatTimecode(durationMs(project))} />
          <Line label="合成尺寸" value={`${EXPORT_W} × ${EXPORT_H}`} />
          <Line label="源" value={`${project.sourceWidth} × ${project.sourceHeight}`} />
          <Line label="片段" value={`${project.clips.length} 段`} />
          <Line label="缩放区 / 注释" value={`${project.zooms.length} / ${project.annotations.length}`} />
          <Line
            label="光标轨迹"
            value={track ? `${track.moves.length} 采样` : "无（未录制轨迹）"}
          />
        </div>
      </Card>

      <Card size="small" className="!bg-panel" styles={{ body: { padding: 10 } }}>
        <Text type="secondary" className="text-xs">
          转码为 MP4
        </Text>
        <div className="mt-1 flex items-center gap-2">
          <Select
            size="small"
            className="w-[128px]"
            value={quality}
            onChange={(v) => setQuality(v as ExportQuality)}
            options={EXPORT_QUALITIES.map((q) => ({ value: q.id, label: q.label }))}
          />
          <Select
            size="small"
            className="w-[80px]"
            value={fps}
            onChange={setFps}
            options={[24, 30, 60].map((v) => ({ value: v, label: `${v} fps` }))}
          />
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-xs">
          <span className="text-muted">目标码率</span>
          <Tag color="blue">{formatBitrate(targetBps)}</Tag>
          <span className="text-muted">源约 {formatBitrate(sourceBps)}</span>
        </div>
        <Button className="mt-2" size="small" block disabled>
          转码（需 ffmpeg，下一任务接通）
        </Button>
      </Card>

      <Card size="small" className="!bg-panel" styles={{ body: { padding: 10 } }}>
        <Text type="secondary" className="text-xs">
          动图 / 贴纸
        </Text>
        <div className="mt-1 flex gap-1.5">
          <Button size="small" className="flex-1" disabled>
            GIF
          </Button>
          <Button size="small" className="flex-1" disabled>
            PNG
          </Button>
          <Button size="small" className="flex-1" disabled>
            IMG_
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-muted">
          这三项从当前预览画面取帧，因此会自动带上背景、缩放、注释与光标叠加。导出命令在下一任务接通。
        </p>
      </Card>

      <Alert
        type="info"
        showIcon
        message="MV（自有编码器）"
        description={
          <span className="text-[11px]">
            计划只做序列层：拼接、裁剪、多音轨混音。缩放/注释/背景不进 MV，它们只进 GIF / PNG /
            IMG_。此处如实标注，避免把它当成完整成片导出。
          </span>
        }
      />

      <p className="text-[11px] text-muted">
        播放头 {formatTimecode(playheadMs)}；导出范围始终是整条时间轴，不受播放头影响。
        {videoRef.current ? "" : "（预览尚未就绪）"}
      </p>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

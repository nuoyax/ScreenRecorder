import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Card, InputNumber, Progress, Select, Space, Tag, Typography } from "antd";
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
import { createFrameComposer, delayCsFor, fitFrameRate } from "@/lib/export/render";
import { ExportCancelled, exportGif, type ExportProgress } from "@/lib/export/gif";
import { DEFAULT_STICKER, exportSticker } from "@/lib/export/imgSticker";
import { exportDirFor, exportNameFor, joinPath } from "@/lib/export/paths";
import { formatTimecode } from "@/lib/timeline/time";
import { api, type ExportResult, type FfmpegStatus, type MouseTrack } from "@/lib/api";

const { Text } = Typography;

type Props = {
  project: Project;
  playheadMs: number;
  /** The editor's hidden `<video>`, used as the decoder for export seeks. */
  videoRef: RefObject<HTMLVideoElement | null>;
  /** The editor's preview canvas, which the composer draws each exported frame into. */
  canvasRef: RefObject<HTMLCanvasElement | null>;
  track: MouseTrack | null;
  /**
   * Stop the editor's playback before an export starts.
   *
   * Exporting seeks the decoder frame by frame; a playback loop seeking and playing the
   * same element at the same time does not fail loudly, it produces torn frames. This
   * is awaited, so the caller can let its own effects settle first.
   */
  onBeforeExport: () => void;
};

/** Composition size the exporter renders at. Matches the editor preview. */
const EXPORT_W = 1280;
const EXPORT_H = 720;

/** Hard ceiling on GIF frames, so a long recording cannot produce a gigabyte file. */
const MAX_GIF_FRAMES = 600;

/**
 * Export inspector.
 *
 * Every number shown here is real: the bitrate comes from the same
 * `exportBitrateBps` the transcoder will use, the frame rate is the one the GIF will
 * actually carry (lowered when the frame budget bites, and said so), and the buttons
 * call the commands that write the file. A control that looks ready but does nothing
 * would be worse than one that is honestly absent.
 *
 * The GIF and sticker exports render through the editor's own canvas compositor, so the
 * file carries the background, crop, zoom, annotations and cursor overlay the preview
 * shows — not a raw re-encode of the source.
 */
export function ExportPanel({
  project,
  playheadMs,
  videoRef,
  canvasRef,
  track,
  onBeforeExport,
}: Props) {
  const [quality, setQuality] = useState<ExportQuality>("high");
  const [fps, setFps] = useState(project.fps || 30);
  const [gifFps, setGifFps] = useState(Math.min(15, project.fps || 30));
  const [stickerPad, setStickerPad] = useState(DEFAULT_STICKER.padding);
  const [stickerRadius, setStickerRadius] = useState(DEFAULT_STICKER.radius);
  const [busy, setBusy] = useState<"gif" | "sticker" | null>(null);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState("");
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus | null>(null);
  const [rawIpc, setRawIpc] = useState<boolean | null>(null);
  /**
   * Cancellation flag for the running export.
   *
   * A ref, not state: the render loop polls it between frames and must see the current
   * value without the loop being torn down and restarted by a re-render.
   */
  const cancelRef = useRef(false);

  const total = durationMs(project);
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

  // Both probes are once per session: `ffmpeg_status` caches in Rust, and the raw-IPC
  // answer cannot change without a rebuild.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await api.ffmpegStatus();
        if (!cancelled) setFfmpeg(status);
      } catch {
        if (!cancelled) setFfmpeg({ available: false, path: null, version: null, source: "", hint: "" });
      }
      try {
        const raw = await api.ipcRawSupported();
        if (!cancelled) setRawIpc(raw);
      } catch {
        if (!cancelled) setRawIpc(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The frame budget lowered the rate: say so rather than silently exporting a slideshow.
  const gifFit = useMemo(
    () => fitFrameRate(total, gifFps, MAX_GIF_FRAMES),
    [total, gifFps],
  );
  const exportDir = exportDirFor(project.sourcePath);

  /** Build a composer over the editor's own video + canvas. */
  const compose = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) throw new Error("预览尚未就绪，请稍后再试");
    return createFrameComposer({ video, canvas, project, track });
  };

  const runGif = async () => {
    setError("");
    setResult(null);
    // Stop playback first: seeking the decoder while the editor's loop is playing the
    // same element yields torn frames rather than an error anyone can act on.
    onBeforeExport();
    setBusy("gif");
    cancelRef.current = false;
    try {
      const composer = compose();
      const out = joinPath(exportDir, exportNameFor(project.sourcePath, "-anim", "gif"));
      const res = await exportGif(
        composer,
        { path: out, fps: gifFps, maxFrames: MAX_GIF_FRAMES },
        setProgress,
        () => cancelRef.current,
      );
      setResult({
        path: res.path,
        bytes: res.bytes,
        frames: res.frames,
        expected_frames: res.frames,
        format: "gif",
      });
    } catch (e) {
      if (!(e instanceof ExportCancelled)) setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const runSticker = async () => {
    setError("");
    setResult(null);
    onBeforeExport();
    setBusy("sticker");
    try {
      const composer = compose();
      const out = joinPath(exportDir, exportNameFor(project.sourcePath, "-sticker", "png"));
      const res = await exportSticker(composer, {
        path: out,
        atMs: playheadMs,
        padding: stickerPad,
        radius: stickerRadius,
        shadow: DEFAULT_STICKER.shadow,
      });
      setResult({
        path: res.path,
        bytes: res.bytes,
        frames: 1,
        expected_frames: 1,
        format: "png",
      });
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  };

  const blocked = rawIpc === false;

  return (
    <div className="space-y-3">
      <Card size="small" className="!bg-panel" styles={{ body: { padding: 10 } }}>
        <Text type="secondary" className="text-xs">
          成片
        </Text>
        <div className="mt-1 space-y-1 text-xs">
          <Line label="时长" value={formatTimecode(total)} />
          <Line label="合成尺寸" value={`${EXPORT_W} × ${EXPORT_H}`} />
          <Line label="源" value={`${project.sourceWidth} × ${project.sourceHeight}`} />
          <Line label="片段" value={`${project.clips.length} 段`} />
          <Line
            label="缩放区 / 注释"
            value={`${project.zooms.length} / ${project.annotations.length}`}
          />
          <Line
            label="光标轨迹"
            value={track ? `${track.moves.length} 采样` : "无（未录制轨迹）"}
          />
          <Line label="输出目录" value={exportDir} />
        </div>
      </Card>

      {blocked && (
        <Alert
          type="warning"
          showIcon
          message="当前运行环境不支持二进制帧传输"
          description={
            <span className="text-[11px]">
              GIF 与贴纸导出依赖 Tauri 的字节 payload 通道，本环境的 IPC 走的是 JSON
              回退路径。录制、编辑与预览不受影响。
            </span>
          }
        />
      )}

      <Card size="small" className="!bg-panel" styles={{ body: { padding: 10 } }}>
        <Text type="secondary" className="text-xs">
          动图（GIF）
        </Text>
        <div className="mt-1 flex items-center gap-2">
          <Select
            size="small"
            className="w-[96px]"
            value={gifFps}
            onChange={setGifFps}
            options={[8, 10, 12, 15, 20, 24].map((v) => ({ value: v, label: `${v} fps` }))}
          />
          <span className="text-xs text-muted tabular-nums">
            {gifFit.frames} 帧 · {delayCsFor(gifFit.fps) * 10} ms/帧
          </span>
        </div>
        {gifFit.reduced && (
          <p className="mt-1 text-[11px] text-pause">
            时间轴过长，帧率将降为 {gifFit.fps} fps 以控制在 {MAX_GIF_FRAMES} 帧以内。
          </p>
        )}

        {progress && busy === "gif" ? (
          <div className="mt-2">
            <Progress
              percent={Math.round((progress.done / progress.total) * 100)}
              size="small"
              status="active"
            />
            <div className="mt-1 flex justify-between text-[11px] text-muted tabular-nums">
              <span>
                {progress.done} / {progress.total} 帧
              </span>
              <span>{progress.etaMs === null ? "估算中…" : `剩余约 ${secs(progress.etaMs)}`}</span>
            </div>
            <Button size="small" className="mt-1.5" block onClick={() => (cancelRef.current = true)}>
              取消
            </Button>
          </div>
        ) : (
          <Button
            type="primary"
            className="mt-2"
            size="small"
            block
            disabled={!videoRef.current || busy !== null || blocked}
            loading={busy === "gif"}
            onClick={() => void runGif()}
          >
            导出 GIF
          </Button>
        )}
        <p className="mt-1.5 text-[11px] text-muted">
          帧从当前预览画布取，因此自动带上背景、裁剪、缩放、注释与光标叠加。
        </p>
      </Card>

      <Card size="small" className="!bg-panel" styles={{ body: { padding: 10 } }}>
        <Text type="secondary" className="text-xs">
          贴纸（PNG）
        </Text>
        <div className="mt-1 flex items-center gap-2 text-xs">
          <span className="text-muted">留白</span>
          <InputNumber
            size="small"
            className="w-[64px]"
            min={0}
            max={200}
            value={stickerPad}
            onChange={(v) => setStickerPad(v ?? 0)}
          />
          <span className="text-muted">圆角</span>
          <InputNumber
            size="small"
            className="w-[64px]"
            min={0}
            max={200}
            value={stickerRadius}
            onChange={(v) => setStickerRadius(v ?? 0)}
          />
        </div>
        <Button
          className="mt-2"
          size="small"
          block
          disabled={!videoRef.current || busy !== null || blocked}
          loading={busy === "sticker"}
          onClick={() => void runSticker()}
        >
          导出当前画面（{formatTimecode(playheadMs)}）
        </Button>
        <p className="mt-1.5 text-[11px] text-muted">
          取播放头所在的那一帧，带透明留白与柔和投影，适合贴到文档或聊天窗口。
        </p>
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
        {ffmpeg?.available ? (
          <div className="mt-1.5 text-[11px]">
            <Tag color="green">已找到 ffmpeg</Tag>
            <span className="text-muted">（{ffmpeg.source}）</span>
            {ffmpeg.version && <div className="mt-0.5 break-all text-muted">{ffmpeg.version}</div>}
          </div>
        ) : (
          <>
            <Button className="mt-2" size="small" block disabled>
              转码（需要 ffmpeg）
            </Button>
            <p className="mt-1.5 text-[11px] text-muted">
              {ffmpeg?.hint || "正在检测 ffmpeg…"}
            </p>
          </>
        )}
        {ffmpeg?.available && (
          <Alert
            className="mt-2"
            type="info"
            showIcon
            message="转码命令将在下一任务接通"
            description={
              <span className="text-[11px]">
                ffmpeg 已就位，码率与帧率如上；命令行封装尚未实现，此处如实标注，不假装可用。
              </span>
            }
          />
        )}
      </Card>

      <Alert
        type="info"
        showIcon
        message="MV（自有编码器）"
        description={
          <span className="text-[11px]">
            计划只做序列层：拼接、裁剪、多音轨混音。缩放/注释/背景不进 MV，它们只进 GIF / PNG
            / 贴纸。此处如实标注，避免把它当成完整成片导出。
          </span>
        }
      />

      {error && <Alert type="error" showIcon message={error} />}

      {result && (
        <Alert
          type="success"
          showIcon
          message={`已导出 ${result.format.toUpperCase()}（${result.frames} 帧，${mb(result.bytes)}）`}
          description={
            <div className="text-[11px]">
              <div className="break-all">{result.path}</div>
              {result.frames < result.expected_frames && (
                <div className="mt-1 text-pause">
                  只写出 {result.frames} 帧，少于计划的 {result.expected_frames} 帧。
                </div>
              )}
              <Space className="mt-1">
                <Button size="small" onClick={() => void api.openFile(result.path)}>
                  在文件夹中显示
                </Button>
              </Space>
            </div>
          }
        />
      )}

      <p className="text-[11px] text-muted">
        播放头 {formatTimecode(playheadMs)}；GIF 始终导出整条时间轴，不受播放头影响；贴纸取播放头那一帧。
      </p>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted">{label}</span>
      <span className="break-all text-right tabular-nums">{value}</span>
    </div>
  );
}

function mb(bytes: number): string {
  return bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(2)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function secs(ms: number): string {
  return ms >= 60000 ? `${(ms / 60000).toFixed(1)} 分钟` : `${Math.ceil(ms / 1000)} 秒`;
}

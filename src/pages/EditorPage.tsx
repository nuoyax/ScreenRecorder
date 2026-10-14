import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Empty, Space, Typography } from "antd";
import {
  RedoOutlined,
  ScissorOutlined,
  UndoOutlined,
  ZoomInOutlined,
} from "@ant-design/icons";
import { api, type MouseTrack } from "@/lib/api";
import { fileName } from "@/lib/format";
import {
  type EditorState,
  type Project,
  annotationsAt,
  applyEdit,
  canRedo,
  canUndo,
  durationMs,
  emptyProject,
  initialState,
  ops,
  playbackRateAt,
  redo,
  sourceTimeForPlayhead,
  undo,
  zoomAt,
} from "@/lib/editor/state";
import { projectPathFor, sanitize, serialize } from "@/lib/editor/projects";
import { drawFrame, type FrameSource } from "@/lib/editor/appearance";
import { seekTo } from "@/lib/editor/playback";
import { suggestZooms, type ZoomSuggestion } from "@/lib/editor/zoomSuggest";
import { Timeline } from "@/components/editor/Timeline";
import { ClipList } from "@/components/editor/ClipList";
import { StylePanel } from "@/components/editor/StylePanel";
import { ZoomControl } from "@/components/editor/ZoomControl";
import { CropControl } from "@/components/editor/CropControl";
import { AnnotationLayer } from "@/components/editor/AnnotationLayer";
import { ExportPanel } from "@/components/editor/ExportPanel";
import { DEFAULT_ZOOM_DEPTH } from "@/lib/timeline/types";
import { formatTimecode } from "@/lib/timeline/time";

const { Text, Title } = Typography;

/** Preview composition size. Matches the export default so the layout is identical. */
const PREVIEW_W = 1280;
const PREVIEW_H = 720;

type Props = {
  /** Recording to open. `null` shows the empty state. */
  sourcePath: string | null;
  onBack: () => void;
  onPickRecording: () => void;
};

/** Inspector tabs. `crop` and `zoom` share the "画面" page. */
type Tab = "clips" | "frame" | "style" | "export";

/**
 * Timeline editor for one recording.
 *
 * The whole editing session is one `EditorState` value in this component; the children
 * are presentational and call `edit()` with an operation from `ops`. That keeps undo
 * honest — there is exactly one place a project changes.
 */
export function EditorPage({ sourcePath, onBack, onPickRecording }: Props) {
  const [state, setState] = useState<EditorState | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("clips");
  const [selectedClip, setSelectedClip] = useState<string | null>(null);
  const [track, setTrack] = useState<MouseTrack | null>(null);
  const [playing, setPlaying] = useState(false);
  /** Suggestions only when a track exists; `null` means "cannot suggest". */
  const [suggestions, setSuggestions] = useState<ZoomSuggestion[] | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  /** Playhead at the instant playback started; read by the loop without re-binding it. */
  const playStartRef = useRef(0);
  /**
   * Latest state, for the playback loop.
   *
   * The loop must not list `state` as a dependency: it advances the playhead itself, so
   * depending on the playhead would tear down and restart the loop on every frame.
   */
  const stateRef = useRef<EditorState | null>(null);
  stateRef.current = state;

  const edit = useCallback((fn: (project: Project) => Project) => {
    setState((s) => (s ? applyEdit(s, fn) : s));
  }, []);

  // Load the recording: read its metadata from the <video> element, then open the
  // project file next to it if one exists.
  useEffect(() => {
    let cancelled = false;
    setState(null);
    setTrack(null);
    setSelectedClip(null);
    setPlaying(false);
    setError("");
    if (!sourcePath) return;

    (async () => {
      try {
        await api.allowAsset(sourcePath);
        const video = videoRef.current;
        if (!video) return;
        video.src = convertSrc(sourcePath);

        const meta = await waitForMetadata(video);
        if (cancelled) return;

        const projectFile = projectPathFor(sourcePath);
        let project: Project | null = null;
        if (await api.fileExists(projectFile)) {
          try {
            project = sanitize(JSON.parse(await api.readTextFile(projectFile)));
          } catch {
            // A damaged project file must not block the recording: fall through to a
            // fresh project and say so, rather than refusing to open the editor.
            project = null;
            setError("工程文件无法读取，已按新工程打开");
          }
        }
        if (cancelled) return;

        setState(
          initialState(
            project ??
              emptyProject({
                sourcePath,
                durationMs: meta.durationMs,
                width: meta.width,
                height: meta.height,
                fps: 30,
              }),
          ),
        );

        const mouse = await api.loadMouseTrack(sourcePath);
        if (cancelled) return;
        setTrack(mouse);
        if (!mouse) setError((e) => e || "该录制没有光标轨迹，预览不画光标");
        // Suggestions are derived from the track, so they are computed once here rather
        // than on every render — and they are *offered*, never applied.
        setSuggestions(
          mouse
            ? suggestZooms(mouse.moves, {
                capture: mouse.rect ?? {
                  x: 0,
                  y: 0,
                  width: meta.width,
                  height: meta.height,
                },
                durationMs: meta.durationMs,
              })
            : null,
        );
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sourcePath]);

  const project = state?.project ?? null;
  const total = project ? durationMs(project) : 0;

  /** Paint one composed frame. When `seek` is false the video element is already
   *  showing the right moment (playback), so seeking would only fight the decoder. */
  const paintFrame = useCallback(
    (playheadMs: number, seek: boolean) => {
      const current = stateRef.current;
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (!current || !canvas || !video) return;
      const composed = current.project;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const sourceMs = Math.min(
        composed.sourceDurationMs,
        sourceTimeForPlayhead(composed, playheadMs),
      );

      const draw = () => {
        const source: FrameSource = {
          image: video,
          imageWidth: video.videoWidth,
          imageHeight: video.videoHeight,
        };
        drawFrame(ctx, canvas.width, canvas.height, source, {
          background: composed.background,
          crop: composed.crop,
          zoom: zoomAt(composed, playheadMs),
          annotations: annotationsAt(composed, playheadMs),
          timeMs: playheadMs,
          // The cursor track is stamped against the recording, not the timeline, so after a
          // trim or a speed change these are different numbers — and using the timeline
          // position would slide every click by however much was trimmed.
          sourceTimeMs: sourceMs,
          moves: track?.moves ?? [],
          clicks: track?.clicks ?? [],
          captureOrigin: track?.rect ?? {
            x: 0,
            y: 0,
            width: composed.sourceWidth,
            height: composed.sourceHeight,
          },
          showCursor: track !== null,
          clickHighlight: track !== null,
        });
      };

      if (!seek) {
        draw();
        return;
      }
      void seekTo(video, sourceMs).then(draw);
    },
    [track],
  );

  // Scrub / edit: seek + redraw. Skipped while playback owns the decoder.
  useEffect(() => {
    if (playing || !state) return;
    paintFrame(state.playheadMs, true);
  }, [paintFrame, playing, state]);

  // Playback: video is the clock; canvas is redrawn each frame. Playhead is kept in a
  // ref and only pushed into React ~10×/s so the timeline/timecode update without
  // re-rendering the whole editor sixty times a second.
  useEffect(() => {
    if (!playing) return;
    const video = videoRef.current;
    const current = stateRef.current;
    if (!video || !current) return;

    playStartRef.current = current.playheadMs;
    video.currentTime = sourceTimeForPlayhead(current.project, current.playheadMs) / 1000;
    video.playbackRate = Math.max(
      0.0625,
      Math.min(16, playbackRateAt(current.project, current.playheadMs)),
    );
    video.play().catch(() => undefined);

    const startedAt = performance.now();
    const startMs = playStartRef.current;
    let lastUi = 0;
    let lastRate = video.playbackRate;

    const tick = () => {
      const next = startMs + (performance.now() - startedAt);
      const live = stateRef.current;
      if (!live) return;

      if (next >= total) {
        stateRef.current = { ...live, playheadMs: total };
        setState((s) => (s ? { ...s, playheadMs: total } : s));
        setPlaying(false);
        return;
      }

      stateRef.current = { ...live, playheadMs: next };
      paintFrame(next, false);

      // Keep playbackRate in step when the playhead crosses into a different-speed clip.
      const rate = Math.max(0.0625, Math.min(16, playbackRateAt(live.project, next)));
      if (rate !== lastRate) {
        lastRate = rate;
        video.playbackRate = rate;
      }

      const now = performance.now();
      if (now - lastUi >= 100) {
        lastUi = now;
        setState((s) => (s ? { ...s, playheadMs: next } : s));
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      video.pause();
      // Flush the latest playhead so pause / scrub lands where playback stopped.
      const final = stateRef.current;
      if (final) setState((s) => (s ? { ...s, playheadMs: final.playheadMs } : s));
    };
  }, [playing, total, paintFrame]);

  const saveProject = useCallback(async () => {
    const current = stateRef.current;
    if (!current) return;
    try {
      const path = projectPathFor(current.project.sourcePath);
      await api.writeTextFile(path, serialize(current.project));
      setError((e) => (e.startsWith("工程文件无法读取") ? e : ""));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Save on project edits only — playhead scrubbing must not hammer the disk.
  useEffect(() => {
    if (!project) return;
    const timer = window.setTimeout(() => void saveProject(), 800);
    return () => window.clearTimeout(timer);
  }, [project, saveProject]);

  useEffect(() => () => void saveProject(), [saveProject]);

  if (!sourcePath) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
        <Empty description="还没有选择录制文件" />
        <Space>
          <Button type="primary" onClick={onPickRecording}>
            从录制列表选择
          </Button>
          <Button onClick={onBack}>返回</Button>
        </Space>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-canvas text-ink">
      <header className="flex items-center gap-2 border-b border-ctl px-3 py-2">
        <Button size="small" onClick={onBack}>
          返回
        </Button>
        <Title level={5} className="!mb-0 !text-sm">
          编辑器
        </Title>
        <Text type="secondary" className="truncate text-xs">
          {fileName(sourcePath)}
        </Text>
        <div className="flex-1" />
        <Text type="secondary" className="text-xs tabular-nums">
          {formatTimecode(state?.playheadMs ?? 0)} / {formatTimecode(total)}
        </Text>
      </header>

      {error && (
        <div className="border-b border-ctl bg-panel px-3 py-1 text-xs text-pause">{error}</div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Left: preview + toolbar */}
        <div className="flex min-w-0 flex-1 flex-col p-3">
          <div className="relative flex min-h-0 flex-1 items-center justify-center rounded-xl border border-ctl bg-black">
            <canvas
              ref={canvasRef}
              width={PREVIEW_W}
              height={PREVIEW_H}
              className="max-h-full max-w-full"
            />
            {/* The decoder feeds the canvas but is never shown. */}
            <video ref={videoRef} className="hidden" crossOrigin="anonymous" muted playsInline />
            <AnnotationLayer
              project={project}
              playheadMs={state?.playheadMs ?? 0}
              edit={edit}
            />
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              type="primary"
              onClick={() => setPlaying((p) => !p)}
              disabled={!state}
              className={playing ? "!border-pause !bg-pause" : ""}
            >
              {playing ? "暂停" : "播放"}
            </Button>
            <Button
              icon={<ScissorOutlined />}
              disabled={!state}
              onClick={() => edit(ops.splitAt(state?.playheadMs ?? 0))}
            >
              分割
            </Button>
            <Button
              icon={<ZoomInOutlined />}
              disabled={!state}
              onClick={() => {
                const at = state?.playheadMs ?? 0;
                edit(
                  ops.addZoom({ startMs: at, endMs: at + 2000 }, DEFAULT_ZOOM_DEPTH, {
                    cx: 0.5,
                    cy: 0.5,
                  }),
                );
              }}
            >
              加缩放
            </Button>
            <div className="flex-1" />
            <Button
              icon={<UndoOutlined />}
              disabled={!state || !canUndo(state)}
              onClick={() => setState((s) => (s ? undo(s) : s))}
              title="撤销"
            >
              撤销
            </Button>
            <Button
              icon={<RedoOutlined />}
              disabled={!state || !canRedo(state)}
              onClick={() => setState((s) => (s ? redo(s) : s))}
              title="重做"
            >
              重做
            </Button>
          </div>

          <Timeline
            project={project}
            playheadMs={state?.playheadMs ?? 0}
            durationMs={total}
            onSeek={(ms) => setState((s) => (s ? { ...s, playheadMs: ms } : s))}
            onSelectClip={setSelectedClip}
            selectedClipId={selectedClip}
            edit={edit}
          />
        </div>

        {/* Right: inspector */}
        <div className="w-[320px] shrink-0 overflow-y-auto border-l border-ctl p-3">
          <InspectorTabs tab={tab} onChange={setTab} />
          <div className="mt-3">
            {tab === "clips" && project && (
              <ClipList
                project={project}
                selectedClipId={selectedClip}
                onSelect={setSelectedClip}
                edit={edit}
              />
            )}
            {tab === "frame" && project && (
              <>
                <CropControl project={project} edit={edit} />
                <div className="mt-3">
                  <ZoomControl
                    project={project}
                    playheadMs={state?.playheadMs ?? 0}
                    edit={edit}
                    suggestions={suggestions}
                    onApply={(s) =>
                      edit(ops.addZoom({ startMs: s.startMs, endMs: s.endMs }, s.depth, s.focus))
                    }
                    onApplyAll={() => {
                      // One edit for the whole batch, so a single undo takes back all of
                      // it — undoing a dozen suggestions one at a time would be tedious.
                      for (const s of suggestions ?? []) {
                        edit(ops.addZoom({ startMs: s.startMs, endMs: s.endMs }, s.depth, s.focus));
                      }
                    }}
                  />
                </div>
              </>
            )}
            {tab === "style" && project && (
              <StylePanel project={project} playheadMs={state?.playheadMs ?? 0} edit={edit} />
            )}
            {tab === "export" && project && (
              <ExportPanel
                project={project}
                playheadMs={state?.playheadMs ?? 0}
                videoRef={videoRef}
                canvasRef={canvasRef}
                track={track}
                onBeforeExport={() => setPlaying(false)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Inspector tabs.
 *
 * Hand-rolled rather than antd's `Segmented` so each button can be addressed by key and
 * the row wraps on a narrow panel instead of clipping its labels.
 */
function InspectorTabs({ tab, onChange }: { tab: Tab; onChange: (tab: Tab) => void }) {
  const items: Array<{ key: Tab; label: string }> = [
    { key: "clips", label: "剪辑" },
    { key: "frame", label: "画面" },
    { key: "style", label: "样式" },
    { key: "export", label: "导出" },
  ];
  return (
    <div className="flex gap-1 rounded-lg bg-ctl p-1">
      {items.map((item) => (
        <Button
          key={item.key}
          size="small"
          type={tab === item.key ? "primary" : "text"}
          className="flex-1 !px-1"
          onClick={() => onChange(item.key)}
        >
          {item.label}
        </Button>
      ))}
    </div>
  );
}

/**
 * `asset:` URL for a local recording.
 *
 * The Tauri global is looked up rather than imported so the module also loads where it
 * is absent (the test runner), and a dev build without the global still works because
 * `allow_asset` has already granted the path.
 */
function convertSrc(path: string): string {
  const globalConvert = (
    window as unknown as { __TAURI__?: { core?: { convertFileSrc?: (p: string) => string } } }
  ).__TAURI__?.core?.convertFileSrc;
  return typeof globalConvert === "function" ? globalConvert(path) : path;
}

/** Wait for the `<video>` to report its dimensions and duration. */
function waitForMetadata(
  video: HTMLVideoElement,
): Promise<{ durationMs: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve({
        durationMs: Number.isFinite(video.duration) ? video.duration * 1000 : 0,
        width: video.videoWidth,
        height: video.videoHeight,
      });
    };
    const fail = () => {
      cleanup();
      reject(new Error("无法读取该视频文件"));
    };
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", done);
      video.removeEventListener("error", fail);
    };
    if (video.readyState >= 1) done();
    else {
      video.addEventListener("loadedmetadata", done);
      video.addEventListener("error", fail);
    }
  });
}

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Button,
  Input,
  InputNumber,
  List,
  Segmented,
  Select,
  Slider,
  Switch,
  Tabs,
  Typography,
} from "antd";
import { Transport } from "@/components/Transport";
import { api, type HistoryEntry, type Settings, type SourceLists } from "@/lib/api";
import { fileName, formatDuration } from "@/lib/format";
import { useRecordingState } from "@/hooks/useRecordingState";

const { Text, Title } = Typography;

const defaultSettings = (): Settings => ({
  source_kind: "screen",
  source_id: "",
  region: [0, 0, 1280, 720],
  fps: 30,
  scale_width: 0,
  codec: "h264",
  quality: "high",
  bitrate_kbps: 8000,
  rate_mode: "vbr",
  record_system_audio: true,
  record_microphone: false,
  system_volume: 1,
  mic_volume: 1,
  output_dir: null,
  max_duration_secs: 0,
  max_file_mb: 0,
  show_cursor: true,
  click_highlight: true,
  countdown_secs: 0,
  hotkey_start_stop: "Alt+R",
  hotkey_pause: "Alt+P",
});

export function MainPage() {
  const { state, duration } = useRecordingState();
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [sources, setSources] = useState<SourceLists | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [hint, setHint] = useState("");
  const skipSave = useRef(true);
  const prevState = useRef(state);

  const patch = (partial: Partial<Settings>) =>
    setSettings((s) => ({ ...s, ...partial }));

  useEffect(() => {
    (async () => {
      const s = await api.getSettings();
      setSettings({ ...defaultSettings(), ...s, region: s.region ?? [0, 0, 1280, 720] });
      setSources(await api.listSources());
      setHistory(await api.listRecordings());
      skipSave.current = false;
    })();
  }, []);

  useEffect(() => {
    if (skipSave.current) return;
    const t = window.setTimeout(() => {
      api.saveSettings(settings).catch(() => undefined);
    }, 200);
    return () => window.clearTimeout(t);
  }, [settings]);

  useEffect(() => {
    if (prevState.current !== "idle" && state === "idle") {
      api.listRecordings().then(setHistory).catch(() => undefined);
      setHint((h) => (h.startsWith("已保存") ? h : "已保存"));
    }
    if (prevState.current === "idle" && state === "recording") {
      setHint((h) => (h.startsWith("录制中") ? h : "录制中"));
    }
    prevState.current = state;
  }, [state]);

  useEffect(() => {
    let cancelled = false;
    api.onRecordingSaved((path) => {
      if (cancelled) return;
      api.listRecordings().then(setHistory).catch(() => undefined);
      if (path) setHint(`已保存 → ${path}`);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    api.listSources().then(setSources).catch(() => undefined);
  }, [settings.source_kind]);

  const sourceOptions =
    settings.source_kind === "window"
      ? (sources?.windows ?? []).map((w) => ({
          value: String(w.hwnd),
          label: w.title.slice(0, 70),
        }))
      : (sources?.monitors ?? []).map((m) => ({
          value: m.id,
          label: `${m.name}  ${m.width}×${m.height}${m.is_primary ? "  主屏" : ""}`,
        }));

  return (
    <div className="min-h-screen bg-canvas px-4 py-4 text-ink">
      <header className="mb-3.5 flex items-baseline justify-between">
        <Title level={4} className="!mb-0 !text-[18px] !text-ink">
          ScreenRecorder
        </Title>
        <div
          className={`flex items-center gap-2 font-semibold tabular-nums text-xl ${
            state === "recording"
              ? "text-rec"
              : state === "paused"
                ? "text-pause"
                : "text-muted"
          }`}
        >
          {state !== "idle" && (
            <span
              className={`h-2 w-2 rounded-full ${
                state === "recording" ? "bg-rec rec-blink" : "bg-pause"
              }`}
            />
          )}
          {formatDuration(duration)}
        </div>
      </header>

      <Text type="secondary" className="mb-3 mt-1.5 block truncate text-xs">
        {hint || "\u00a0"}
      </Text>

      <Transport
        state={state}
        onStart={async () => {
          try {
            await api.saveSettings(settings);
            const path = await api.startRecording();
            setHint(`录制中 → ${path}`);
          } catch (e) {
            setHint(`错误: ${e}`);
          }
        }}
        onPause={async () => {
          const p = await api.recordingProgress();
          if (p?.state === "paused") await api.resumeRecording();
          else await api.pauseRecording();
        }}
        onStop={async () => {
          try {
            setHint("正在保存…");
            const path = await api.stopRecording();
            if (path) setHint(`已保存 → ${path}`);
          } catch (e) {
            setHint(`错误: ${e}`);
          }
        }}
      />

      <Tabs
        defaultActiveKey="recent"
        size="small"
        className="recent-tabs"
        items={[
          {
            key: "recent",
            label: "最近",
            children: (
              <section className="rounded-xl bg-panel p-3.5">
                {history.length === 0 ? (
                  <p className="py-4 text-center text-muted">暂无录制</p>
                ) : (
                  <List
                    dataSource={history}
                    split={false}
                    renderItem={(h) => (
                      <List.Item
                        className="!cursor-pointer !rounded-lg !border-none !px-2 hover:!bg-ctl"
                        onClick={() => api.openFile(h.path)}
                      >
                        <div className="flex w-full min-w-0 items-baseline gap-2">
                          <span className="min-w-0 flex-1 truncate">{fileName(h.path)}</span>
                          <span className="shrink-0 text-xs text-muted">
                            {h.size_mb.toFixed(1)} MB  {h.modified}
                          </span>
                          <Button type="link" size="small" className="!px-0">
                            打开
                          </Button>
                        </div>
                      </List.Item>
                    )}
                  />
                )}
              </section>
            ),
          },
          {
            key: "settings",
            label: "设置",
            children: (
              <>
      <section className="mb-2.5 rounded-xl bg-panel p-3.5">
        <h2 className="mb-2.5 text-[13px] font-semibold">来源</h2>
        <Segmented
          block
          value={settings.source_kind}
          onChange={(v) => patch({ source_kind: String(v), source_id: "" })}
          options={[
            { label: "全屏", value: "screen" },
            { label: "窗口", value: "window" },
            { label: "区域", value: "region" },
          ]}
        />
        <Select
          className="mt-2 w-full"
          value={settings.source_id || undefined}
          placeholder="选择来源"
          options={sourceOptions}
          onChange={(v) => patch({ source_id: v })}
        />
        {settings.source_kind === "region" && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            {(["X", "Y", "W", "H"] as const).map((label, i) => (
              <label key={label} className="flex items-center gap-2 text-muted">
                {label}
                <InputNumber
                  className="w-full"
                  value={settings.region[i]}
                  onChange={(n) => {
                    const region = [...settings.region] as Settings["region"];
                    region[i] = Number(n ?? 0);
                    patch({ region });
                  }}
                />
              </label>
            ))}
          </div>
        )}
        <p className="mt-2 text-xs text-muted">
          {sources?.wgc_supported
            ? `检测到 ${sources.monitors.length} 个显示器，捕获可用`
            : "当前系统不支持 Windows.Graphics.Capture（需 Win10 1903+）"}
        </p>
      </section>

      <section className="mb-2.5 rounded-xl bg-panel p-3.5">
        <h2 className="mb-2.5 text-[13px] font-semibold">画质</h2>
        <Field label="帧率">
          <Select
            className="w-[88px]"
            value={settings.fps}
            onChange={(v) => patch({ fps: v })}
            options={[15, 30, 60].map((n) => ({ value: n, label: String(n) }))}
          />
        </Field>
        <Field label="编码器">
          <Select
            className="w-full max-w-[180px]"
            value={settings.codec}
            onChange={(v) => patch({ codec: v })}
            options={[
              { value: "h264", label: "H.264 兼容" },
              { value: "h265", label: "H.265 更小更清晰" },
            ]}
          />
        </Field>
        <Field label="质量">
          <Select
            className="w-full max-w-[180px]"
            value={settings.quality}
            onChange={(v) => patch({ quality: v })}
            options={[
              { value: "low", label: "低 · 小文件" },
              { value: "medium", label: "中" },
              { value: "high", label: "高 · 推荐" },
              { value: "ultra", label: "蓝光级 · 最高画质" },
              { value: "custom", label: "自定义码率" },
            ]}
          />
        </Field>
        {settings.quality === "custom" && (
          <Field label="码率 kbps">
            <InputNumber
              className="w-[88px]"
              value={settings.bitrate_kbps}
              onChange={(n) => patch({ bitrate_kbps: Number(n ?? 8000) })}
            />
          </Field>
        )}
        <Field label="码率模式">
          <Select
            className="w-[88px]"
            value={settings.rate_mode}
            onChange={(v) => patch({ rate_mode: v })}
            options={[
              { value: "vbr", label: "VBR" },
              { value: "cbr", label: "CBR" },
            ]}
          />
        </Field>
      </section>

      <section className="mb-2.5 rounded-xl bg-panel p-3.5">
        <h2 className="mb-2.5 text-[13px] font-semibold">音频</h2>
        <Field label="系统声音">
          <Switch
            checked={settings.record_system_audio}
            onChange={(v) => patch({ record_system_audio: v })}
          />
        </Field>
        <Field label="系统音量">
          <Slider
            className="m-0 w-[120px]"
            min={0}
            max={2}
            step={0.1}
            value={settings.system_volume}
            onChange={(v) => patch({ system_volume: v })}
          />
        </Field>
        <Field label="麦克风">
          <Switch
            checked={settings.record_microphone}
            onChange={(v) => patch({ record_microphone: v })}
          />
        </Field>
        <Field label="麦克风音量">
          <Slider
            className="m-0 w-[120px]"
            min={0}
            max={2}
            step={0.1}
            value={settings.mic_volume}
            onChange={(v) => patch({ mic_volume: v })}
          />
        </Field>
      </section>

      <section className="mb-2.5 rounded-xl bg-panel p-3.5">
        <h2 className="mb-2.5 text-[13px] font-semibold">其他</h2>
        <Field label="捕获鼠标光标">
          <Switch
            checked={settings.show_cursor}
            onChange={(v) => patch({ show_cursor: v })}
          />
        </Field>
        <Field label="最长时长（秒，0 不限）">
          <InputNumber
            className="w-[88px]"
            value={settings.max_duration_secs}
            onChange={(n) => patch({ max_duration_secs: Number(n ?? 0) })}
          />
        </Field>
        <Field label="最大文件（MB，0 不限）">
          <InputNumber
            className="w-[88px]"
            value={settings.max_file_mb}
            onChange={(n) => patch({ max_file_mb: Number(n ?? 0) })}
          />
        </Field>
        <Field label="输出目录">
          <Input
            className="w-full"
            value={settings.output_dir ?? ""}
            placeholder="默认 Videos/ScreenRecord"
            onChange={(e) => patch({ output_dir: e.target.value || null })}
          />
        </Field>
        <p className="mt-2 text-xs text-muted">Alt+R 开始或停止 · Alt+P 暂停或恢复</p>
      </section>
              </>
            ),
          },
        ]}
      />
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-1.5 flex min-h-8 items-center justify-between gap-3">
      <span className="shrink-0 text-muted">{label}</span>
      {children}
    </div>
  );
}

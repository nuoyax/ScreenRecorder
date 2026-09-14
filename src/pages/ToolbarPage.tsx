import { useEffect, useState } from "react";
import { Button, List } from "antd";
import {
  AppstoreOutlined,
  CloseOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Transport } from "@/components/Transport";
import { api, type HistoryEntry } from "@/lib/api";
import { fileName, formatDuration, parentDir } from "@/lib/format";
import { useRecordingState } from "@/hooks/useRecordingState";

const BAR_W = 260;
const BAR_H = 60;
const BAR_H_EXPANDED = 394;
const MARGIN = 72;

export function ToolbarPage() {
  const { state, duration } = useRecordingState();
  const [histOpen, setHistOpen] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (histOpen) api.listRecordings().then(setHistory).catch(() => undefined);
  }, [histOpen, state]);

  useEffect(() => {
    const un = api.onRecordingSaved(() => {
      api.listRecordings().then(setHistory).catch(() => undefined);
    });
    return () => {
      un.then((f) => f()).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    void resizeWindow(false);
  }, []);

  async function resizeWindow(expanded: boolean) {
    const w = getCurrentWindow();
    await w.setSize(new LogicalSize(BAR_W, expanded ? BAR_H_EXPANDED : BAR_H));
    try {
      const monitor = await w.currentMonitor();
      const scale = await w.scaleFactor();
      if (!monitor) return;
      const wa = monitor.workArea;
      const H = expanded ? BAR_H_EXPANDED : BAR_H;
      const x = wa.position.x + wa.size.width - Math.round(BAR_W * scale) - MARGIN;
      const y = wa.position.y + wa.size.height - Math.round(H * scale) - MARGIN;
      await w.setPosition(new PhysicalPosition(x, y));
    } catch {
      /* pin is best-effort */
    }
  }

  return (
    <div className="flex h-full w-full flex-col">
      <div
        className="drag-region flex h-14 w-full shrink-0 items-center gap-1 bg-canvas/90 px-2.5"
        onDoubleClick={async (e) => {
          e.preventDefault();
          e.stopPropagation();
          try {
            const w = getCurrentWindow();
            if (await w.isMaximized()) await w.unmaximize();
            await w.setSize(
              new LogicalSize(BAR_W, histOpen ? BAR_H_EXPANDED : BAR_H),
            );
          } catch {
            /* ignore */
          }
        }}
      >
        {state === "recording" || state === "paused" ? (
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              state === "recording" ? "bg-rec rec-blink" : "bg-pause"
            }`}
          />
        ) : (
          <span className="h-2 w-2 shrink-0" />
        )}
        <span
          className={`no-drag min-w-10 text-center text-xs font-semibold tabular-nums ${
            err
              ? "text-pause"
              : state === "recording"
                ? "text-rec"
                : state === "paused"
                  ? "text-pause"
                  : "text-muted"
          }`}
        >
          {err ? "错误" : formatDuration(duration)}
        </span>
        <div className="no-drag flex items-center gap-0.5">
          <Transport
            compact
            state={state}
            onStart={async () => {
              try {
                await api.startRecording();
                setErr(false);
              } catch {
                setErr(true);
                window.setTimeout(() => setErr(false), 2000);
              }
            }}
            onPause={async () => {
              const p = await api.recordingProgress();
              if (p?.state === "paused") await api.resumeRecording();
              else await api.pauseRecording();
            }}
            onStop={async () => {
              try {
                await api.stopRecording();
              } catch {
                /* ignore */
              }
            }}
          />
          <Button
            type={histOpen ? "default" : "text"}
            className="!h-8 !w-8 !min-w-8 !p-0"
            icon={<UnorderedListOutlined />}
            onClick={async () => {
              const next = !histOpen;
              setHistOpen(next);
              await resizeWindow(next);
            }}
          />
          <Button
            type="text"
            className="!h-8 !w-8 !min-w-8 !p-0"
            icon={<AppstoreOutlined />}
            onClick={async () => {
              const w = await WebviewWindow.getByLabel("main");
              if (w) {
                await w.show();
                await w.setFocus();
              }
            }}
          />
          <Button
            type="text"
            className="!h-8 !w-8 !min-w-8 !p-0"
            icon={<CloseOutlined />}
            onClick={async () => {
              try {
                await api.quitApp();
              } catch {
                const main = await WebviewWindow.getByLabel("main");
                if (main) await main.close();
                await getCurrentWindow().close();
              }
            }}
          />
        </div>
      </div>

      {histOpen && (
        <div className="no-drag mt-1.5 min-h-0 flex-1 overflow-y-auto bg-canvas/90 p-2.5">
          <h3 className="mb-2 px-1.5 text-xs font-semibold text-muted">录制历史</h3>
          {history.length === 0 ? (
            <p className="py-4 text-center text-muted">暂无录制</p>
          ) : (
            <List
              dataSource={history}
              split={false}
              renderItem={(h) => (
                <List.Item
                  className="!cursor-pointer !rounded-lg !border-none !px-1.5 hover:!bg-ctl"
                  title={h.path}
                  onClick={() => api.openFile(parentDir(h.path))}
                >
                  <div className="flex w-full min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{fileName(h.path)}</span>
                    <span className="shrink-0 text-[11px] text-muted">
                      {h.size_mb.toFixed(1)}MB
                    </span>
                  </div>
                </List.Item>
              )}
            />
          )}
        </div>
      )}
    </div>
  );
}

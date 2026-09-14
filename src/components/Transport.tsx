import { Button } from "antd";
import {
  BorderOutlined,
  CaretRightOutlined,
  PauseOutlined,
} from "@ant-design/icons";
import type { RecState } from "@/lib/api";

type Props = {
  state: RecState;
  onStart: () => void;
  onPause: () => void;
  onStop: () => void;
  compact?: boolean;
};

export function Transport({ state, onStart, onPause, onStop, compact }: Props) {
  const busy = state !== "idle";
  const paused = state === "paused";

  return (
    <div className={`flex items-center ${compact ? "gap-1" : "gap-2"}`}>
      <Button
        type="primary"
        danger
        disabled={busy}
        onClick={onStart}
        className={compact ? "!h-8 !w-8 !min-w-8 !p-0" : "flex-1"}
        icon={
          <span
            className={`inline-block h-3 w-3 rounded-full bg-white ${
              busy ? "rec-btn-breathe" : ""
            }`}
          />
        }
      >
        {compact ? null : busy ? "录制中" : "开始录制"}
      </Button>
      <Button
        disabled={!busy}
        onClick={onPause}
        title={paused ? "恢复" : "暂停"}
        className={`!h-8 !w-8 !min-w-8 !p-0 ${paused ? "!bg-pause !text-canvas !border-none" : ""}`}
        icon={paused ? <CaretRightOutlined /> : <PauseOutlined />}
      />
      <Button
        disabled={!busy}
        onClick={onStop}
        title="停止并保存"
        className="!h-8 !w-8 !min-w-8 !p-0"
        icon={<BorderOutlined />}
      />
    </div>
  );
}

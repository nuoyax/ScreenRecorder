import { Button } from "antd";
import {
  BorderOutlined,
  CaretRightOutlined,
  PauseOutlined,
  VideoCameraOutlined,
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
      {busy ? (
        <Button
          type="primary"
          onClick={onPause}
          title={paused ? "恢复" : "暂停"}
          className={`!h-8 !w-8 !min-w-8 !p-0 ${
            paused ? "!bg-pause !border-pause" : "!bg-rec !border-rec"
          }`}
          icon={paused ? <CaretRightOutlined /> : <PauseOutlined />}
        />
      ) : (
        <Button
          type="primary"
          danger
          onClick={onStart}
          title="开始录制"
          className={
            compact
              ? "!h-8 !w-8 !min-w-8 !p-0"
              : "flex-1 !h-8 !w-8 !min-w-8 !p-0 mx-auto"
          }
          icon={<VideoCameraOutlined />}
        />
      )}
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

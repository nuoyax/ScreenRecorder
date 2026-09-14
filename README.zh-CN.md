# Screen Record（屏幕录制）

[English](README.md) | **中文**

基于 Rust + Tauri 2 的轻量级 Windows 屏幕录制工具。使用 Windows.Graphics.Capture 捕获屏幕/窗口/区域，Media Foundation 硬件编码（H.264/H.265 + AAC），输出高画质、小体积的 MP4。

## 功能

- **捕获源**：全屏（多显示器）、任意窗口、自定义区域
- **高画质**：H.264 / H.265 (HEVC) 硬件编码，VBR/CBR，质量档位或自定义码率
- **音频**：系统声音（WASAPI loopback）与麦克风独立开关、音量可调，混音输出 AAC
- **录制控制**：开始/暂停/恢复/停止，全局热键（Alt+R、Alt+P）
- **自动停止**：按时长或按文件大小
- **鼠标捕获**：光标包含在画面中（支持的系统自动隐藏录制边框）
- **录制历史**：文件列表（大小/日期），一键在资源管理器中打开
- **设置持久化**：JSON 配置

## 环境要求

- Windows 10 1903+（Windows.Graphics.Capture）
- Rust（MSYS2/MinGW 或 MSVC 工具链）

## 构建

```bash
cd src-tauri
cargo build --release
```

> 注意：GNU 工具链下 `windres` 需要可用的 C 预处理器，构建时请将 `mingw64/bin` 加入 PATH。

## 使用

启动 `screen-record.exe`，选择录制源、调整画质，按 **Alt+R**（或界面按钮）开始录制。默认输出到 `视频\ScreenRecord\recording_YYYYMMDD_HHMMSS.mp4`。

### 画质档位（1080p/30fps 码率参考）

| 档位 | ~码率 | 说明 |
|------|-------|------|
| 低   | ~6 Mbps  | 文件最小 |
| 中   | ~13 Mbps | 均衡 |
| 高   | ~25 Mbps | 推荐，UI 录制近乎无损 |
| 自定义 | 用户设定 | 完全控制 |

H.265 达到与 H.264 相同观感只需约 65% 的码率。

## 许可证

MIT

# ScreenRecorder（屏幕录制）

[English](README.md) | **中文**

<div align="center">

**基于 Rust + Tauri 2 的轻量高性能 Windows 屏幕录制工具**

捕获 • 硬件编码 • 零冗余

![Platform](https://img.shields.io/badge/platform-Windows%2010%201903%2B-blue)
![Rust](https://img.shields.io/badge/rust-1.77%2B-orange)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8D8)
![License](https://img.shields.io/badge/license-MIT-green)

</div>

---

ScreenRecorder 通过 **Windows.Graphics.Capture** 捕获全屏、单个窗口或自定义区域，使用 **Media Foundation 硬件编码器**（H.264/H.265 + AAC）编码，输出紧凑、可直接播放的 MP4 —— 没有臃肿的运行时，没有水印，没有遥测。

## ✨ 功能

### 🎥 捕获
- **三种来源** —— 全屏（多显示器感知）、任意应用窗口、精确自定义区域
- **悬浮工具栏** —— 置顶迷你控制条固定在屏幕角落，自动**从录制画面中排除**（`WDA_EXCLUDEFROMCAPTURE`）
- **鼠标捕获** —— 光标包含在画面中；支持的系统上自动隐藏录制边框

### 🎬 编码
- **硬件加速** —— Media Foundation H.264 / H.265 (HEVC)；系统无 HEVC 编码器时自动降级 H.264
- **画质档位** —— 从低码率小文件到"蓝光级" ultra 档；也可完全自定义码率
- **VBR / CBR** 码率控制
- **零拷贝 GPU 通路** —— 帧数据全程留在 D3D11 管线，从捕获直通编码器

### 🔊 音频
- **系统声音**（WASAPI loopback）与**麦克风**独立开关，各自音量可调
- 双源混音，AAC 编码封装进同一个 MP4

### ⏺ 录制控制
- 开始 / **暂停 / 恢复** / 停止 —— 暂停时计时器正确冻结
- **全局热键**：`Alt+R` 开始/停止、`Alt+P` 暂停/恢复 —— 应用在后台也生效
- **自动停止**：按时长上限或文件大小上限
- 保存不卡界面：大文件 MP4 封装在后台完成，UI 永不假死

### 🗂 历史与设置
- **最近录制**列表，带文件大小和日期 —— 一键在资源管理器中打开
- 全部设置持久化为 JSON，启动自动恢复

## 📦 安装与构建

### 环境要求
- Windows 10 1903+（Windows.Graphics.Capture API）
- [Rust](https://rustup.rs)（推荐 MSVC 工具链）与 Node.js 18+
- WebView2（Windows 11 已内置）

```bash
# 安装前端依赖
npm install

# 构建发布版二进制
npm run tauri build

# 或开发模式运行（热重载）
npm run tauri dev
```

产物位于 `src-tauri/target/release/screen-recorder.exe`。

> **GNU 工具链注意**：`windres` 需要可用的 C 预处理器 —— 请将 `mingw64/bin` 加入 PATH，或改用 MSVC 构建。

## 🚀 使用

1. 启动 `screen-recorder.exe` —— 屏幕右下角出现悬浮工具栏，主窗口提供完整设置。
2. 选择来源和画质，按 **Alt+R** 或 ● 按钮开始录制。
3. **Alt+P** 暂停/恢复，再按 **Alt+R**（或 ■）停止并保存。

默认输出：`视频\ScreenRecord\recording_YYYYMMDD_HHMMSS.mp4`

### 画质档位（1080p/30fps 码率参考）

| 档位 | ~码率 | 说明 |
|------|-------|------|
| 低   | ~6 Mbps  | 文件最小 |
| 中   | ~13 Mbps | 均衡 |
| 高   | ~25 Mbps | 推荐，UI 内容近乎无损 |
| 蓝光级 | ~55 Mbps | 最高画质 |
| 自定义 | 用户设定 | 完全控制 |

> H.265 达到与 H.264 相同观感只需约 65% 的码率。

## 🏗 架构

```
┌──────────────────────────── Tauri 2 (Rust) ───────────────────────────┐
│                                                                       │
│  WGC 捕获 ──► D3D11 纹理 ──► MF SinkWriter ──► MP4 (H.264/265)        │
│       │                                   ▲                           │
│  WASAPI loopback ──► AAC 编码器 ──────────┘                           │
│  WASAPI 麦克风 ───────────────────────────┘                           │
│                                                                       │
│  React + antd 界面（主窗口 + 悬浮工具栏）                              │
│    └── Tauri IPC 命令 / 事件（进度、已保存、编码器降级）                │
└───────────────────────────────────────────────────────────────────────┘
```

| 模块 | 路径 | 职责 |
|------|------|------|
| 捕获 | `src-tauri/src/capture/` | WGC 帧池、显示器/窗口枚举 |
| 编码 | `src-tauri/src/encoder/` | MF SinkWriter 封装、编码器协商 |
| 音频 | `src-tauri/src/audio/` | WASAPI loopback + 麦克风采集、重采样、混音 |
| 录制 | `src-tauri/src/recorder.rs` | 状态机（录制/暂停/停止）、多线程 |
| 界面 | `src/` | React 19 + antd + Tailwind 4 |

## ⌨️ 快捷键

| 按键 | 动作 |
|------|------|
| `Alt+R` | 开始 / 停止录制 |
| `Alt+P` | 暂停 / 恢复 |

## 📄 许可证

[MIT](LICENSE)

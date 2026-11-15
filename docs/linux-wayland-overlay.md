# Linux Wayland 原生桌宠 Overlay

> 目标：不使用 X11/XWayland，同时保留桌宠的逐像素穿透、任意定位、拖拽和透明渲染。

## 架构

```
Electron 主进程
├─ 聊天/设置/音乐：普通原生 Wayland 窗口
├─ 桌宠渲染：隐藏的 offscreen BrowserWindow（和 Windows 同一套 Live2D 页面）
│     │  premultiplied BGRA 帧 + JSON 头
│     ▼  Unix socket
└─ cyrene-overlay-host（Rust + libwayland，无 X11）
      ├─ zwlr_layer_shell_v1（Hyprland / KDE / wlroots / COSMIC / Mir）
      ├─ wl_shm ARGB8888 buffer
      ├─ 根据 alpha 计算 wl_surface.set_input_region
      ├─ 拖拽：zwp_relative_pointer_v1 增量 + layer-shell margin
      └─ 鼠标事件回传 Electron → webContents.sendInputEvent
```

Electron 不再负责真实 Wayland 窗口的定位、置顶和鼠标命中；这些全部由
layer-shell surface 完成。

## 启用

```bash
# 1. 构建原生宿主（首次或改了 Rust 后）
pnpm run build:overlay-host

# 2. 运行
pnpm start
```

在 Linux + Wayland 且检测到 `native/cyrene-overlay-host/target/release/cyrene-overlay-host`
（开发环境）或 `resources/bin/cyrene-overlay-host`（打包环境）时自动启用。

显式控制：

```bash
# 强制启用（二进制不存在则回退普通窗口）
CYRENE_PET_OVERLAY=1 pnpm start

# 强制关闭，使用旧的普通 BrowserWindow
CYRENE_PET_OVERLAY=0 pnpm start

# 指定宿主二进制
CYRENE_OVERLAY_HOST_BIN=/path/to/cyrene-overlay-host pnpm start
```

如果宿主启动失败（例如合成器没有 `wlr-layer-shell`），主进程会回退到普通
BrowserWindow，不会让桌宠完全消失。GNOME/Mutter 不实现 layer-shell，自动模式
会直接使用普通窗口；显式 `CYRENE_PET_OVERLAY=1` 仍会尝试宿主并回退。

## 当前行为

- **逐像素穿透**：宿主按帧 alpha 生成输入区域；透明区域点击穿透。
- **定位/拖拽**：layer-shell margin 定位，拖拽通过 relative-pointer 增量更新；
  位置变化通过 `position`/`drag` 事件回传，由现有设置持久化。
- **置顶**：开启时使用 `OVERLAY` 层（可盖住全屏应用），关闭时退回 `TOP`
  层；由于 layer-shell 没有“普通窗口”层级，关闭后仍位于普通窗口之上，
  这是 layer-shell 的语义限制。
- **缩放**：`PET_ZOOM` 同时调整 offscreen 窗口和 layer surface 尺寸。
- **透明**：离屏渲染保留 alpha，宿主使用 `ARGB8888`。
- **输入**：鼠标进入/移动/按下/抬起通过 `sendInputEvent` 转发给离屏渲染页；
  拖拽开始时通知渲染页取消点击手势，避免拖拽误触发 Live2D 动作。

## 已知限制

- 需要 `zwlr_layer_shell_v1`；GNOME/Mutter 不支持 layer-shell 时，自动使用
  `cyrene-overlay-fullscreen`（xdg_toplevel 全屏 + 输入区域），因此 GNOME 也有
  逐像素穿透/定位能力，但会进入全屏态（顶栏/概览副作用待验证）。
- HiDPI 目前按逻辑尺寸渲染，由合成器放大；后续可用 `wl_surface.set_buffer_scale`
  或按输出 scale 渲染。
- 多显示器暂未按 `init.output` 选择输出，使用合成器默认输出。
- 没有相对指针协议的合成器无法拖拽，日志会给出 warning。
- 宿主崩溃/协议不兼容时回退普通窗口；不会自动重启宿主。

## 文件

| 路径 | 作用 |
| --- | --- |
| `native/cyrene-overlay-host/` | Rust Wayland overlay 宿主 |
| `src/main/pet-overlay/host-client.ts` | 启动宿主、Unix socket、帧发送 |
| `src/main/pet-overlay/controller.ts` | offscreen 窗口、帧捕获、输入回传 |
| `src/main/pet-overlay/protocol.ts` | 帧/控制消息格式 |
| `scripts/build/overlay-host.mjs` | 构建并 staging 二进制 |
| `src/main/startup/create-pet-window.ts` | overlay 入口与普通窗口回退 |
| `src/renderer/main.ts` | overlay 模式跳过渲染层拖拽/穿透 |

## 验证

```bash
# Rust 单元测试
cargo test --manifest-path native/cyrene-overlay-host/Cargo.toml

# TypeScript 检查与协议测试
pnpm run check:main
pnpm exec vitest run src/main/pet-overlay/protocol.test.ts

# 纯 Wayland 启动（不连接 X server）
env -u DISPLAY pnpm start
```

手工验证：

1. 桌宠出现在保存位置，背景透明；
2. 点击模型区域有 Live2D 动作，点击透明区域能点到底下窗口；
3. 按住模型拖拽，layer surface 跟随移动，松手后位置持久化；
4. 重启应用后位置恢复；
5. `hyprctl layers` 能看到 `cyrene-overlay`，且没有 `DISPLAY` 连接也能工作。

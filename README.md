这里是荆雪的 Cyrene-Agent 的 Hyprland 分支咪
上游为：https://github.com/Playa-Cyrene/Cyrene-Agent

# Cyrene-Agent · Hyprland / Wayland 分支

本分支用于推进 **Linux 无 X11** 适配：在 Hyprland（Wayland）下让桌宠、截图、Toast、自启动、全局快捷键和 Linux 沙箱基础路径可用，同时明确记录哪些能力已经过实机验证、哪些仍是降级路径、哪些尚未完成。

> **验证范围**：Arch Linux + Hyprland 0.57.1 + Wayland + Electron 44.7.2。
> **不跨 DE 验证**：没有在 GNOME/Mutter、KDE、Sway、COSMIC 上做验收；相关项只标记为“仅 Hyprland/未跨 DE”，不因 Hyprland 通过而算完成。
> **网络沙箱暂缓**：SRT 的 Linux 网络 allowlist/DNS/代理按当前要求不处理，SBX-05 保持阻塞。

## 当前状态

对应 [`docs/linux-wayland-remaining-tasks.md`](docs/linux-wayland-remaining-tasks.md) 的 86 项清单（2026-11-16）：

| 状态 | 数量 |
| --- | ---: |
| ✅ 已完成并验收 | 58 |
| 🟡 部分完成 | 8 |
| ❌ 未开始/阻塞 | 15 |
| ➖ 不适用（跨 DE/X11，按范围排除） | 5 |
| **合计** | **86** |

这不是“完整 Linux 支持”。更准确的说法是：**Hyprland/AppImage 主路径已可用，跨 DE、网络沙箱、普通窗口管理和部分硬件/兼容性项仍未完成。**

详细证据与逐项状态见：

- [`docs/linux-wayland-status.md`](docs/linux-wayland-status.md)
- [`docs/linux-wayland-remaining-tasks.md`](docs/linux-wayland-remaining-tasks.md)
- [`docs/linux-wayland-remaining-blockers.md`](docs/linux-wayland-remaining-blockers.md)

## 已适配

### 构建、运行与打包

- Linux x64 下 `pnpm run build`、类型检查、Vitest、Vite 渲染构建可运行。
- `pnpm run package:linux:dir` 生成解包目录；`pnpm run package:linux` 生成 AppImage + tar.gz。
- `pnpm run build:overlay-host` 构建两个 native Wayland 宿主，并写入 `resources/bin/linux/SHA256SUMS`。
- `pnpm run verify:linux-artifacts` 校验 AppImage、`latest-linux.yml`、宿主二进制和打包后的 `SHA256SUMS`。
- AppImage 实机启动、`--appimage-extract-and-run`、XDG autostart 启动已验证。
- CI/release 工作流已配置；**尚未在远程 GitHub runner 实际跑过**。

### 桌宠 overlay（Hyprland）

- `native/cyrene-overlay-host` 使用 `zwlr_layer_shell_v1`，不依赖 X11。
- `wl_surface.set_input_region` 按 alpha 生成输入区域，实现透明区域点击穿透。
- 支持拖拽、按输出位置恢复、`kill -9` 后宿主退避重启。
- 支持 `--layer top|overlay|bottom`；`petAlwaysOnTop=false` 时使用 bottom layer。
- 2x 缩放下 buffer 正确放大；真实 `scale=1.25` 输出使用 `ceil(scale)=2` 超采样，逻辑坐标不变。
- 4K@120Hz 输出、600×750 layer 实测 60fps cap、0 丢帧、延迟约 1ms。
- `cyrene-overlay-fullscreen` 为无 layer-shell 场景提供全屏 `xdg_toplevel` fallback；已在 Hyprland 强制 fullscreen 验证，GNOME 未验。
- 宿主协议：`protocol:1`、宿主版本绑定、帧 ack 延迟/丢帧统计、唯一 0600 socket。

### 截图与标注

- 全屏截图：`grim` 路径。
- 区域截图：`slurp`，已修复 stdin 为管道时卡住的问题。
- 窗口截图：优先 `hyprctl activewindow`；为空时回退到 `cursorpos + clients`，取光标下普通窗口。
- 多屏/HiDPI 截图可用。
- 截图后可进入 Electron 标注编辑器：画笔、矩形、箭头、撤销、清空、保存、取消。
- 标注取消会清理原始临时截图；截图文件权限 0600，启动时清理 7 天/100 个上限。
- 截图快捷键：Hyprland `hl.bind` 实键触发已验证；GlobalShortcuts portal 也有实现。
- 设置页新增截图快捷键输入，保存到 general settings 并自动重新注册。

### Toast 与桌面交互

- Toast 通过 native overlay host 显示，不再依赖透明窗口边角。
- 点击 Toast 可激活聊天窗口。
- Toast 支持 reduced-motion、Tab/Enter/Space 触发、focus-visible、`prefers-contrast: more`。
- 桌宠右键菜单：设置、隐藏桌宠、退出（offscreen 渲染页内菜单，实测可显示）。
- 窗口隐藏时停止向宿主发帧，显示后恢复并补发最新帧。

### 自启动、控制通道与诊断

- XDG autostart：AppImage 与解包目录均实测写入 `autostart/cyrene.desktop`。
- 单实例与二次启动激活聊天窗口已验证。
- `cyrene control` / 控制 socket 支持：`show-chat`、`show-settings`、`toggle-pet`、`screenshot`、`screenshot-window`、`toast-test`、`quit`、`ping`。
- `cyrene doctor` 提供依赖与环境诊断；AppArmor 限制 unprivileged userns 时会在启动日志和 doctor 中提示。

### Linux 沙箱（非网络部分）

- Linux 下接入 `@anthropic-ai/sandbox-runtime` + bubblewrap + socat。
- 已验证 bwrap 内执行 `echo sandbox-ok`；seccomp 文件通过 asarUnpack 随包分发。
- AppArmor userns 限制检测已接入启动日志与 `cyrene doctor`。
- **网络 allowlist/DNS/代理未打通**，因此不能宣称 Linux 网络沙箱可用；SBX-05 按当前范围不处理。

### 验证与性能

- 全量测试最后一次：**631 个文件、7056 项通过**（36 项跳过）。
- Rust host 单测 11 项通过。
- 60s overlay soak：RSS -7.0%、CPU 6.7%、帧延迟 1ms、fd 复核稳定。
- 4K@120Hz + 600×750：551 帧/10s、0 丢帧。

## 部分完成（8 项）

这些项已有代码或部分实机证据，但还达不到“完整验收”：

| 项 | 已完成 | 仍缺 |
| --- | --- | --- |
| OVL-02 | 全屏 ARGB buffer、宠物区域拷贝/damage | 未用 parent+subsurface/局部 buffer；两次尝试画面异常已回滚 |
| OVL-07 | 按输出位置持久化、output_destroyed 迁移逻辑 | 输出移除/重连时序仍不稳定，跨屏互拖未做 |
| OVL-10 | 普通窗口层级 | 全屏游戏、锁屏、通知中心、面板遮挡未系统验证 |
| OVL-19 | `ThemedPointer` enter/leave 设置 | `grim -c` 仍显示默认箭头，shape device 未生效 |
| OVL-20 | `wl_touch` down/motion/up 映射为鼠标事件 | 无真实触摸屏；uinput 虚拟触摸屏未被 Hyprland 识别 |
| SHOT-01 | Hyprland 下 portal 可运行，失败回退 grim | 非交互返回 response 2；其他 DE 未验 |
| GS-05 | 截图快捷键设置 UI + 持久化 + 自动重注册 | 无按键录制器、无冲突检测/占用提示 |
| QA-05 | 随机 JSON 2000 例、stride/尺寸边界 | 半包/乱序、host 端 fuzz 未做 |

## 未做 / 阻塞（15 项）

### Overlay 与输入

| 项 | 原因 |
| --- | --- |
| OVL-08 跨输出拖拽 | 拖拽只改 margin，未做跨 output surface 迁移/坐标重算 |
| OVL-14 shared texture / DMA-BUF 零拷贝 | 仍是 CPU bitmap + socket 拷贝 |
| OVL-21 键盘/IME | layer `keyboard_interactivity=None`，无键盘转发 |
| OVL-24 arm64/多架构 | 只有 x64；本机无 arm64 Rust std |
| OVL-26 AppImage glibc/依赖兼容 | 只在 Arch 构建，未在旧发行版验证 |

### 窗口 / 焦点 / 更新 / 快捷键

| 项 | 原因 |
| --- | --- |
| GS-02 授权/冲突/拒绝 | 无首次授权、冲突提示、禁用状态 UI |
| FOCUS-01 `xdg-activation` | Electron 未暴露 activation token；只有应用内 broker |
| FOCUS-04 通知动作打开窗口 | 未接 `org.freedesktop.Notifications` action |
| UPD-06 回滚/旧版本保留 | 无失败回滚、无上一版保留 |
| WIN-01 普通窗口定位/居中/恢复 | Native Wayland `setBounds` 无效；Hyprland Lua move 可动，但 resize/后续 setBounds 会重排回 tiled |
| WIN-02 普通窗口置顶 | `setAlwaysOnTop` 在 native Wayland 无效 |
| WIN-04 透明/焦点/激活 | 未系统验证 |
| WIN-05 剪贴板/文件选择/拖放/密钥环 | 未做 Wayland 回归 |
| WIN-06 屏幕录制/desktopCapturer | 未验证 |

### 网络（按当前要求暂缓）

| 项 | 原因 |
| --- | --- |
| SBX-05 网络 allowlist/DNS/代理 | 无 Linux 网络沙箱；host proxy 正常，sandbox 内 CONNECT 无响应。**按用户要求不处理。** |

## 不适用（5 项）

按“只验证 Hyprland、不跨 DE/X11”的范围排除，不计入未完成债务：

- OVL-03：GNOME 全屏态副作用
- OVL-27：KDE/Sway/GNOME/多屏 E2E
- TRAY-03：GNOME AppIndicator 提示
- WIN-07：X11 回归
- QA-02：合成器 E2E 矩阵

## 快速开始

### 前置条件

- Arch Linux + Wayland 会话，当前验证桌面为 **Hyprland 0.57.1**。
- Node.js 24、pnpm 10.33.0、Rust stable。
- 系统依赖：`git`、`bash`、`mpv`、`ffmpeg`/`ffprobe`、`libsecret`；截图还需要 `grim`、`slurp`。
- Native overlay host 通过 Wayland client 栈构建，需要系统 Wayland 开发库。
- 托盘依赖 StatusNotifierItem 宿主；Hyprland 下无托盘宿主时使用降级路径。

### 安装与启动

```bash
git clone https://github.com/Playa-Cyrene/Cyrene-Agent.git
cd Cyrene-Agent
pnpm install --frozen-lockfile
pnpm run build
pnpm start
```

开发模式：

```bash
pnpm run dev
```

Linux 不需要构建 Windows 截图助手、mpv 或 mingit；音乐使用系统 mpv，Git 使用系统 git。

### 打包

```bash
# 解包目录，快速验证
pnpm run package:linux:dir

# AppImage + tar.gz
pnpm run package:linux
```

产物在 `release/`。

### 验证

```bash
pnpm run check:main
pnpm run check:preload
pnpm run check:renderer
pnpm test

cargo test --manifest-path native/cyrene-overlay-host/Cargo.toml
pnpm run build:overlay-host
pnpm run verify:linux-artifacts
pnpm run verify:linux-overlay-soak
pnpm run verify:overlay-protocol

cyrene doctor
```

## 已知限制

1. **仅 Hyprland 验收**：GNOME/KDE/Sway 的窗口、托盘、portal、全屏行为没有实机结论。
2. **普通窗口管理不完整**：native Wayland 下 Electron 的 `setBounds`/`setAlwaysOnTop` 不可靠；聊天/设置窗口仍可能被合成器 tiled。
3. **OVL-02 未做局部 buffer**：当前 fullscreen fallback 仍拷贝全屏 ARGB buffer，带宽和 CPU 不是最优。
4. **指针形状未生效**：`grim -c` 仍显示默认箭头。
5. **无真实触摸屏验证**：`wl_touch` 路径存在，但没有硬件证据。
6. **portal 截图有回退**：Hyprland portal 非交互返回 response 2，实际使用 grim 路径。
7. **网络沙箱未完成**：SRT 的 Linux 网络 allowlist/DNS/代理没有打通，受限 shell 不能宣称具备网络隔离。
8. **AppImage 升级未实跑**：feed 和 release 工作流已配置，但没有上传 release 或执行一次真实升级。
9. **arm64/旧 glibc 未验证**：当前只构建 x64，且只在 Arch 上运行。
10. **CI 未远程实跑**：工作流配置存在，但尚未在 GitHub runner 上跑过。

## 相关文档

- [Linux 开发与适配说明](docs/linux-development.md)
- [Hyprland overlay 设计](docs/linux-wayland-overlay.md)
- [Linux 排障](docs/linux-troubleshooting.md)
- [86 项任务清单](docs/linux-wayland-remaining-tasks.md)
- [验收状态](docs/linux-wayland-status.md)
- [剩余项阻塞说明](docs/linux-wayland-remaining-blockers.md)
- [English README](README.en.md)（上游版本，未同步本分支状态）

## 上游与许可

- 上游项目：[Playa-Cyrene/Cyrene-Agent](https://github.com/Playa-Cyrene/Cyrene-Agent)
- 本仓库源代码遵循 [MIT License](LICENSE)；角色 IP、Live2D 模型与美术资产遵循 [MODEL_LICENSE.md](MODEL_LICENSE.md) 及米哈游同人创作规范。
- 本项目为非官方粉丝同人作品，与 HoYoverse / 米哈游无关联、背书或赞助关系。

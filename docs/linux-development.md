# Linux 开发与适配说明

本分支（`cyreneOnHyprland`）用于在 Linux 实机上持续开发 Cyrene。当前基线不是“完整 Linux 发行版”，而是一套可编译、可启动、可打包、可跑测试的开发环境；Windows 专用能力会显式降级或禁用，避免静默失败。

## 已验证环境

| 项目 | 版本 / 说明 |
| --- | --- |
| 发行版 | Arch Linux（滚动更新） |
| 会话 | Wayland（Electron 使用 Ozone Wayland 后端） |
| Node.js | 24.14.0 |
| pnpm | 10.33.0 |
| Electron | 44.7.2 |
| 桌面 | 需要 StatusNotifierItem 托盘宿主（KDE 原生支持；GNOME 需 AppIndicator 扩展） |

## 初始化

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm start
```

开发模式（Vite + Electron）：

```bash
pnpm run dev
```

Linux 不需要执行 `build:screenshot-helper`、`prepare:mpv` 或 `prepare:mingit`：

- 截图助手是 Windows 原生程序，非 Windows 平台会在运行时禁用截图热键与截图入口；
- 音乐使用系统 `mpv`；
- Git 使用系统 `git`。

可选系统依赖：

```bash
# Arch Linux
sudo pacman -S --needed git bash mpv ffmpeg libsecret
```

- `mpv`：在线音乐播放；
- `ffmpeg`（`ffprobe`）：飞书等渠道的音频时长探测；
- `libsecret` + 桌面密钥环：Gmail 凭据安全存储；没有可用密钥环时相关功能会降级；
- `bash`：Code/Work 模式的 `run_shell` 默认解释器；
- 可选 Playwright MCP：Linux/macOS 使用系统 Google Chrome（`google-chrome-stable`），启用该 MCP 前请先安装。

## 构建 Linux 包

```bash
# 快速验证解包目录
pnpm run package:linux:dir

# AppImage + tar.gz
pnpm run package:linux
```

产物位于 `release/`。当前 Linux 包使用系统 Git/mpv/截图能力，不包含 Windows 专用二进制。

## 当前适配范围

已适配：

- 构建、类型检查、Vitest 与 Vite 渲染构建在 Linux 通过；
- `run_shell` 在 Linux/macOS 默认使用 `bash`，显式传 `cmd` 会按平台默认映射到 `bash`；
- 截图助手路径按平台命名；缺失时禁用热键与聊天截图入口，不再启动失败；
- 桌宠窗口在 Linux 下保持可交互（见下方限制）；
- Gmail 安全存储、浏览器持久化、Git、LSP、open-in-app 等已有 Linux 分支继续生效；
- electron-builder 增加 Linux 配置，Windows 专用资源只在 Windows 包内出现。

仍受平台限制：

- **受限 Shell 沙箱**：SRT 沙箱目前只有 Windows 实现。Linux 下 `read-only` / `scoped` / `per-action` 档位的 `run_shell` 会按 fail-closed 拒绝；只有 `full` 权限可直接执行。日常代码读取、搜索请优先使用 Read/Glob/Grep。
- **原生截图**：`native/cyrene-screenshot` 依赖 Win32/DXGI/Direct2D，Linux 暂无原生实现。后续可用 Electron `desktopCapturer` 或 xdg-desktop-portal 补齐。
- **鼠标穿透**：Linux 原生 Wayland 下 Electron 的 `setIgnoreMouseEvents` 实测不可依赖。现已提供 `native/cyrene-overlay-host`（layer-shell + alpha input region）作为纯 Wayland 方案，详见 `docs/linux-wayland-overlay.md`；未启用或宿主不可用时回退普通窗口，透明边角仍会拦截点击。
- **开机自启**：`app.setLoginItemSettings` 在 Linux 上是 no-op，设置项当前不会生效。
- **应用内更新**：尚未配置 Linux 发布产物与更新源；`APPIMAGE` 环境外的更新检查会跳过。
- **Wayland 限制**：透明窗口、置顶层级、全局快捷键与托盘行为取决于合成器和桌面环境；遇到问题请同时记录 `XDG_SESSION_TYPE` 与桌面版本。

## 验证

```bash
pnpm run check:main
pnpm run check:preload
pnpm run build
pnpm test

pnpm run package:linux:dir
./release/linux-unpacked/cyrene
```

提交前至少覆盖：

1. 冷启动能显示桌宠与聊天窗口；
2. 在 Code 模式用 `full` 权限执行 `bash` 命令；
3. 设置页切换主题/图标/桌宠开关不崩溃；
4. `pnpm run package:linux:dir` 产物可启动。

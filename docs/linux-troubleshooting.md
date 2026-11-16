# Linux / Wayland 安装与排障

## 运行要求

- Wayland 会话，禁止 XWayland 作为唯一路径。
- KDE Plasma / Sway / Hyprland 等支持 `zwlr_layer_shell_v1` 的合成器：桌宠使用 layer-shell 宿主。
- GNOME/Mutter：自动使用 `cyrene-overlay-fullscreen`（`xdg_toplevel` 全屏 + 透明输入区域）。
- 打包产物需要 `dist/renderer`、`dist/preload`、`resources/bin/linux/cyrene-overlay-host` 与 `cyrene-overlay-fullscreen`。

## 依赖

| 功能 | 依赖 |
|---|---|
| 桌宠 overlay | 内置 `cyrene-overlay-host` / `cyrene-overlay-fullscreen` |
| Hyprland 截图 | `grim`、`slurp`（区域选择） |
| 其他桌面截图 | `xdg-desktop-portal` + 后端 |
| 全局快捷键 | Hyprland 使用 `hyprctl`；其他桌面尝试 GlobalShortcuts portal，失败回退 `globalShortcut` |
| Linux 沙箱 | `bubblewrap`、`socat`、`ripgrep` |
| 诊断 | `gdbus`（可选） |

Arch：

```bash
sudo pacman -S grim slurp bubblewrap socat ripgrep
```

Debian/Ubuntu：

```bash
sudo apt install grim slurp bubblewrap socat ripgrep
```

## 构建 / 运行

```bash
pnpm install
pnpm run build:overlay-host
pnpm run build
pnpm start
```

打包目录版：

```bash
pnpm run package:linux:dir
```

## 诊断

```bash
cyrene doctor
```

输出会话类型、桌面、截图/沙箱依赖、overlay 宿主、截图目录与 portal 信息。缺少必需项会标 `✗`，但不影响命令退出码。

无托盘环境可通过控制通道打开窗口：

```bash
cyrene control show-chat
cyrene control show-settings
cyrene control toggle-pet
cyrene control screenshot
```

## 已知问题

- Hyprland 的 Screenshot portal 当前非交互请求返回 `response 2`，代码回退到 `grim`。
- GlobalShortcuts portal 需要安装后的 `.desktop` app id；dev Electron 会回退。Hyprland 使用 `hl.bind` 自动绑定。
- GNOME 全屏 fallback 已验证协议路径（Hyprland 强制 fullscreen），Mutter 真机/顶栏副作用仍待验证。
- Linux 沙箱缺少 `socat` 时会 fail-closed，`run_shell` 受限命令不会执行。
- Toast 高度协议使用 offscreen 页；若出现抖动，运行 `cyrene doctor` 并附主进程日志。

## 桌面支持矩阵

| 桌面 | overlay | 截图 | 全局热键 | 状态 |
|---|---|---|---|---|
| Hyprland | layer-shell 实测 | grim/slurp 实测 | hyprctl 实测 | 主要验证环境 |
| KDE Plasma | layer-shell（预期） | portal | portal | 待 E2E |
| Sway | layer-shell（预期） | grim/slurp（预期） | portal | 待 E2E |
| GNOME | fullscreen fallback | portal | portal | fallback 协议路径验证，Mutter 待 E2E |

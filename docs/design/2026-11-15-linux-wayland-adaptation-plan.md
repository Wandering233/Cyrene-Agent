# Linux / Wayland 受限能力适配方案

> 适用分支：`cyreneOnHyprland`
> 基线环境：Arch Linux + Hyprland 0.57.1 + Wayland，Electron 44.7.2，Node 24.14.0，XWayland `DISPLAY=:0`
> 本文是方案，不代表这些能力已经全部实现；当前已落地的范围见 `docs/linux-development.md`。

## 1. 结论先行

Linux 下真正难的不是“Electron 能不能启动”，而是 Wayland 的协议边界：

- Wayland 不允许客户端查询或设置顶层窗口的全局坐标；
- 没有跨桌面环境的标准“窗口置顶 / 逐像素鼠标穿透 / 任意位置悬浮”协议；
- 应用不能直接读全局鼠标位置；
- 全局快捷键、截图、屏幕共享必须经过 `xdg-desktop-portal`，且行为由桌面环境决定；
- Electron 暴露的 `setIgnoreMouseEvents(..., { forward: true })` 只在 Windows/macOS 有鼠标事件转发。

因此建议采用**双后端**，而不是强行把 Electron 改造成原生 Wayland 桌面宠物：

| 模式 | 定位 | 桌宠位置/拖拽 | 鼠标穿透 | 截图 | 适用场景 |
| --- | --- | --- | --- | --- | --- |
| **XWayland 兼容模式（近期默认）** | 整个 Electron 进程使用 `--ozone-platform=x11` | 可读写坐标、可拖拽、可持久化 | 主进程轮询光标 + 渲染层 alpha 命中测试 | 仍走 portal | Hyprland/Sway/KDE/GNOME 的 Wayland 会话，优先功能完整 |
| **原生 Wayland 模式（逐项开放）** | Electron 使用 `--ozone-platform=wayland` | 坐标不可用，交给合成器移动 | 只能整窗忽略/恢复，或手动切换交互模式 | portal | 偏好原生缩放/输入法/延迟，接受桌宠功能降级 |
| **原生 layer-shell 桌宠（长期）** | 独立原生进程 + `wlr-layer-shell` | 可精确定位 | 可设置 `wl_surface` input region | 复用 portal | Hyprland/Sway 等 wlroots 系；GNOME/KDE 不支持该协议 |

**近期推荐**：Wayland 会话默认走 XWayland 兼容模式，同时保留原生 Wayland 开关；截图、快捷键、沙箱、自启动按下面的独立方案补齐。这样能在一到两周内恢复绝大部分可用性，而不是等待 Electron 暴露 Wayland 协议能力。

---

## 2. 本机实测基线

2026-11-15 在当前机器上用独立 Electron 探针验证：

| 能力 | 原生 Wayland（`--ozone-platform=wayland`） | XWayland（`--ozone-platform=x11`） |
| --- | --- | --- |
| `screen.getCursorScreenPoint()` | 返回 `{x:0,y:0}` | 返回真实坐标，如 `{x:445,y:326}` |
| `BrowserWindow.getPosition()` | hide 时返回请求值；show 后返回 `[0,0]` 或缓存值 | 返回真实位置 |
| `setPosition()` | 不报错，但合成器不保证生效；`hyprctl clients` 中 Wayland 窗口没有可读 x/y | 实际生效；`hyprctl clients` 验证到 `at:[555,444]` |
| `setIgnoreMouseEvents(true,{forward:true})` | 调用成功，但 `forward` 无 Wayland 实现 | 调用成功，X11 路径可用 |
| `setShape()` | 调用成功，但不能证明 Wayland 下生效；Electron 标注 experimental | X11 下基于 XShape，可继续验证 |
| `globalShortcut.register()` | 返回 true；关闭时出现 `xdg-desktop-portal` GlobalShortcuts session 日志 | 返回 true |
| `startSystemMove()` | Electron 44 类型和运行时均无此 API | 同左 |
| Tray | 创建成功；本机由 quickshell 提供 `org.kde.StatusNotifierWatcher` | 同左 |

当前桌面和 portal 事实：

```text
XDG_CURRENT_DESKTOP=Hyprland
WAYLAND_DISPLAY=wayland-1
DISPLAY=:0                     # XWayland 可用
xdg-desktop-portal             1.22.1
xdg-desktop-portal-hyprland    1.5.0
Portal Screenshot              v2（AvailableTargets=0，target 选项需要 v3）
Portal ScreenCast              v6
Portal GlobalShortcuts         v1
Portal RemoteDesktop           未暴露
bubblewrap                     0.13.1
ripgrep                        15.2.0
socat                          未安装
unprivileged user namespace    可用（unshare -Ur true 成功）
Hyprland 托盘宿主              quickshell 的 StatusNotifierWatcher
grim / slurp / wl-copy         已安装（可作为 wlroots 系兜底）
```

这些结果直接决定方案：

1. **XWayland 能解决桌宠的坐标、拖拽和光标轮询问题**；
2. **原生 Wayland 下不要依赖 `getPosition` / `setPosition` / 全局光标位置**；
3. **截图和全局快捷键应统一走 portal，而不是围绕 Electron 窗口 API 设计**；
4. **`socat` 缺失会直接让 SRT Linux 沙箱不可用**，必须进入前置检查。

---

## 3. 总体架构

新增一个平台能力层，所有后端选择集中在这里，避免 `process.platform === "linux"` 散落在业务代码：

```text
src/main/platform/
├── capabilities.ts          # 启动前同步探测：会话类型、XWayland、后端选择
├── linux/
│   ├── session.ts           # Wayland / X11 / XWayland 判定
│   ├── portals.ts           # D-Bus portal 客户端（Screenshot/ScreenCast/GlobalShortcuts）
│   ├── status-notifier.ts   # 托盘宿主探测
│   ├── autostart.ts         # XDG autostart
│   ├── sandbox.ts           # Linux bubblewrap 沙箱适配
│   └── window-backend.ts    # X11/XWayland 与原生 Wayland 的差异封装
├── screenshot/
│   ├── backend.ts           # 统一 ScreenshotBackend 接口
│   ├── portal-backend.ts
│   └── x11-backend.ts
└── window/
    ├── pointer-hit-test.ts  # XWayland 光标轮询 + alpha 命中
    └── input-mode.ts        # 原生 Wayland 的交互模式状态机
```

### 3.1 启动前选择窗口后端

窗口后端必须在 `app.ready` 之前决定：

```ts
// 伪代码
function chooseOzonePlatform(settings: GeneralSettings): "wayland" | "x11" {
  if (process.platform !== "linux") return undefined;
  if (!process.env.WAYLAND_DISPLAY) return "x11";       // 纯 X11 会话
  if (!process.env.DISPLAY || !canReachXWayland()) return "wayland"; // 没有 XWayland
  switch (settings.linuxWindowBackend) {
    case "wayland": return "wayland";
    case "x11": return "x11";
    case "auto":
    default:
      // 近默认：优先功能完整。用户可在设置里切原生 Wayland。
      return "x11";
  }
}
```

同时支持紧急覆盖，便于用户排障：

```bash
CYRENE_OZONE_PLATFORM=wayland pnpm start
CYRENE_OZONE_PLATFORM=x11 pnpm start
```

设置项加入 GeneralSettings，变更后提示“重启后生效”。不要在一次运行中动态切换 Ozone 后端。

### 3.2 能力探测结果

统一暴露给主进程、设置页和诊断日志：

```ts
export interface PlatformCapabilities {
  session: "wayland" | "x11" | "unknown";
  ozonePlatform: "wayland" | "x11";
  xwaylandAvailable: boolean;
  portals: {
    screenshot: number | null;      // interface version
    screenCast: number | null;
    globalShortcuts: number | null;
    remoteDesktop: number | null;
  };
  trayHost: boolean;
  sandbox: {
    bwrap: string | null;
    socat: string | null;
    ripgrep: string | null;
    userns: boolean;
    apparmorRestrictsUserns: boolean;
  };
  screenshotBackend: "windows-helper" | "portal" | "none";
}
```

建议增加一个 `cyrene doctor --linux`（或设置页“环境诊断”）输出这些字段，减少用户报障时反复追问桌面环境。

---

## 4. 桌宠窗口：位置、拖拽、置顶、穿透

### 4.1 问题本质

Wayland 的 `xdg-shell` 不提供：

- 客户端设置顶层窗口的全局坐标；
- 客户端读取窗口在屏幕上的真实位置；
- 标准的“always on top”层级；
- 逐像素输入区域（核心协议有 `wl_surface.set_input_region`，但 Electron 不暴露）；
- 任意改变窗口在合成器中的层级/工作区。

因此原生 Wayland 下，现有代码中的 `win.getPosition()`、`setPosition()`、`screen.getCursorScreenPoint()`、`setAlwaysOnTop()` 都不能作为可靠事实源。

### 4.2 方案 A：XWayland 兼容模式（推荐先做）

**能力**：

- `screen.getCursorScreenPoint()` 返回真实坐标；
- `win.getBounds()/setPosition()` 可用；
- XShape / X11 输入区域可用（`setShape` 或 `setIgnoreMouseEvents`）；
- 桌宠位置持久化、跨显示器恢复、拖拽移动均可沿用现有逻辑。

**实现步骤**：

1. 启动时按 3.1 选择 `--ozone-platform=x11`；
2. 保留现有 `petWindowX/petWindowY` 持久化逻辑；
3. 在 `create-pet-window.ts` 中把“仅 Windows/macOS 才 setIgnoreMouseEvents”改为按实际后端判断：XWayland 下允许；
4. 新增主进程光标轮询：

```ts
// 只用于 X11/XWayland，且窗口可见、非拖拽状态
const timer = setInterval(() => {
  if (!win.isVisible() || petDragging) return;
  const point = screen.getCursorScreenPoint();
  const bounds = win.getBounds();
  if (!contains(bounds, point)) {
    win.setIgnoreMouseEvents(true);
    return;
  }
  // 把相对坐标发给渲染层；渲染层用 WebGL 读 alpha 后回调 setInteractive
  win.webContents.send(IPC.PET_POINTER_SAMPLE, {
    x: point.x - bounds.x,
    y: point.y - bounds.y,
  });
}, 50);
```

渲染层复用现有 `ClickThroughController` 的 `hitTestAlpha`，新增一个 `handleExternalMove({x,y})`，按 20Hz 节流，仅在状态变化时调用 `window.cyrene.setInteractive(interactive)`。避免主进程读整帧 alpha，避免 IPC 往返阻塞。

5. `win.setIgnoreMouseEvents(true)` 与 `setShape()` 二选一：
   - 优先 `setIgnoreMouseEvents`，因为实现简单；
   - 若目标桌面在 XWayland 下对 `setIgnoreMouseEvents` 支持不稳定，则用 `setShape` 传入按 alpha 粗粒度生成的矩形集合（例如 8×8 网格合并），但不要每次鼠标移动都重算 shape；
6. 拖拽期间暂停轮询，拖拽结束恢复，防止窗口移动和命中测试竞争；
7. 多显示器：保存 `display.id` 或相对 workArea 的比例，恢复时用 `screen.getDisplayMatching()` 校验；不要只保存绝对坐标。

**验收**：Hyprland、KDE Wayland、GNOME Wayland（XWayland）下分别验证：启动位置恢复、拖到第二屏、重启恢复、透明区域点击穿透、模型区域可点击、拖拽不抖动。

### 4.3 方案 B：原生 Wayland 基础模式（功能降级但可运行）

**交互策略**：

- 默认 `setIgnoreMouseEvents(true)`，让桌宠不挡桌面；
- 托盘菜单或全局快捷键提供“交互模式”开关；
- 交互模式持续 5 秒无操作后自动恢复穿透；
- 交互模式下允许点击模型、打开聊天、执行 Live2D 互动；
- 不提供应用内拖拽定位；提示用户使用合成器窗口移动：
  - Hyprland：`Super + 鼠标左键` 拖动浮窗；
  - GNOME：`Super + 鼠标左键`；
  - KDE：`Alt + 鼠标左键`；
- 不持久化窗口坐标，因为读不到；
- `setAlwaysOnTop` 不保证生效，依赖桌面窗口规则；
- 多显示器/缩放：依赖合成器。

**为什么不直接做“每像素穿透”**：原生 Wayland 下没有全局光标位置；Electron 不暴露 `wl_surface.set_input_region`，所以无法知道鼠标在透明像素还是模型像素上。只能整窗切换交互状态。

**验收**：Hyprland + 裸 Waybar（无托盘）、GNOME Wayland 下至少能通过快捷键/托盘/聊天窗口找回交互；不出现窗口卡死或永久无法点击。

### 4.4 方案 C：原生 layer-shell 桌宠（长期，单独评估）

真正接近 Windows 体验的原生方案，需要独立于 Electron 窗口栈：

- 使用 `wlr-layer-shell-unstable-v1` 创建 `overlay` / `top` 层窗口；
- 用 `wl_surface.set_input_region` 实现逐像素输入区域；
- 用 `wl_surface.set_buffer_transform` / `wp_viewporter` 处理缩放；
- 渲染层需要原生宿主：GTK4 + WebKitGTK、CEF 或直接 OpenGL + Live2D SDK；
- 与现有 Electron 主进程通过 Unix socket / shared memory / Wayland DMA-BUF 交换状态和帧；
- 仅支持实现 layer-shell 的合成器（Hyprland、Sway 等 wlroots 系），GNOME 和 KDE 不支持该协议。

**结论**：这是一次桌面宠物窗口栈重写，不建议在 1.x 阶段做。除非产品明确只支持 Hyprland/Sway，并且愿意维护第二套渲染宿主。

### 4.5 置顶、透明、激活

| 能力 | XWayland | 原生 Wayland | 建议 |
| --- | --- | --- | --- |
| 窗口置顶 | X11 `_NET_WM_STATE_ABOVE`，合成器通常支持 | 无标准协议；`setAlwaysOnTop` 可能被忽略 | XWayland 默认；原生模式提示依赖窗口规则 |
| 透明背景 | 合成器按 ARGB 处理 | 当前 Hyprland 缺少 `zcr_alpha_compositing_v1` 警告，但窗口仍可能透明 | 保留不透明回退；设置里提供“禁用透明” |
| 从后台唤起 | X11 激活通常可用 | 受 xdg-activation 限制，可能只闪任务栏 | 主动消息改用系统通知；关键操作由用户点击触发 |
| 窗口尺寸/缩放 | XWayland 跟随合成器缩放 | `setSize` 受合成器限制 | 不强行设置超出工作区的尺寸 |

本机日志出现过：

```text
Server doesn't support zcr_alpha_compositing_v1.
```

这不等于透明一定失败，但说明不能把它当成跨合成器保证。建议增加一个启动自检：创建 1×1 透明窗口并截图/读像素，判断实际 alpha；失败时自动回退到不透明背景，而不是显示黑块。

---

## 5. 截图：Wayland 优先走 xdg-desktop-portal

### 5.1 后端选择

```text
Windows        → 现有 Rust cyrene-screenshot.exe
Linux Wayland  → xdg-desktop-portal Screenshot（首选）
Linux X11      → portal Screenshot / Electron desktopCapturer / 现有 X11 实现
无 portal      → 可选的 grim/slurp（仅 wlroots 系）或禁用
```

### 5.2 Portal Screenshot 方案

本机 `org.freedesktop.portal.Screenshot` 版本为 2，支持：

- `interactive`：是否让 portal 先提供区域/窗口选择 UI；
- `modal`；
- `handle_token`；
- 返回 `uri`（通常是 `file:///home/.../Pictures/...png`）。

版本 3 才支持 `target`（Screen/Window/Area/Active Window）。因此当前环境不要依赖 `target`。

调用流程：

```ts
// 使用 dbus-next（新增依赖）
const bus = dbus.sessionBus();
const portal = await bus.getProxyObject(
  "org.freedesktop.portal.Desktop",
  "/org/freedesktop/portal/desktop",
);
const screenshot = portal.getInterface("org.freedesktop.portal.Screenshot");

const token = `cyrene_${randomUUID().replaceAll("-", "")}`;
const requestPath = await screenshot.Screenshot("", {
  handle_token: new Variant("s", token),
  interactive: new Variant("b", false),
  modal: new Variant("b", false),
});

const request = (await bus.getProxyObject(
  "org.freedesktop.portal.Desktop",
  requestPath,
)).getInterface("org.freedesktop.portal.Request");

const [response, results] = await new Promise((resolve) => {
  request.on("Response", (code, values) => resolve([code, values]));
});
if (response !== 0) throw new Error("SCREENSHOT_CANCELLED");

const uri = results.uri.value as string;
const sourcePath = fileURLToPath(uri);
```

注意：

- `Response` 信号可能在 `Screenshot()` 返回前就到达，必须先按 `handle_token` 预测 request path 并提前订阅，或使用 portal 文档推荐的“先算 handle 再调用”模式；
- portal 返回的是用户目录下的文件，应用应复制到 `userData/screenshots/`（0600），再决定是否删除原文件；不要假设文件名/目录固定；
- 用户取消、超时、portal 重启都要有明确错误码和 UI 提示；
- 截图属于敏感数据，不得上传，不写入日志，错误信息不要带图片路径以外的隐私内容。

### 5.3 区域选择与标注

两种 UX，建议第一期先用 portal 自带的交互：

1. **Portal 交互选择（快）**  
   `interactive: true`，用户使用桌面自带的区域/窗口选择器；返回后直接插入聊天或复制剪贴板。  
   优点：无需自定义 overlay，跨桌面行为一致；缺点：无法在选区阶段标注。

2. **先全屏截图，再自定义 overlay（完整）**  
   `interactive: false` 截取全屏，创建每个显示器一个 fullscreen 透明 `BrowserWindow`，把截图作为背景，绘制选区、箭头、文字、马赛克，最后 canvas 导出 PNG 到 `userData/screenshots/`，同时 `clipboard.writeImage(nativeImage)`。  
   适用于 Hyprland/KDE/GNOME；fullscreen 窗口不需要全局坐标，只要合成器允许全屏即可。  
   需要处理：
   - 多显示器坐标映射；
   - HiDPI（`devicePixelRatio`）；
   - 截图是“整个虚拟桌面”还是“当前显示器”的差异（当前 portal v2 需要实测）；
   - 选区取消不得写入临时文件。

建议接口：

```ts
interface ScreenshotBackend {
  capture(options: { interactive: boolean }): Promise<{ filePath: string; width: number; height: number }>;
  isAvailable(): boolean;
}
```

`src/main/screenshot/screenshot-service.ts` 只依赖这个接口，Windows helper 和 Linux portal 各自实现。

### 5.4 Electron desktopCapturer 是否可用

`desktopCapturer` 在 Wayland 下是否返回可用源、是否弹 portal、是否能拿到全分辨率帧，取决于 Chromium 版本与 portal 实现。建议做一个**一天 spike**：

1. `desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })`；
2. 用返回的 source id 在隐藏 renderer 中 `navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: id } } })`；
3. 把 video 帧画到 canvas，验证分辨率/多显示器/取消行为。

如果可行，可省掉 `dbus-next` 依赖；否则用 portal Screenshot 直连。不要把 desktopCapturer 作为唯一方案，因为 Wayland 下 source 枚举和权限行为历史上不稳定。

### 5.5 X11 / wlroots 兜底

- X11/XWayland：`desktopCapturer` 或现有 X11 捕获路径；
- Hyprland/Sway：可选调用 `grim` + `slurp`，但这是显式依赖，不应成为默认；
- GNOME/KDE：只用 portal，不要调用 DE 专属工具。

### 5.6 全局热键与截图的关系

本机 `globalShortcut.register()` 在 Wayland 下返回 true，并出现 portal GlobalShortcuts session 日志。仍需验证：

- 首次注册是否弹用户授权；
- 用户拒绝后如何反馈；
- 快捷键是否在焦点窗口之外真实触发；
- 桌面重启/portal 重启后是否自动恢复。

建议截图热键在 portal 截图后端就绪后再注册；否则先保留聊天按钮。

---

## 6. 全局快捷键

### 6.1 现状

本机探针结果：Wayland 下 `globalShortcut.register("Alt+Shift+F12")` 返回 true；退出时 portal 报 `Session.Close` / `Request.Close` UnknownMethod。这说明 Electron 44 已经在走 GlobalShortcuts portal，而不是 XGrabKey。

### 6.2 方案

1. 保留 Electron `globalShortcut` 作为统一入口；
2. 启动时探测 portal GlobalShortcuts 是否可用（DBus interface + version）；
3. 首次注册时给用户明确提示：“Wayland 下快捷键由桌面门户管理，可能弹授权窗口”；
4. 不要用 `register()` 的返回值判断快捷键真的生效：增加一次“用户按键确认”或直接使用 portal 的 `Activated` 信号做自检；
5. 如果 portal 不可用：
   - XWayland 模式：继续用 X11 globalShortcut；
   - 原生 Wayland：隐藏快捷键设置或提示“当前桌面不支持全局快捷键”；
   - 保留聊天窗口内的按钮作为兜底。
6. 提供“恢复默认快捷键”和“冲突检测”；桌面环境的快捷键冲突由 portal 报告，不能静默失败。

### 6.3 直接使用 portal 的时机

如果 Electron 的注册状态无法满足产品需求（例如需要显示“已绑定/未绑定”），再用 `dbus-next` 直接实现：

- `CreateSession`
- `BindShortcuts`（`preferred_trigger` + description）
- 监听 `Activated` / `Deactivated` / `ShortcutsChanged`
- 保存 session handle 与用户配置

这会比 Electron 封装多一层复杂度，建议先以 Electron 为主，portal 直连作为 P1。

---

## 7. 托盘与“无托盘桌面”

### 7.1 现状

本机 `Tray` 创建成功，宿主是 quickshell 的 `org.kde.StatusNotifierWatcher`。这不是所有 Hyprland 用户的默认配置：

- 裸 Hyprland + 没有 Waybar/quickshell 托盘模块 → 没有 StatusNotifierWatcher；
- GNOME 需要 AppIndicator 扩展；
- KDE 原生支持。

当前应用大量入口依赖托盘（打开聊天、设置、退出、显示/隐藏桌宠）。无托盘时用户可能“关掉聊天窗口后找不回应用”。

### 7.2 方案

1. 启动后通过 DBus 探测 `org.kde.StatusNotifierWatcher` 是否存在；
2. 无托盘时：
   - 不隐藏聊天窗口，或显示一个可关闭的“控制条”小窗口；
   - 注册一个全局快捷键（若 portal 可用）打开聊天；
   - 单实例第二次启动时通过本地 Unix socket 通知首实例 `show()`，不要只依赖窗口焦点；
   - 设置页显示“当前桌面没有系统托盘，请使用快捷键或重新启动应用”；
3. 托盘创建失败不要 crash；`createTray` 包 try/catch，返回 `null`，上层按无托盘降级；
4. 添加 `cyrene show` / `cyrene quit` CLI，经单实例 socket 控制，作为脚本和桌面的兜底。

### 7.3 验收

- Hyprland + quickshell：托盘菜单全部可用；
- Hyprland 无托盘宿主：能通过第二次启动或快捷键找回窗口，不丢失退出入口；
- GNOME + AppIndicator：托盘出现；
- GNOME 无扩展：降级提示正确。

---

## 8. 开机自启：XDG autostart

Electron 的 `app.setLoginItemSettings` 在 Linux 是 no-op，需要自己实现：

```ts
function syncLinuxAutostart(enabled: boolean) {
  const configHome = process.env.XDG_CONFIG_HOME
    ?? path.join(os.homedir(), ".config");
  const dir = path.join(configHome, "autostart");
  const file = path.join(dir, "cyrene.desktop");

  if (!enabled) {
    fs.rmSync(file, { force: true });
    return;
  }

  const exec = process.env.APPIMAGE ?? process.execPath;
  const contents = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Cyrene",
    "Comment=Live2D desktop AI companion",
    `Exec="${escapeDesktopExec(exec)}" --autostart`,
    "Terminal=false",
    "StartupNotify=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, contents, { mode: 0o644 });
}
```

要点：

- AppImage 必须用 `$APPIMAGE`，不能用 `process.execPath`（临时挂载路径）；
- 打包目录版用 `process.execPath`；
- 处理空格、引号、`%` 等 desktop entry 转义；
- `--autostart` 启动时不要弹欢迎页/免责声明；如果未接受免责声明，按现有逻辑隐藏桌宠；
- 开发模式（`!app.isPackaged`）默认不写自启，避免把 `electron .` 写进用户 autostart；
- 测试用临时 `XDG_CONFIG_HOME`，断言启用/禁用/重复启用幂等。

如果后续需要日志和自动重启，可再提供 systemd user unit，但不是首期必需。

---

## 9. 应用内更新

### 9.1 约束

- `electron-updater` 在 Linux 只对 AppImage 提供原位更新；
- tar.gz / deb 只能手动升级；
- 必须有 `latest-linux.yml` 和对应的 AppImage 资产；
- `process.env.APPIMAGE` 不存在时（开发、unpacked、AppImage extract-and-run）不能尝试安装更新。

### 9.2 方案

1. 在 `app-update-service` 初始化时增加 Linux 能力判断：

```ts
const canAutoUpdate =
  process.platform !== "linux"
    ? true
    : Boolean(process.env.APPIMAGE) && app.isPackaged;
```

2. 不能自动更新时，设置页显示“当前为 Linux 目录版/压缩包版，请下载新版本手动替换”，隐藏“立即重启安装”；
3. 发布工作流增加 Linux job：
   - `pnpm run package:linux`
   - 上传 `release/*.AppImage`、`release/latest-linux.yml`、`release/*.tar.gz`
   - 标签版本与 `package.json` 一致性检查；
   - 先上传草稿，人工验证后再公开；
4. 更新完整性：
   - electron-builder 生成的 `latest-linux.yml` 已包含 sha512；
   - Phase 2 增加 minisign/GPG 签名验证，避免只依赖 GitHub 账户与 HTTPS；
5. 回滚：
   - 保留旧 AppImage 文件；
   - 更新失败时不清除旧文件；
   - 发布前的 `latest-linux.yml` 必须指向实际存在的资产。

### 9.3 测试

- 本地起一个静态 HTTP 服务模拟 GitHub feed；
- 打包旧版本 → 手动指定 feed → 检查 → 下载 → 重启；
- 断网、校验失败、磁盘只读、无 `APPIMAGE` 环境各测一次；
- 确认 tar.gz 构建不会显示自动更新按钮。

---

## 10. 受限 Shell 沙箱：Linux bubblewrap

这是 Code 模式的核心能力，优先级应高于桌宠扩展。

### 10.1 现状

`@anthropic-ai/sandbox-runtime` **本身支持 Linux**（bubblewrap + seccomp + 网络代理），当前代码只是在 `initSandbox/ensureSandboxReady/wrapWithSandbox` 里显式跳过非 Windows。

本机依赖：

- `bwrap` 0.13.1 已安装；
- `ripgrep` 已安装；
- `socat` 未安装（Linux 网络隔离必需）；
- `unshare -Ur true` 成功，无 AppArmor 限制文件。

### 10.2 改造点

把 `sandbox-exec.ts` 拆成平台适配：

```ts
type SandboxPlatform = "windows" | "linux" | "macos";

async function initSandboxForPlatform() {
  if (platform === "windows") return initWindowsSandbox();
  if (platform === "linux") return initLinuxSandbox();
  return { supported: false };
}

async function initLinuxSandbox() {
  const deps = await SandboxManager.checkDependenciesAsync();
  if (deps.errors.length > 0) {
    throw new SandboxUnavailable(
      `Linux 沙箱缺少依赖: ${deps.errors.join(", ")}。请安装 bubblewrap、socat、ripgrep。`,
    );
  }
  // 不安装任何东西；Linux 没有 UAC 安装流程
}
```

Linux 初始化配置不再传 `windows.srtWin`：

```ts
const config: SandboxRuntimeConfig = {
  network: {
    allowedDomains: [],
    deniedDomains: [],
  },
  filesystem: {
    // 默认读全开；project-read-only 才额外 deny 用户目录再 allow workspace
    allowWrite: level === "project-read-only" || level === "read-only"
      ? []
      : [workspaceRoot],
    denyRead: DEFAULT_SECRET_READ_DENY,
    denyWrite: DEFAULT_WRITE_DENY,
  },
};
await SandboxManager.initialize(config);
```

权限档位映射建议：

| 档位 | allowWrite | 额外 denyRead | 说明 |
| --- | --- | --- | --- |
| `project-read-only` | `[]` | `~/.ssh`、`~/.aws`、浏览器配置等 | 默认读全开，工作区只读；需要更严格时再 deny `/home` + allow workspace |
| `read-only` | `[]` | 同上 | 与 Windows 语义保持一致 |
| `scoped` | `[workspaceRoot]` | 敏感目录 | 工作区可写 |
| `per-action` | `[workspaceRoot]`（审批后） | 敏感目录 | 单次审批仍需沙箱 |
| `full` | 不走沙箱 | - | 保持现有显式直跑 |

注意：`read-only` 不等于“只允许读工作区”。如果要实现“工作区外不可读”，需要 `denyRead: ["/home"]` + `allowRead: [workspaceRoot, "/usr", "/lib", "/bin", "/etc/..."]`，并做大量兼容性测试；建议首期先沿用与 Windows 一致的“读全开、写受限”语义，在文档里写清楚。

### 10.3 网络隔离

Linux 下 SRT 会启动 HTTP/SOCKS 代理，并把命令放进无网络 namespace。需要：

- `socat` 在 PATH 或显式路径；
- 允许域名列表按任务注入（例如 `registry.npmjs.org`、`github.com`）；
- 不允许的域名 fail-closed；
- 不要因为 `socat` 缺失而退化为直跑。

如果产品允许“无网络沙箱”，也应在 UI 上明确显示“网络已禁用”，而不是静默放行。

### 10.4 打包与分发

关键：`@anthropic-ai/sandbox-runtime/vendor/seccomp/<arch>/apply-seccomp` 是二进制，打进 asar 后无法执行。

需要：

1. `asarUnpack` 增加：
   ```yaml
   - "**/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/**"
   ```
2. 在代码中把 `__dirname` 解析出的 seccomp 路径重写到 `app.asar.unpacked`，与现有 `srt-win` 处理一致；
3. `bwrap`、`socat`、`rg` 三选一策略：
   - **系统依赖**：包依赖声明 `bubblewrap`、`socat`、`ripgrep`，启动检查并给出安装命令；
   - **AppImage 自带**：在 `resources/bin/linux/<arch>/` 放静态二进制，更新 `PATH`/显式 `bwrapPath`/`socatPath`/`ripgrepConfig`；需要处理许可证与安全更新；
   - 推荐：AppImage 自带 bwrap/socat/rg，deb/pacman 用系统依赖；至少保证 AppImage 用户开箱可用。
4. 启动诊断输出依赖版本；缺依赖时 Code 模式明确提示，不要只报“当前平台尚不支持”。

### 10.5 内核/发行版差异

- Arch：本机 unprivileged userns 开启，bwrap 0.13.1 正常；
- Ubuntu 24.04+：默认 `kernel.apparmor_restrict_unprivileged_userns=1`，需要用户调整 sysctl 或使用 setuid bwrap；安装文档必须写；
- 以 root 运行：需要 `CAP_SETFCAP`，不推荐；
- WSL1：不支持，直接拒绝；
- 沙箱内启动 Electron/Chromium 等自身使用 user namespace 的程序：可能需要 `allowNestedUserNamespaces: true`，但这会削弱沙箱边界，必须单独提示。

### 10.6 测试

- 单元：档位 → config 映射；错误信息；`CYRENE_SRT=0` 的显式 disabled；
- 集成（真实 bwrap）：
  - `read-only` 下 `touch` 失败；
  - `scoped` 下工作区可写、工作区外不可写；
  - `read-only` 下读取 `.ssh` 被拒绝（如果启用 denyRead）；
  - 网络 allowedDomains 内 `curl` 成功、域外失败；
  - `full` 直跑；
  - 缺 `socat` / `bwrap` 时 fail-closed；
  - 取消、超时、后台任务 killTree；
- 打包：在 AppImage 内验证 seccomp 二进制可执行、bwrap 路径正确。

---

## 11. 其它 Wayland 行为

| 功能 | 风险 | 方案 |
| --- | --- | --- |
| 透明窗口 | 合成器差异/黑底 | 启动自检 + 不透明回退；文档标明 Hyprland 警告不等于失败 |
| 置顶/层级 | 无标准协议 | XWayland 默认；原生模式依赖窗口规则 |
| 激活/聚焦 | 后台唤起可能只闪任务栏 | 主动消息用系统通知；关键操作用户点击；单实例 socket 兜底 |
| 多显示器/缩放 | 坐标不可读；HiDPI 映射复杂 | XWayland 统一坐标；原生模式不持久化位置 |
| 托盘 | 无 StatusNotifier 宿主 | 探测 + 无托盘降级 + CLI/socket |
| 全局快捷键 | portal 授权/重启 | Electron portal + 状态自检 + X11 兜底 |
| 剪贴板 | 图片/文本 MIME | Electron clipboard，Wayland 下验证 image/png |
| 文件选择器 | portal 行为 | Electron dialog；失败时用 portal FileChooser |
| 音乐播放 | mpv 与 PipeWire | 系统 mpv；`--ao=pipewire` 可选；检测失败降级 |
| Playwright MCP | 需要 Chrome | Linux/macOS 用 `chrome`；无 Chrome 时提示安装或用 Playwright Chromium |
| 自动更新 | 仅 AppImage | 见第 9 节 |

---

## 12. 分阶段实施计划

### Phase 0：能力探测与后端开关（1–2 天）

- 新增 `platform/capabilities.ts`、`platform/linux/session.ts`；
- GeneralSettings 增加 `linuxWindowBackend: "auto" | "wayland" | "x11"`；
- 启动前设置 Ozone 后端，支持环境变量覆盖；
- 启动日志/诊断页输出 portal、托盘、沙箱依赖状态；
- 不改任何业务行为，默认 `auto → x11`（有 XWayland 时）。

**退出标准**：两种后端都能启动；日志能一眼看出当前走的是 Wayland 还是 XWayland。

### Phase 1：XWayland 功能恢复（3–5 天）

- 恢复桌宠位置持久化、多屏恢复、拖拽；
- 主进程光标轮询 + 渲染层 alpha 命中，恢复逐像素穿透；
- 原生 Wayland 模式加“交互模式”开关和 5 秒自动穿透；
- 无托盘检测与降级控制条/快捷键；
- XDG autostart。

**退出标准**：Hyprland 上桌宠点击/拖拽/穿透/重启位置恢复可用；无托盘也能找回应用。

### Phase 2：截图、沙箱、发布（1–2 周）

- Portal Screenshot 后端 + 自定义选区/标注 overlay；
- Linux bubblewrap 沙箱接入 + 打包 seccomp/bwrap/socat；
- Linux 发布工作流 + AppImage 更新；
- 全局快捷键 portal 状态与授权提示。

**退出标准**：`run_shell` 在 read-only/scoped 下真实受限；截图在 Hyprland/KDE/GNOME Wayland 可用；AppImage 更新可验证。

### Phase 3：原生 Wayland 增强（2–4 周，按需）

- Electron `desktopCapturer` / PipeWire ScreenCast 的持久授权与低延迟方案；
- 原生 Wayland 模式的多显示器/缩放优化；
- 评估原生 layer-shell 桌宠宿主（Hyprland/Sway 专属）；
- 更新签名、Linux CI 矩阵（Hyprland/Sway/KDE/GNOME）。

---

## 13. 验证矩阵

| 场景 | Hyprland | Sway | KDE Wayland | GNOME Wayland | X11 |
| --- | --- | --- | --- | --- | --- |
| XWayland 后端启动 | 必须 | 必须 | 必须 | 必须 | 必须 |
| 原生 Wayland 后端启动 | 必须 | 必须 | 必须 | 必须 | - |
| 桌宠位置恢复 | XWayland | XWayland | XWayland | XWayland | 必须 |
| 逐像素穿透 | XWayland | XWayland | XWayland | XWayland | 必须 |
| 截图 portal | 必须 | 必须 | 必须 | 必须 | 可选 |
| 全局快捷键 | 必须 | 必须 | 必须 | 必须 | 必须 |
| 托盘 | quickshell/waybar | waybar | 原生 | AppIndicator | 原生 |
| 无托盘降级 | 必须 | 必须 | - | 必须 | - |
| 沙箱 bwrap | 必须 | 必须 | 必须 | 必须 | 必须 |
| 自启动 | 必须 | 必须 | 必须 | 必须 | 必须 |
| AppImage 更新 | 必须 | 必须 | 必须 | 必须 | - |

手工验收至少包含：

1. 冷启动：桌宠出现，聊天窗口可打开；
2. 鼠标在透明区域点击能穿透到桌面，在模型区域点击能触发交互；
3. 拖拽到第二屏，重启后位置合理；
4. 托盘不存在时仍能找回窗口/退出；
5. 截图取消、全屏、区域、多屏、HiDPI；
6. `read-only` 下写命令被拒绝，`full` 下可执行；
7. `latest-linux.yml` 与 AppImage 实际文件一致。

---

## 14. 需要决策的点

1. **默认后端**：建议 Wayland 会话默认 XWayland，换取功能完整；是否接受 XWayland 的缩放/输入法差异，需要产品确认。
2. **截图 UX**：先用 portal 原生选区，还是直接投入自定义 overlay？建议先做 portal 交互版，再补标注。
3. **沙箱默认读权限**：是否首期就 deny 用户目录读取？安全更强但兼容性风险更高，建议分档位逐步收紧。
4. **是否打包 bwrap/socat/rg**：影响 AppImage 体积、许可证和安全更新；建议 AppImage 自带，包管理器走系统依赖。
5. **是否投入原生 layer-shell 桌宠**：只有明确只支持 Hyprland/Sway 时才值得做。
6. **更新签名**：是否接受首期只依赖 HTTPS + sha512，还是必须上线前完成签名验证。

---

## 15. 代码落点清单

| 模块 | 工作 |
| --- | --- |
| `src/main/application/pre-ready.ts` | Ozone 后端选择、能力探测 |
| `src/main/application/default-dependencies.ts` | 注入 capabilities、portal、sandbox |
| `src/main/windows/window-manager.ts` | 按后端切换位置/穿透/置顶策略 |
| `src/main/startup/create-pet-window.ts` | XWayland 初始化、原生模式交互状态 |
| 新 `src/main/platform/window/pointer-hit-test.ts` | XWayland 光标轮询 + alpha 命中 |
| 新 `src/main/platform/linux/portals.ts` | Screenshot/ScreenCast/GlobalShortcuts D-Bus |
| `src/main/screenshot/*` | ScreenshotBackend 抽象、portal 实现、overlay |
| `src/main/legacy-screenshot-removal.test.ts` | 放宽旧限制，区分“旧 overlay”与“新 portal/overlay” |
| `src/main/orchestrator/sandbox/sandbox-exec.ts` | Windows/Linux 平台拆分、Linux 初始化/包装 |
| `src/main/settings/launch-at-login.ts` | XDG autostart |
| `src/main/sync-mcp-builtin.ts` | 已改为非 Windows 用 Chrome；补依赖提示 |
| `src/main/tray.ts` | 创建失败降级、无宿主探测 |
| `src/main/updater/*` | AppImage 能力判断、Linux feed |
| `electron-builder.yml` | asarUnpack seccomp、Linux 资源、AppImage 依赖 |
| `.github/workflows/package-linux.yml` | Linux 构建/产物/更新元数据 |
| `docs/linux-development.md` | 用户视角安装/权限/限制 |

---

## 16. 结论

当前环境是一个“Wayland 会话 + XWayland 可用 + portal 完整 + bwrap 可用但缺 socat”的典型 Arch/Hyprland 环境。

最稳妥的路线不是追求纯 Wayland 桌宠，而是：

1. **先用 XWayland 恢复桌宠完整交互**；
2. **截图、快捷键、文件选择等跨桌面能力统一走 portal**；
3. **沙箱用 Linux 原生 bubblewrap，并补齐 socat/seccomp 打包**；
4. **逐步开放原生 Wayland 模式**，明确降级行为；
5. **只有产品明确只支持 Hyprland/Sway 时，再评估 layer-shell 独立桌宠进程**。

这样每一阶段都有可验证的退出标准，也不会把“Wayland 不支持”误判成“功能写不了”。

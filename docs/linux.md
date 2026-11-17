# Linux / Hyprland 开发与验收

更新于 **2026-11-18**。本文件统一 Linux 的安装、实现、86 项任务、验收和排障记录；适用分支为 `cyreneOnHyprland`。

## 范围与现状

使用 Electron 离屏渲染与 Rust 原生 Wayland 宿主。实机验证范围限于 **Arch Linux / Hyprland 0.57.1 / Electron 44.7.2 / x64**；其他桌面及 X11 不验，SRT 网络 allowlist、DNS 和代理继续暂缓。早期的 XWayland 备选方案已放弃，历史草图不再作为施工要求。

86 项目前为 **63 完成、9 部分完成、9 未完成、5 不适用**。“完成”按每项注明的验证范围计算；保留历史通过记录不代表当前最终包已完成交互复测。原测试期间确认 **26 次 Quickshell SIGSEGV**，隔离根因调查另有 7 次复现；完整 Caelestia 热插拔、真实设备和最终包完整业务交互仍待验证，详见下方崩溃记录。

本次读取到 Quickshell 0.3.2（AUR `quickshell-git`，revision `4f508be500dea6e5732cc3d50382a0048b17e7b1`）、Qt 6.12.0。13:59—14:03 的复核中，Caelestia 实例存活，35 个相关子进程为僵尸状态；03:20 至文档合并时未查到新增 Quickshell core。随后根因追查在隔离会话新增 7 次复现，主桌面的 Caelestia 实例保持原 PID；见“隔离复现与项目修复”。这不能替代界面正常和输入可用的验证。当前单输出为 HDMI-A-1，2238×1492@120Hz、scale=1，没有 Cyrene overlay；PATH 缺少 socat。

## 安装、开发与打包

需要 Node.js 24（本机 24.14.0）、pnpm 10.33.0、Rust stable 与 Wayland 会话。Arch Linux 系统依赖：

```bash
sudo pacman -S --needed git bash mpv ffmpeg libsecret grim slurp bubblewrap socat ripgrep python
pnpm install --frozen-lockfile
pnpm run build:overlay-host
pnpm run build
pnpm start
```

mpv 用于音乐，ffmpeg/ffprobe 用于音频处理，libsecret 配合桌面密钥环；grim/slurp 用于截图，python3 用于 Hyprland 快捷键脚本与 AppImage 更新 worker（需 Python 3.11+）；bubblewrap、socat、ripgrep 用于受限 Shell。当前缺少 socat，受限命令会拒绝执行；历史成功结果来自当时补齐依赖的探针。Linux 使用系统 Git/mpv，无需 Windows 的截图助手、MinGit 或 mpv 打包命令。

```bash
pnpm run dev                  # main/preload/CLI + Vite/Electron
pnpm run build:overlay-host   # 首次或修改 Rust 后执行
pnpm run package:linux:dir    # 解包目录
pnpm run package:linux        # AppImage + tar.gz，本地构建，不发布
pnpm run verify:linux-artifacts
```

产物在 `release/`，宿主从 `resources/bin/linux/` staging 到包内 `resources/bin/`，附 `SHA256SUMS`。校验检查版本、AppImage 路径/大小/sha512、完整宿主摘要、staging 和 `app-update.yml`。Linux 更新源指向 `Wandering233/Cyrene-Agent`；其他平台沿用原配置。目录版没有 `APPIMAGE` 时只支持手动更新；远程 CI、release、真实下载/升级和回滚尚未执行。

## 诊断与操作入口

构建后可直接调用 CLI，桌面控制命令要求应用正在运行：

```bash
node dist/cli/index.js doctor
node dist/cli/index.js control show-chat
node dist/cli/index.js control show-settings
node dist/cli/index.js control show-notifications
node dist/cli/index.js control show-pet-menu
node dist/cli/index.js control toggle-pet
node dist/cli/index.js control screenshot
node dist/cli/index.js control screenshot-window
node dist/cli/index.js control ping
```

需要全局 `cyrene` 时执行 `pnpm link --global`。托盘“提醒中心”或 `show-notifications` 主动打开可聚焦窗口，支持 Tab/Enter/Space/Escape；后台 Toast 保持非聚焦。外观设置的截图快捷键可录制、输入、应用及启用/禁用；录制期间暂停绑定，取消恢复，冲突或拒绝授权保留旧配置。

桌宠右键的“键盘菜单”、托盘“桌宠菜单（键盘）”或 `show-pet-menu` 打开独立普通窗口。Tab/方向键选择，Enter/Space 执行设置、隐藏桌宠或退出；Esc 和失焦关闭。菜单只有固定动作，没有文本输入；桌宠 layer 继续不接收键盘焦点。

`doctor` 检查依赖、会话、AppArmor 和本地宿主，缺项显示 ✗，当前不改变退出码，也不能证明沙箱执行或桌面交互正常。

## Wayland 实现与契约

```text
Electron offscreen BrowserWindow
  → JSON 帧头 + premultiplied BGRA bitmap
  → Unix socket
  → Rust wl_shm ARGB8888 / Wayland surface

宿主 pointer / drag / position / frame_ack
  → 主进程输入转发、坐标转换和位置持久化
```

layer 后端使用 `zwlr_layer_shell_v1`，fullscreen 后端使用全屏 `xdg_toplevel`；fullscreen 只在 Hyprland 强制启用验过，GNOME/Mutter 未验。layer 的输入区域按 alpha 和 4/6px 网格量化，边缘不是逐像素精度。崩溃按 500/1500/3000ms 重试，不可恢复时回退普通窗口；回退窗口透明角落仍可能拦截点击。

开发时查询 `native/cyrene-overlay-host/target/release` 或 `debug`，打包时查询 `resources/bin/`。Electron 创建 socket 并启动宿主，宿主连接该 socket。控制选项：

```bash
CYRENE_PET_OVERLAY=0 pnpm start
CYRENE_OVERLAY_BACKEND=fullscreen pnpm start
CYRENE_OVERLAY_HOST_BIN=/path/to/cyrene-overlay-host pnpm start
CYRENE_OVERLAY_SCALE=2 pnpm start
```

宿主版本为 **0.1.5**、协议为 1；缺省或不匹配版本会拒绝。帧由一行 JSON 头加 `stride × height` 字节组成，物理尺寸由逻辑尺寸和整数 buffer scale 决定。主进程使用全局坐标，wire `init/move` 使用输出内坐标，`position` 回传输出名称/原点/scale。拖拽累计全局位移，松手后选输出并重建 surface。

```json
{"type":"init","protocol":1,"width":400,"height":500,"x":100,"y":100,"scale":2,"output":"HDMI-A-1"}
{"type":"layer","layer":"bottom"}
{"type":"move","x":200,"y":200}
{"type":"frame","seq":1,"width":800,"height":1000,"stride":3200}
```

还有 `size/show/hide/interactive/cursor/quit` 控制，两个宿主共用有界流解析器，拒绝帧先于初始化、重复/倒序 seq、截断和超长输入。精确格式见 [Rust 协议](../native/cyrene-overlay-host/src/protocol.rs)与 [TS 协议](../src/main/pet-overlay/protocol.ts)。

输出断开时保存局部位置并迁到可用屏幕；同名重连可恢复，期间手动移动取消待恢复。Electron offscreen 缩小不可靠，返回低倍率屏保留本 renderer 生命周期达到的最高倍率超采样；逻辑大小和输入契约不变，完全降倍率需重建 renderer。fullscreen 固定 1x 并保留全屏 buffer。layer 不接收键盘/IME；桌宠菜单使用独立普通窗口。触控按主触点映射鼠标，其他触点不抢占，取消会释放按键；真实触屏与触控笔未验。

聊天、音乐、欢迎、表情包、通话、标注、提醒中心和键盘菜单已接入普通窗口定位。仅匹配同进程唯一且已映射的窗口；先明确 `float(action="enable")`，再 `resize` 和 `move`。支持记忆的窗口把实际 compositor 坐标与浮动/平铺模式原子写入 `userData/hyprland-window-bounds.json`，重建时恢复；欢迎、标注和菜单只定位，不保留上次尺寸。隐藏重显重新匹配 xdg 地址，真正全屏/最大化按 Hyprland 状态判断。`pin` 不等于置顶，WIN-02 未完成。

| 代码入口 | 用途 |
|---|---|
| [Rust host](../native/cyrene-overlay-host/src/main.rs) / [fullscreen](../native/cyrene-overlay-host/src/bin/cyrene-overlay-fullscreen.rs) | surface、输入、拖拽、输出和帧提交 |
| [stream.rs](../native/cyrene-overlay-host/src/stream.rs) / [output_layout.rs](../native/cyrene-overlay-host/src/output_layout.rs) | 流边界与布局选择 |
| [controller.ts](../src/main/pet-overlay/controller.ts) / [host-client.ts](../src/main/pet-overlay/host-client.ts) | 离屏渲染、socket、坐标、恢复 |
| [window-placement.ts](../src/main/linux/window-placement.ts) | 普通窗口布局和保存 |
| [cursor.rs](../native/cyrene-overlay-host/src/cursor.rs) / [touch_input.rs](../native/cyrene-overlay-host/src/touch_input.rs) | Chromium 光标名称转换、主触点与取消 |
| [pet-menu-window.ts](../src/main/pet-overlay/pet-menu-window.ts) | 主动打开的普通键盘菜单与动作权限 |
| [screenshot-lifecycle.ts](../src/main/screenshot/screenshot-lifecycle.ts) | 截图、快捷键与 IPC |
| [toast-accessibility.ts](../src/main/toast/toast-accessibility.ts) | 主动打开的键盘提醒窗口 |
| [overlay-host.mjs](../scripts/build/overlay-host.mjs) / [linux-artifacts.mjs](../scripts/verify/linux-artifacts.mjs) | staging、打包完整性校验 |

## 验证结果与限制

以下是已执行的结果，最近一次根因追查重新执行了项目检查；历史主桌面结果与隔离复现分别注明：

| 检查 | 结果与适用范围 |
|---|---|
| 全量 JS/TS | 最近一次 7134 通过、36 跳过；644 个文件通过、6 个跳过 |
| 产物校验回归 | 17 项通过，含替换/截断、错误元数据、宿主/staging/更新源不符及安装 worker 缺失/旧版 |
| 类型检查与构建 | main/preload/renderer、Vite/CLI/Rust 及 Linux 打包通过；有既有编译/大包警告 |
| Rust | layer 25 项、fullscreen 22 项通过，包含主触点/多点/取消边界 |
| 桌宠与缩放 | 历史透明区域穿透、点击/拖拽、2x 与 1.25、位置保存通过；1.5 未单独验 |
| 跨屏 | 历史右侧 1x→2x→1x 输入迁移通过；后期多次失败与 QS/锁屏异常并存，当前包交互需复测 |
| 普通窗口 | 主机实测位置/模式恢复、项目聊天最大化/还原、音乐透明像素/显式激活/重建，以及提醒 fallback 不抢焦点；左侧 2x 为历史结果，当前单输出跳过 |
| 快捷键 | 真实 Hyprland 注册、占用保护、修改、暂停/恢复、禁用/保存/退出解绑通过；portal 拒绝路径有测试 |
| 截图与标注 | grim 全屏/区域/窗口与剪贴板有实测；矩形内部无对角线，同尺寸 PNG 与 0600、取消/撤销通过 |
| Toast | 历史右下角 440×100、点击激活；独立提醒窗口 Tab/Enter/Space/Escape 通过 |
| 自启动/启动 | 较早 AppImage/目录版和 XDG autostart 有实测；当前最终包完成构建和摘要校验，启动/交互待复测 |
| 最新本地包 | 2026-11-18：AppImage 1083285644 字节、tar.gz 1091697430 字节；宿主 0.1.5；app.asar/两宿主/worker 实际归档摘要与最终构建/staging/源码一致，sha512/更新源通过；包内窗口最大化/透明/焦点回归通过 |
| 性能 | 历史 60s 主进程 RSS -7.0%、CPU 6.7%、fd 157→156；4K@120Hz 输出、600×750 layer 10s 发送 551 帧 |

帧发送上限为 60fps；约 1ms 是 host ack 延迟，0 dropped 是发送路径计数，均不代表显示呈现延迟或 120fps 渲染。短时主进程采样不能排除长期、宿主/renderer 或桌面 shell 的泄漏。出现 QS 崩溃或锁屏遮挡后，主应用单测、产物摘要和历史通过结果都不能替代完整桌面交互验收。

### 本轮窗口与输入验证

2026-11-17 的后续施工使用独立 runtime、私有 D-Bus 和关闭 XWayland 的嵌套 Hyprland。只在该实例创建/移除输出；主桌面的 QS/锁屏配置未改。

普通窗口探针发现两个原定位问题：Lua 绝对 resize 对平铺窗口不会自动改为浮动，且 Electron 的 maximized 标志也可能来自普通平铺窗口的 xdg configure。现在明确启用浮动，先调整尺寸再移动；全屏/最大化以 Hyprland 的 fullscreen 状态区分。隐藏重显会更换 xdg 地址，每次 show 都重新匹配，旧异步任务不能覆盖新一轮位置。用户切回平铺后保留模式，重建不再强制浮动。父窗口坐标从 compositor 读取，越界位置收回工作区。

光标原先只取得 ThemedPointer，没有调用 set_cursor。现在转发 Electron cursor-changed，宿主在 enter 后设置并缓存形状，重新 enter 使用新 serial；无 cursor-shape 时由 SCTK 读取系统主题并回退默认图标。隔离 trace 已验证手形、文本、隐藏和 grab 的请求。通过测试代理仅隐藏 cursor-shape global，已验证 Adwaita 手形、文本、隐藏、grab 的旧主题路径、enter serial 和截图像素；截图人工检查一致。2026-11-18 主机改用屏幕中央及宿主实际 bounds 后，warp 和真实 UInput motion 均收到 enter，主题回退截图也通过。旧左上角固定点超时不能据此断言锁屏阻断；custom 光标图片暂回默认图标。

两个宿主共用按 ID 跟踪的触控状态，只把第一触点映射为鼠标，其他触点不抢占或提前释放。cancel、隐藏、surface/seat 移除会清理；主进程把取消的 mouseUp 发到页面外并重置连击状态。真实 2x 离屏页面确认取消及宿主断连不触发按钮点击，下一次点击只执行一次。此结果是输入契约验证，不能替代真实触屏或触控笔测试；尚未接 tablet-v2，也未完成触控拖动手势。

键盘菜单为独立普通窗口，只有所属 webContents 可执行固定动作。后台不主动打开；加载失败可重试，关闭、失焦、退出会清理。真实 Electron 窗口验证 Tab、方向键、Enter、Space、Esc 和失焦行为；单测另验外部 sender、未知动作和重复打开。没有可编辑文本，IME 不作为该菜单的验收项。

```bash
pnpm run build:main
pnpm run build:preload
pnpm run build:overlay-host
pnpm run verify:linux-overlay-lifecycle
pnpm run verify:linux-window-input
pnpm run verify:linux-appimage-update
pnpm run verify:linux-window-behavior
```

这一阶段的隔离回归验证了光标 enter serial、5 次输出生命周期、普通窗口和 2x 取消点击；当时包内 0.1.4 宿主也通过。后续脚本已改为直接主机测试，结果见下一节。历史输出移除记录不能代替当前主机真实热插拔验收。

### 主机测试与环境清理

2026-11-17 23:45 后，按用户要求改为直接连接主机 Hyprland，不再新建嵌套 compositor、私有 D-Bus 或第二份 QS 配置。已清理 18 个临时环境目录，463 份日志、截图和复现配置归档到 `/tmp/cyrene-test-evidence-20261117`；当前只有主 Hyprland PID 1066，Caelestia PID 3038358。QS 已退出的僵尸子进程属于原父实例，无法通过 kill 回收，不计作运行中的嵌套环境。

```bash
pnpm run verify:linux-overlay-lifecycle                # 宿主实际 bounds 内测试光标
node scripts/verify/linux-overlay-lifecycle.mjs --surface-only
node scripts/verify/linux-overlay-lifecycle.mjs --cursor-theme
node scripts/verify/linux-overlay-lifecycle.mjs --real-motion
pnpm run verify:linux-window-behavior
pnpm run verify:linux-window-input
pnpm run verify:linux-appimage-update
pnpm run verify:linux-window-behavior
```

脚本只使用现有输出，单屏不增删 headless 输出；窗口测试会在主桌面创建临时窗口，移动/全屏只作用于测试进程。测试结束恢复原光标位置和可识别的活动窗口。发现 QS 活进程退出/新增进程或新增 core 即失败，失败日志保留在 `/tmp/cyrene-host-*`。

主机已通过普通窗口移动、重显、重建、平铺和全屏；键盘菜单 Tab/方向键/Enter/Space/Esc/失焦；2x 离屏输入取消/断连无误点击；5 次 surface 隐藏重显与 configure 顺序。主机没有左侧 2x 输出，该项明确跳过。00:26 的菜单复测遇到失焦后关闭，测试访问已销毁对象报错；修正提示后，00:34 单独复测通过，失败记录没有计为应用崩溃。旧左上角固定点的完整光标探针曾在 pointer enter 超时。2026-11-18 02:36 后将测试 surface 移到中央 [1079,696,80,100] 并按实际 bounds 定位，warp 与 UInput motion、重新 enter serial 均通过，Adwaita 回退手形/文本/隐藏/grab 及截图像素也通过。没有修改或绕过锁屏状态。Electron 退出时出现 `zwp_tablet_pad_group_v2/zwp_tablet_pad_v2 still attached` 清理警告，进程正常退出，未产生 QS core；该警告属于设备/退出路径的剩余观察项。

### 普通窗口显示与焦点复核

2026-11-18 主机测试使用项目聊天/音乐窗口工厂，页面为专用测试内容。聊天最大化控制原先读取 Electron `isMaximized()`，Hyprland 普通平铺窗口也可能返回 true；现在查询同进程唯一窗口的 compositor `fullscreen` 模式，以 1 表示最大化、2 表示真正全屏，并通过 `hl.dsp.window.fullscreen(mode="maximized",action="set/unset")` 切换。并发切换只执行一次，查询失败或窗口歧义不修改其他窗口。主机最大化、还原和隐藏重显通过。

音乐窗口透明区域的截图像素为 [250,5,249]，显示后方品红测试窗口；内容区域为 [13,242,13]，显示绿色卡片。主动显示、重复激活、关闭重建均通过，窗口为原生 Wayland。

测试另确认 Electron `focusable:false` 不能独自保证 Hyprland 原窗口保留焦点：新窗口自己 `isFocused=false`，compositor 却切换 activewindow，原窗口失焦。普通提醒 fallback 现于显示前安装只匹配随机 initialTitle 的内存规则（`no_initial_focus/no_focus`），随后恢复用户标题；每次 remap 重新登记，关闭/受控退出禁用并检查。先等待页面加载再设置随机标题，避免页面 title 覆盖匹配。规则不写入个人配置，失败不显示；队列在异步准备期间清空则不映射，销毁后不重建。主机非聚焦窗口和真实 reminder 工厂的显示/重显/清理均保持原键盘焦点。最终 app.asar 的同一回归也通过；规则禁用后查询 is_enabled=false，无新增 Hyprland 配置错误。

`alter_zorder` 当前源码只调用一次 raise/lower，还会设置 allowed-over-fullscreen；没有持续置顶状态。WIN-02 因此继续未完成，未用反复 raise 或 pin 宣称支持。

### AppImage 更新与回滚

Linux AppImage 使用项目更新事务；Windows/macOS 保留原安装路径。点击安装后先复制到 AppImage 所在文件系统的 `.<文件名>.cyrene-update/stage-*`，验证真实 sha512、保留旧字节并 fsync。准备成功才进入受控退出；独立 Python worker 等旧 PID/启动时间消失后原子替换固定 AppImage 路径，保留自定义文件名及 autostart 参数。

新应用进入 `ready` 后验证安装文件 sha512、包内两个宿主 SHA256SUMS 和 `--version`，再写健康标记。该标记证明启动与配套校验通过，完整桌面输入与设备验收另列。新旧宿主版本可以不同，新应用必须与自身包内版本一致。启动退出或 90 秒内没有健康确认时，worker 终止自己启动的进程组、原子恢复旧版并启动旧应用。worker 中断时，下次启动读取 journal 恢复；完整桌面仍被旧进程占用时应先关闭该进程再重启。健康安装后保留 `previous.AppImage`，状态与失败原因写入 `state.json/result.json/last-launch.log`。此事务只回滚 AppImage，不撤销 userData 迁移。

Python 3.11+ 为更新 worker 的依赖，缺失、目录不可写、摘要/版本校验失败时安装准备报错，当前文件保留。工作目录必须属于当前用户且为 0700，目标、缓存和日志拒绝符号链接；flock 防止并发安装。安装 worker 纳入 Linux 包和产物源码摘要校验。

```bash
pnpm exec vitest run src/main/updater/appimage-transaction.test.ts
pnpm run build:main
pnpm run build:overlay-host
pnpm run verify:linux-appimage-update
pnpm run verify:linux-window-behavior
```

12 项真实文件/进程测试覆盖成功、退出/超时、取消、并发、篡改、worker 中断及部分恢复文件残留、配套版本变化和符号链接边界。主机上的真实 Electron/electron-updater 本地 feed 测试覆盖 1.3.7→1.3.8 成功、启动退出、宿主不配套和错误 sha512。载荷是专用可执行测试文件，未覆盖正式 Cyrene 两版本的 FUSE 启动与用户数据迁移；这些继续列为 UPD-05，发布和远程 CI 尚未执行。

## Quickshell 崩溃记录

### 确认次数和时间

2026-11-17 13:59—14:03（Asia/Shanghai）只读检查了 `coredumpctl`、systemd journal、QS runtime 日志和本地 crash report。自原会话开始 **2026-11-15 23:50** 起，共找到 **26 次 `/usr/bin/quickshell` 的 SIGSEGV**：11 月 16 日 8 次，11 月 17 日 18 次。其中 17 次集中于 11 月 17 日 02:01—03:07 的跨输出测试/复测阶段。

`coredumpctl list` 通常显示收集记录的时间，比实际 signal/重启日志晚几秒。下面分别列出 core 元数据中的崩溃时间与 journal 收集时间；两份截断 core 延迟约 30 秒。

<details>
<summary>26 次崩溃明细（全部为 SIGSEGV）</summary>

| 崩溃时间（2026，CST） | 收集时间（同日） | PID | 栈信息 |
|---|---|---:|---|
| 11-16 07:13:18 | 07:13:22 | 1769127 | Qt Quick / layer-shell 销毁栈 |
| 11-16 07:16:02 | 07:16:04 | 1772068 | Qt Quick / layer-shell 销毁栈 |
| 11-16 07:16:28 | 07:16:30 | 1773076 | Qt Quick / layer-shell 销毁栈 |
| 11-16 07:18:46 | 07:18:48 | 1775872 | Qt Quick / layer-shell 销毁栈 |
| 11-16 14:11:38 | 14:11:43 | 2623435 | Qt Quick / layer-shell 销毁栈 |
| 11-16 14:20:54 | 14:20:57 | 2635965 | Qt Quick / layer-shell 销毁栈 |
| 11-16 14:26:09 | 14:26:12 | 2657849 | Qt Quick / layer-shell 销毁栈 |
| 11-16 14:26:49 | 14:26:51 | 2659218 | Qt Quick / layer-shell 销毁栈 |
| 11-17 00:33:17 | 00:33:22 | 3204692 | Qt Quick / layer-shell 销毁栈 |
| 11-17 02:01:22 | 02:01:25 | 3313101 | Qt Quick / layer-shell 销毁栈 |
| 11-17 02:03:37 | 02:03:40 | 3314959 | Qt Quick / layer-shell 销毁栈 |
| 11-17 02:07:03 | 02:07:05 | 3317764 | Qt Quick / layer-shell 销毁栈 |
| 11-17 02:09:30 | 02:09:32 | 3319714 | Qt Quick / layer-shell 销毁栈 |
| 11-17 02:20:45 | 02:20:47 | 3327086 | Qt Quick / layer-shell 销毁栈 |
| 11-17 02:27:32 | 02:27:34 | 3331797 | Qt Quick / layer-shell 销毁栈 |
| 11-17 02:29:22 | 02:29:24 | 3333531 | Qt Quick / layer-shell 销毁栈 |
| 11-17 02:32:04 | 02:32:06 | 3335550 | Qt Quick / layer-shell 销毁栈 |
| 11-17 02:52:54 | 02:53:27 | 3383084 | 截断，仅确认信号 |
| 11-17 02:54:55 | 02:54:57 | 3384727 | Qt Quick / layer-shell 销毁栈 |
| 11-17 02:59:03 | 02:59:05 | 3387637 | Qt Quick / layer-shell 销毁栈 |
| 11-17 03:01:09 | 03:01:11 | 3389586 | Qt Quick / layer-shell 销毁栈 |
| 11-17 03:02:23 | 03:02:25 | 3390913 | Qt Quick / layer-shell 销毁栈 |
| 11-17 03:03:07 | 03:03:10 | 3391827 | Qt Quick / layer-shell 销毁栈 |
| 11-17 03:04:33 | 03:04:35 | 3393207 | Qt Quick / layer-shell 销毁栈 |
| 11-17 03:05:09 | 03:05:11 | 3394035 | Qt Quick / layer-shell 销毁栈 |
| 11-17 03:06:47 | 03:07:23 | 3395253 | 截断，仅确认信号 |

</details>

### 栈和前置日志

24 份可读主线程栈都经过 `QQuickItemPrivate::derefWindow`、`ProxyWindowContentItem` 和 `WlrLayershell` / `WaylandPanelInterface` 销毁；其中 21 份含 `QQuickWindowPrivate::cleanup`，3 份直接落在 derefWindow/销毁链。PID 3383084、3395253 的 core 截断，不能从它们确认具体崩溃栈。

例如 PID **3313101** 的 core 时间为 **2026-11-17 02:01:22**；QS 日志在 **02:01:22.306** 记录 crash 和重启。对应本地 `report.txt` 给出的调用链为：

```text
QQuickWindowPrivate::cleanup
→ QQuickItemPrivate::derefWindow
→ QQuickItem::setParentItem / destructor
→ ProxyWindowContentItem destructor
→ WlrLayershell destructor
→ WaylandPanelInterface destructor
```

崩溃前约 0.1 秒，Caelestia 的 `Workspaces.qml`、`Brightness.qml`、`BarWrapper.qml`、launcher/OSD 等报屏幕/monitor 对象为空：`activeWorkspace`、`name`、`height` 无法读取。多份 runtime 日志重复出现相同序列。QS 随后自动重启配置 `/etc/xdg/quickshell/caelestia/shell.qml`，一些栈含 `checkCrashRelaunch`。

这把排查方向指向 **输出移除时的 Caelestia/QS/Qt Quick 窗口生命周期**：测试脚本反复在主桌面创建 headless 输出、配置 scale/位置，并在 `finally` 删除输出，时间与屏幕对象失效、销毁栈吻合。原始证据只能说明关联；后续隔离复现已证明 **Caelestia/QS 在没有 Cyrene 时也会崩溃**，具体 Qt/QS 内存损坏源仍待外部修复。不应写成“Cyrene 崩溃”，也不能将这条桌面稳定性缺陷视为不影响验收。

### 隔离复现与项目修复

2026-11-17 的后续调查在独立 runtime、独立 D-Bus、`xwayland.enabled=false` 的嵌套 Hyprland 中执行。测试输出只在该实例创建/移除，主桌面未增删输出，Caelestia PID 3038358 保持存活。临时 Caelestia 副本移除了锁屏与全局快捷键模块，系统安装目录和个人配置未改。

| 对照 | 结果 |
|---|---|
| 无 Cyrene，最小 QS PanelWindow，5 次输出创建/移除 | 通过，无 QS crash/restart |
| 无 Cyrene，Caelestia 的 Background/Drawers 模块 | 第一次移除输出就崩溃；PID 3753351 的 core 与原 3313101 同栈 |
| 无 Cyrene，仅 Caelestia Background | 崩溃；仍落在窗口内容项销毁路径 |
| Caelestia 改用 basic render loop，或去掉 Drawers 的 MultiEffect | 仍崩溃；不能归结为 threaded loop 或该单个阴影效果 |
| 最小 QS 面板带 layer/MultiEffect | 3 次输出循环通过；仅开启层效果不足以触发 |
| 项目脚本 `--quickshell-only` + Caelestia 临时配置 | 捕获 crash 后返回失败；没有启动 Cyrene host，PID 3850500/3882438 |
| 修复后项目 host + 最小 QS，5 次切屏/隐藏/重显/移除 | 缓存帧映射、configure 顺序、QS 状态全部通过 |

这确认了原来 26 次事故的触发链：**测试删除 headless 输出 → Caelestia 每屏对象撤销/销毁 → QS 内容项销毁调用 Qt Quick → 损坏指针访问/SIGSEGV → QS 自动重启**。Caelestia 2.5.0、QS 0.3.2 revision 4f508be、Qt 6.12.0 是本次可复现组合。调查新增 7 次隔离 SIGSEGV，与上表原始 26 次分开统计；其余“配置加载失败”不算崩溃。

对原 core 3313101 的 GDB 检查发现，`QQuickWindowPrivate::cleanup()` 进入 Qt 容器操作时在 `cmpl $0x1,(%rdx)` 崩溃，`rdx=0x41c80000524f4e44` 是无效地址。Qt 源码显示这里向 `cleanupNodeList` 追加待销毁节点；QS `ProxyWindowBase::~ProxyWindowBase` 调用 `deleteWindow(true)`，`disownWindow(true)` 保留内容项与 backing window 的父项关联，随后 `ProxyWindowContentItem` 销毁进入 `derefWindow/cleanup`。这是可疑的销毁顺序，但缺少 Qt 私有调试符号和 ASAN 分配历史，**尚不能把损坏地址定性为哪一行首次造成的 use-after-free**。

相关外部报告 [QS #1340](https://github.com/quickshell-mirror/quickshell/issues/1340)、[QS #1493](https://github.com/quickshell-mirror/quickshell/issues/1493) 也描述输出消失时的 Qt Quick 销毁栈。它们用于交叉核对，不能代替本地复现，也不表示上游已修复。

项目同时有独立、可复现的 Wayland 生命周期错误：

1. 新 layer surface 在 configure 到达前就收到帧；旧宿主日志明确出现 `layerSurface was not configured, but a buffer was attached`。
2. `hide` 的空 buffer commit 会重置 layer-shell 状态；立即 `show` 直接补发旧帧，同样违反重新 configure 的要求。
3. 输出切换丢掉最新帧，在没有下一次 paint 时留下空 surface；fullscreen 先销毁 SHM pool 再释放 buffers，也有资源顺序风险。

**0.1.3 已修复项目问题**：每个 surface 有 configure 状态，替换/隐藏后重新等待；重显先提交角色属性；保留最新 bitmap，在目标 configure 后附加；旧 surface 回调仍按身份过滤；fullscreen 先清 buffers 再释放 pool。修复前隔离回归稳定失败，修复后 5 次循环通过，Wayland trace 检查各 surface generation 的首次 attach 与 remap 都在 configure 后。此修复没有改 QS/Qt，因此不宣称消除了外部 Caelestia 崩溃。

上述隔离回归是历史根因证据。后续按用户要求改为主机会话；当前命令和清理结果见“主机测试与环境清理”，不再启动临时 QS 或加载第二份配置。

本地证据已归档到 `/tmp/cyrene-test-evidence-20261117`，源码/GDB 栈仍在 `/tmp/cyrene-qs-investigation/`。原始/新增 core 按 PID 查询。18 个嵌套 runtime/配置目录已清理；日志、截图和复现 QML 保留，完整 core 和个人环境不入库。

### 实际影响与当前状态

测试时多次出现 QS 崩溃/重启提示，随后屏幕显示锁屏崩溃恢复提示，桌宠收不到 pointer/drag，跨屏复测失败。截屏和测试日志已在本机留存。QS 子进程为僵尸状态表示退出后尚未被父进程回收，不能把 35 个僵尸 PID 算成 35 次额外崩溃；当前是 1 个存活实例、35 个僵尸子进程。文档合并时未查到 03:20 后新增 core；随后隔离复现记录见上节，未在主会话重做输出测试。

OVL-07、OVL-10 继续部分完成，OVL-08 保留早先限定场景通过，但**旧 0.1.2 包的交互验收待复测**；项目新增的 0.1.3 生命周期修复已通过隔离回归。没有修改系统安装的 QS/锁屏配置、恢复安全锁状态、删除 core 或发送上游问题。临时副本和隔离输出仅用于本地复现。原先“后台 shell 未报错即可继续”的测试判断不充分；后续输出测试应将 QS crash/restart 与应用自身故障一起检查。

### 证据位置与复核命令

本机证据不复制到仓库，避免把 core、环境变量、用户名和个人配置入库：

- systemd core：`/var/lib/systemd/coredump/`，按崩溃明细表的 PID 查询；core 仅能证明所列信号/栈。
- QS runtime：`$XDG_RUNTIME_DIR/quickshell/by-id/<id>/log.log` / `log.qslog`，例如 `ue4t1hnslot` 末尾记录 02:01:22 的 null screen；`ue4t1aqwlot` 开头记录 PID 3313101 重启。
- QS crash report：`$XDG_CACHE_HOME/quickshell/crashes/<id>/report.txt`（未设置时为 `~/.cache/quickshell/...`）；PID 3313101 的 report 位于 `ue4t1hnslot`。
- 当前运行配置用 `qs list --all` 查询。跨屏测试日志为 `/tmp/cyrene-cross-*.log`；锁屏提示截图为 `/tmp/cyrene-cross-popup.png`，临时文件不保证长期保留。

```bash
quickshell --version
pacman -Q quickshell-git qt6-base qt6-declarative hyprland
qs list --all
coredumpctl list --since '2026-11-15 23:50:00' --no-pager /usr/bin/quickshell
coredumpctl info --no-pager 3313101
journalctl -t systemd-coredump --since '2026-11-17 02:00:00' --until '2026-11-17 03:20:00' --no-pager
qs log --id <instance-id> --tail 80
hyprctl -j monitors
hyprctl -j layers
```

运行跨屏测试前保存时间戳、输出清单与 QS 实例信息；每次输出移除后核对新增 core 和 runtime crash/restart。出现第一条崩溃就停止继续堆叠输出，在独立 Hyprland 会话里依次比较“QS 关闭/开启、无 Cyrene/有 Cyrene、scale=1/2”，每次只创建/删除一个 headless 输出。恢复锁屏状态需要用户掌握当前会话，测试不能自动绕过锁屏。确认桌面健康后再验证拖拽、托盘、快捷键和最终包。

## 已修复的复核问题

原报告的 9 个 P2 根因保留为一张表，历史失败结论不再重复陈列：

| 问题 | 修复与验证 |
|---|---|
| Hyprland 快捷键仅启动时注册 | 接入 replace/suspend/resume/shutdown；真实绑定与失败恢复回归通过 |
| 副屏坐标混用 | 全局/输出内坐标转换，先选输出再 clamp，回传输出原点；副屏恢复回归通过 |
| bottom 被 top 覆盖 | 启动/设置/重启使用 bottom，置顶启用时明确 overlay |
| 快捷键不在搜索索引 | 注册稳定 ID，三语搜索完整性通过 |
| 输入框旧颜色变量 | 改用 --rb-* 角色令牌，主题契约通过 |
| CI 监听旧分支 | push/PR 改为 cyreneOnHyprland，加入产物测试；远程尚未跑 |
| fork 更新源仍指上游 | Linux publish 改为 Wandering233，新包配置校验通过 |
| 矩形画对角线 | 直线仅在 arrow 分支，矩形 PNG 像素/撤销/取消/权限测试通过 |
| 只检查 sha512 字段存在 | 校验实际 AppImage 摘要、大小、版本/路径、完整宿主摘要与 staging/更新源 |

## 86 项任务清单

✅ 已有注明范围内的验证；🟡 有实现但缺验收或仍有问题；❌ 未完成/暂缓；➖ 当前范围排除。测试环境中的 QS 稳定性问题由上节统一记录，不在各行重复长日志。

### Overlay

| ID | 状态 | 任务 | 实现/证据 | 剩余或验证范围 | 优先级 |
|---|---|---|---|---|---|
| OVL-01 | ✅ | Fullscreen 后端 | Hyprland 强制 xdg_toplevel fullscreen 显示成功，2238×1492；GNOME 未验 | Hyprland 后端已验 | P0 |
| OVL-02 | 🟡 | Fullscreen 局部 buffer | 目前仍用全屏 ARGB，曾尝试 subsurface 后画面异常并回滚 | 父/子 surface 与局部 buffer，先补像素/缩放测试 | P0 |
| OVL-03 | ➖ | GNOME 全屏态副作用 | 仅 GNOME 相关；按范围不做跨 DE | 不适用 | P0 |
| OVL-04 | ✅ | HiDPI buffer scale | 真实 HEADLESS output scale=2 实机：layer 400x500、buffer 800x1000；强制 2x 穿透/点击也验证 | 已验 | P0 |
| OVL-05 | ✅ | 分数缩放 1.25 | 真实 HEADLESS scale=1.25：layer 400×500、buffer 800×1000（ceil→2x 超采样），逻辑坐标正确 | 1.25 已验；1.5 未单独实测 | P0 |
| OVL-06 | ✅ | 按 `init.output` 选择输出 | 主进程全局/局部转换，宿主先选输出再约束；x=2238 输出局部 x=262 实测全局 x=2500；左右副屏恢复单测通过 | 已验；更复杂布局另行回归 | P0 |
| OVL-07 | 🟡 | 热插拔与位置恢复 | 已隔离复现外部 Caelestia/QS 崩溃；项目 0.1.3 configure/缓存帧修复，5 次生命周期回归通过 | 完整 Caelestia 和真实硬件热插拔仍待外部修复/验证 | P0 |
| OVL-08 | ✅ | 跨输出拖拽 | 松手按全局指针迁移 surface；历史 1x→2x→1x 往返通过，后期复测被 QS/锁屏状态阻断 | 保留历史通过；环境恢复后复测当前修复包 | P1 |
| OVL-09 | ✅ | `petAlwaysOnTop=false` 语义 | TS 协议和 controller 启动/切换/重启统一 bottom；真实宿主/AppImage bottom layer 通过 | 已验 | P1 |
| OVL-10 | 🟡 | 全屏/锁屏/通知层级 | 主机中央 surface 光标/enter 和 5 次重显通过；旧角落超时已纠正为测试点问题，不能当作锁屏证据 | 全屏游戏/锁屏/通知中心/面板遮挡仍需逐项验证 | P1 |
| OVL-11 | ✅ | 宿主崩溃自动重启/watchdog | 3 次退避重启（500/1500/3000ms）；实测 kill -9 后新宿主启动、layer/位置恢复；不可恢复错误直接回退 | 长时间 watchdog 仍可加强 | P1 |
| OVL-12 | ✅ | 协议版本握手 | 真实宿主 e2e：`verify:overlay-protocol` 触发 `PROTOCOL_MISMATCH`；客户端握手/错误测试通过 | 已验（无能力协商） | P1 |
| OVL-13 | ✅ | socket/多实例/stale 清理 | 唯一 socket（pid+时间+随机）、启动前清理 stale、0600、stop 删除；fake host 集成测试覆盖 | 已验 | P1 |
| OVL-14 | ❌ | shared texture/DMA-BUF 零拷贝 | 当前 CPU bitmap + socket 拷贝 | 评估 `offscreen.useSharedTexture`，降 CPU/延迟 | P2 |
| OVL-15 | ✅ | 4K/120Hz/大尺寸性能 | 4K@120Hz 输出、600×750 layer：10s 发送 551 帧（60fps cap）、0 次发送丢弃、host ack 约 1ms | 已验（渲染 60fps cap） | P1 |
| OVL-16 | ✅ | 丢帧/背压/延迟指标 | host ack + controller 的发送统计；历史 557 帧、0 次发送丢弃、ack 约 1ms；非显示呈现延迟 | 已验 | P2 |
| OVL-17 | ✅ | 滚轮/axis 输入 | 宿主转发 axis 增量；实测 uinput wheel → `mouseWheel` → 渲染页 `wheel`（±15） | 已验 | P1 |
| OVL-18 | ✅ | 双击/右键/上下文菜单 | 右键渲染 HTML 菜单（设置/隐藏/退出）并实测显示；clickCount 双击/三击单测；长按未测 | 已验 | P1 |
| OVL-19 | ✅ | 主题指针 | 主机 warp/真实 motion 和 cursor-shape、Adwaita 旧主题回退均通过；enter serial、截图像素、人工检查 | 主机当前路径已验；custom 图片回默认 | P2 |
| OVL-20 | 🟡 | 触摸/触控笔 | 两宿主共用主触点状态；多点不抢占，cancel/隐藏/移除清理；2x Electron 取消/断连无误点击、下一次点击正常 | 真实触屏、触控笔和拖动手势仍待验；无 tablet-v2 转发 | P2 |
| OVL-21 | ✅ | 键盘/IME（桌宠菜单） | 独立普通窗口，托盘/CLI/右键入口；真实 Tab/方向键/Enter/Space/Esc/失焦通过，动作限制 sender 和固定集合 | 菜单为固定动作，无文本输入；layer 保持非聚焦 | P2 |
| OVL-22 | ✅ | input region 精度/CPU | 大帧 >300k 像素使用 6px 网格、小帧 4px；600×750 全不透明帧区域计算单测 <50ms | 已验（自适应量化） | P2 |
| OVL-23 | ✅ | 不可见时停止渲染 | 隐藏时帧流停止、offscreen 60→2fps；show 恢复 60 并补发最新帧；无锁屏/遮挡通知 | 已验（帧流停止） | P2 |
| OVL-24 | ❌ | arm64/多架构 | 只构建当前 x64 | arm64 交叉构建/打包 | P1 |
| OVL-25 | 🟡 | 宿主 CI/校验和 | 工作流监听 cyreneOnHyprland，构建 SHA256SUMS，本地命令通过 | 远程 CI 尚未运行 | P1 |
| OVL-26 | ❌ | AppImage glibc/依赖兼容 | 本机 Arch 构建 | 旧发行版验证；libwayland 依赖声明 | P1 |
| OVL-27 | ➖ | KDE/Sway/GNOME/多屏 E2E | 按用户要求不做跨 DE | 不适用 | P0 |

### 截图、提醒、快捷键与焦点

| ID | 状态 | 任务 | 实现/证据 | 剩余或验证范围 | 优先级 |
|---|---|---|---|---|---|
| SHOT-01 | 🟡 | portal 截图 | Hyprland 独立非交互探针返回 response 2；有 grim 直接走 grim | portal 交互实测；其他桌面在范围外 | P0 |
| SHOT-02 | ✅ | 全屏/区域/窗口截图 | Hyprland：grim 全屏/区域实测；`screenshot-window` 在 activewindow 为空时回退 cursor+clients，实机捕获 1019×1374 窗口 PNG | 已验 | P0 |
| SHOT-03 | ✅ | 截图标注 | 矩形对角线已修复；撤销/保存/取消单测和真实 PNG 像素/0600 验证通过 | 当前工具已验；文字/马赛克可后续 | P0 |
| SHOT-04 | ✅ | 剪贴板/文件保存 | 截图/标注写入 userData/screenshots；热键 ClipboardItem 写剪贴板（Electron 实测读回 image/png）；标注保存实测 | 已验 | P0 |
| SHOT-05 | ✅ | 多屏/HiDPI 截图 | 多输出 grim 全屏 6396×2984；HEADLESS 2x 输出截图正常；区域选择修复后真实产出 PNG | 已验（未暴露单输出选择） | P0 |
| SHOT-06 | ✅ | 截图后端选择 | Hyprland 且有 grim 时走 grim/slurp；其他情况走 portal | Hyprland 路径已验，未做其他桌面验收 | P1 |
| SHOT-07 | ✅ | 全局截图热键 | hl.bind→控制 socket→grim，uinput 实键产生 PNG | Hyprland 路径已验 | P0 |
| SHOT-08 | ✅ | 权限/隐私/临时文件 | 0600；portal 原文件删除；启动清理 7 天/100 个；标注取消清理原图；无独立权限弹窗 | 已验（无权限弹窗） | P1 |
| TOAST-01 | ✅ | Toast 使用原生 overlay host | 真实主应用 `control toast-test` 触发：offscreen toast 页 → layer host，内容截图有 1229 色；普通 BrowserWindow 仍为 fallback | 已验 | P0 |
| TOAST-02 | ✅ | Toast 光标/角落定位 | 实测 layer 位于 [1798,1392,440,100]（右下角）；高度协议 28/58/100 正常 | 单屏已验；多屏定位仍需复测 | P0 |
| TOAST-03 | ✅ | Toast 穿透/点击 | 点击卡片中心后聊天窗口被激活（`昔涟 · 聊天（React）`）；host alpha input region + 指针转发生效 | 已验 | P0 |
| GS-01 | ✅ | 直接接 GlobalShortcuts portal | 打包版+desktop 文件：portal 注册成功；合成 Activated 触发后 `startFromHotkey` 生成截图 PNG；仅 Hyprland | 已验（合成 Activated） | P0 |
| GS-02 | ✅ | 授权/冲突/拒绝 | 组合键校验、Hyprland 占用检查、portal 拒绝不绕过；启用开关、配置失败恢复、错误提示回归通过 | 当前 Hyprland 范围已验；其他 DE 授权未验 | P0 |
| GS-03 | ✅ | 真实按键触发验证 | Hyprland `hl.bind` + uinput Alt+Shift+S 生成截图；portal 合成 Activated 也生成截图；真实物理键盘未人工按压 | 已验（Hyprland） | P0 |
| GS-04 | ✅ | per-DE 兜底 | Hyprland `hl.bind` 实机按键生成截图；其他 DE 按用户要求不验证 | 已验（仅 Hyprland） | P1 |
| GS-05 | ✅ | 快捷键录制/设置/持久化 | 录制 key/code、Esc/失焦/卸载恢复，应用后等待后端完成保存；冲突/禁用/恢复单测与真实绑定检查通过 | 已验 | P1 |
| TRAY-01 | ✅ | 托盘宿主检测 | gdbus NameHasOwner 与单测通过，历史 quickshell 托盘宿主可用 | QS 崩溃/无宿主时用 control；异常后需复核托盘 | P0 |
| TRAY-02 | ✅ | 无托盘降级入口 | 新增 `cyrene control` CLI + `$XDG_RUNTIME_DIR/cyrene-control.sock`（0600）；实测 `control show-chat` 打开聊天窗 | 已验 | P0 |
| TRAY-03 | ➖ | GNOME AppIndicator 提示 | GNOME 专属；按范围不做 | 不适用 | P1 |
| FOCUS-01 | ❌ | `xdg-activation` 支持 | 只有应用内 activation broker | 获取/使用 activation token | P0 |
| FOCUS-02 | ✅ | 后台主动弹窗焦点 | Toast overlay 非聚焦、不抢焦点；点击激活聊天；未用 xdg-activation token | 已验（不抢焦点策略） | P0 |
| FOCUS-03 | ✅ | 第二实例激活 | 实机第二实例退出后，第一实例打开聊天窗（`昔涟 · 聊天（React）`） | 已验 | P1 |
| FOCUS-04 | ❌ | 通知动作打开窗口 | 未验证 | `org.freedesktop.Notifications` action | P2 |

### 平台集成

| ID | 状态 | 任务 | 实现/证据 | 剩余或验证范围 | 优先级 |
|---|---|---|---|---|---|
| AUTO-01 | ✅ | XDG autostart | 打包版以临时 `XDG_CONFIG_HOME` 实测写入/移除 `autostart/cyrene.desktop` | 已验 | P0 |
| AUTO-02 | ✅ | AppImage/目录版路径 | AppImage 实机：`XDG_CONFIG_HOME/autostart/cyrene.desktop` 的 Exec 指向 AppImage + `--autostart`，桌宠正常出现 | 已验 | P0 |
| AUTO-03 | ✅ | `--autostart` 静默启动 | 打包版 `--autostart` 实测只显示桌宠/overlay，不显示聊天窗 | 已验 | P0 |
| AUTO-04 | ✅ | 设置与文件同步/测试 | `launch-at-login.test.ts` 覆盖写入/移除/AppImage 转义/dev 跳过 | 路径失效实机验证 | P1 |
| UPD-01 | ✅ | AppImage 更新 feed | `latest-linux.yml` 生成（version/sha512/AppImage path）；`verify:linux-artifacts` 校验通过；上传/升级归 UPD-02/QA-06 | 已验（本地 feed） | P0 |
| UPD-02 | 🟡 | Linux release 资产 | Linux publish 指向 Wandering233，新包更新源校验通过；release 工作流未执行 | 真实发版/下载/升级验证 | P0 |
| UPD-03 | ✅ | `APPIMAGE` 检测/手动更新 | 打包 Linux 无 `APPIMAGE` 时更新状态为 `error: unsupported`，UI 已加中/英/日文案；AppImage 才启用 | 已验 | P0 |
| UPD-04 | ✅ | 更新签名/校验 | `latest-linux.yml` 提供 sha512；`verify:linux-artifacts` 校验宿主/产物校验和；脚本核对版本/路径/大小/AppImage sha512/完整宿主摘要/staging/更新源；无 GPG/minisign | 已验（sha512 校验） | P1 |
| UPD-05 | 🟡 | Electron/宿主配套更新 | 强制版本 0.1.5；新版本 ready 后校验自身两宿主摘要/版本；允许随 Electron 升级宿主版本；本地 feed 失败回滚通过 | 正式 Cyrene 两版本整包升级、FUSE 及用户数据迁移仍待验 | P1 |
| UPD-06 | ✅ | 回滚/旧版本保留 | 同目录 stage 校验/原子替换，保留 previous.AppImage；worker 监测健康、失败/超时恢复；中断后下次启动恢复；文件/进程测试及真实 updater 本地 feed 通过 | 当前 AppImage 文件事务已验；正式整包和数据迁移另列 UPD-05 | P2 |
| SBX-01 | ✅ | SRT Linux 初始化 | 补齐 socat 后实机 `SandboxManager.initialize` + `wrapWithSandboxArgv`，bwrap 执行 `echo sandbox-ok` 成功 | 已验 | P0 |
| SBX-02 | ✅ | 沙箱系统依赖 | bwrap/socat/rg 检测已实现；历史补 socat 后可执行，本次 PATH 缺 socat | 先安装依赖再测受限 Shell | P0 |
| SBX-03 | ✅ | seccomp 二进制 asarUnpack | electron-builder asarUnpack 增加 `@anthropic-ai/sandbox-runtime/vendor/seccomp/**`；打包目录验证解包路径 | 已验 | P1 |
| SBX-04 | ✅ | 档位映射 | Linux config 省略 windows；实机 read/write allowWrite 档位 bwrap 执行成功；Linux 单测覆盖 | 已验 | P0 |
| SBX-05 | ❌ | 网络 allowlist/DNS/代理 | 无 Linux 网络沙箱 | socat 桥、域名白名单 | P1 |
| SBX-06 | ✅ | AppArmor/userns 检测 | 启动警告 + `cyrene doctor` 检测 `/proc/sys/kernel/apparmor_restrict_unprivileged_userns`；未做 Ubuntu 实机 | 已验（检测/提示） | P1 |
| SBX-07 | ✅ | fail-closed 错误/测试 | 缺 socat 时 not_ready；补齐依赖后真实 bwrap 命令成功；单测覆盖两条路径 | 已验 | P1 |
| SBX-08 | ✅ | GUI 命令 Wayland socket | 实机 bwrap 内可访问 `/run/user/1000/wayland-1` 与 lock 文件，`WAYLAND_DISPLAY=wayland-1` | 已验 | P2 |
| WIN-01 | ✅ | 普通窗口定位/恢复 | 辅助工厂接入；float→resize→move，原子保存坐标/平铺模式，重显匹配新地址；隔离真实移动、重建、全屏、负坐标 2x 通过 | 当前 Hyprland 范围；真实硬件重连另列 OVL-07 | P1 |
| WIN-02 | ❌ | 普通窗口置顶 | 已找到当前源码的 `hl.dsp.window.alter_zorder`，尚未实现持续置顶；pin 不是置顶 | 需验证持续层级语义，不能只用一次排序代替 | P1 |
| WIN-03 | ✅ | 全局光标查询 | 仅 Hyprland：`hyprctl -j cursorpos` 回退（100ms 缓存），用于 toast/窗口显示器选择；Electron 返回 0,0 已规避 | 仅 Hyprland；跨 DE 不做 | P1 |
| WIN-04 | ✅ | 透明/焦点/激活 | 主机项目聊天最大化/还原、音乐透明像素/激活/重建通过；普通提醒 fallback 显示/重显不夺焦点，取消/规则清理有回归 | 当前 Hyprland 场景已验；activation token 另列 FOCUS-01 | P1 |
| WIN-05 | ❌ | 剪贴板/文件选择/拖放/密钥环 | 未做 Wayland 回归；仅 Hyprland 范围 | 仅 Hyprland | P1 |
| WIN-06 | ❌ | 屏幕录制/desktopCapturer | 未验证；仅 Hyprland 范围 | 仅 Hyprland | P2 |
| WIN-07 | ➖ | X11 回归 | 无 X11 路径；按范围不做 | 不适用 | P1 |
| DOC-01 | ✅ | 安装/排障/升级文档 | 本文统一依赖、运行、诊断、验收和 QS 事故记录 | 已合并；旧重复文档移除 | P1 |
| DOC-02 | ✅ | 桌面验证范围 | 仅 Hyprland，其他桌面/X11 明确未验与范围排除 | 见本文范围说明 | P1 |
| DOC-03 | ✅ | 诊断命令 | `cyrene doctor` 输出会话/桌面/依赖/宿主/截图目录；单测覆盖；实机输出正常 | 日志导出可后续 | P2 |

### 质量与 CI

| ID | 状态 | 任务 | 实现/证据 | 剩余或验证范围 | 优先级 |
|---|---|---|---|---|---|
| QA-01 | ✅ | 宿主集成测试 | 隔离 Hyprland/QS 生命周期回归通过； 假宿主 ready/init/pointer/失败路径 + 真实宿主协议不匹配 e2e + alpha input region 单测；未做假 compositor | 已验（无假 compositor） | P0 |
| QA-02 | ➖ | 合成器 E2E 矩阵 | 按用户要求不做跨 DE | 不适用 | P0 |
| QA-03 | ✅ | 资源采样 | 历史 60s 主进程 RSS -7.0%、CPU 6.7%、fd 157→156 | 仅短时主进程采样；QS 异常期间数据不能代表正常桌面 | P1 |
| QA-04 | ✅ | 失败路径 | 新回归会捕获 QS crash/restart 与 Wayland 协议错误； fake host 覆盖：协议错、启动超时、二进制 spawn 失败、ready 前退出；0600/停止/清理 | 已验（Hyprland fake host） | P1 |
| QA-05 | ✅ | 协议流/边界 | 两宿主共用 Decoder：有界行、分片/合并、截断、frame-before-init、seq 重复/倒序、尺寸/缩放验证、2000 例流 fuzz；真实宿主测试通过 | 当前协议测试已验；长期 fuzz 可增强 | P2 |
| QA-06 | ✅ | 本地打包产物 | 当前 AppImage/tar.gz 摘要与 fork 更新源通过；较早包有启动/提醒窗口证据 | 当前最终包交互待复测；升级/旧发行版另列 | P1 |
| QA-07 | 🟡 | Linux CI | 本地全量 7134 通过、36 跳过；产物回归 17 通过；触发分支已修复 | 远程 CI 尚未执行 | P0 |
| QA-08 | ✅ | 无障碍/减少动画 | 非聚焦 overlay 保留；托盘/CLI 主动打开提醒中心，真实普通窗口 Tab/Enter/Space/Escape 通过；reduced-motion/高对比保留 | 键盘提醒入口已验；桌宠菜单键盘/IME 另列 OVL-21 | P2 |

## 后续方案与顺序

后续按用户要求直接在主机 Hyprland 测试，不再创建嵌套环境。使用当前输出和个人设置；完整 Caelestia 的输出销毁、真实硬件热插拔、桌宠输入仍需单独验收。全屏游戏、锁屏、录屏授权不能由单测推导通过。

| 任务 | 方案 | 必要验收 |
|---|---|---|
| OVL-07/08/10 | 在主机健康桌面状态下复测热插拔、跨屏和遮挡 | 单次输出生命周期无 QS 新 crash；左右/上下布局、1x/2x、反复硬件重连与当前包 |
| WIN-02 | 普通窗口定位/透明/焦点已验；alter_zorder 源码仅一次 raise/lower，持续置顶仍未实现 | 重复切换窗口后的持续层级；不能用 pin 或一次排序冒充置顶 |
| OVL-20 | 指针主题回退已验；继续真实触控/笔与拖动手势 | 真实触屏取消/多点、tablet-v2、触控笔；菜单无需 IME 输入 |
| OVL-02 | 全屏透明父 surface + 宠物局部 subsurface/viewporter | 先补像素/坐标/缩放/input region，再与旧全屏 buffer 对比；异常可回退 |
| OVL-14 | 先核对 Electron shared texture 的 Linux handle/fence，再导入 DMA-BUF | GPU/驱动矩阵、释放回执、帧同步和 CPU 回退 |
| FOCUS-01/04 | activation token / 系统通知 action 接入 activation broker | 用户动作激活，后台不抢焦点；通知服务实测 |
| WIN-05/06 | 分项探针检查剪贴板、对话框、拖放、密钥环、portal ScreenCast/desktopCapturer | 真实授权、失败/取消和重启恢复 |
| UPD-05 | AppImage 文件事务/回滚已验；用正式两版本补整包健康和数据兼容测试 | FUSE AppImage 启动、真实健康信号、用户数据兼容；回滚不撤销 userData 迁移 |
| UPD-02/OVL-25/QA-07 | 提交到 fork 后验证远程 CI，随后另行执行 release 工作流 | 远程 CI 与正式发布尚待验收，本地检查通过不等于已发版 |
| OVL-24/26 | arm64 工具链与目标机；旧 glibc 环境内重构建宿主/AppImage | 架构和动态依赖/运行兼容性，Arch 包不能代替旧发行版验收 |

## 开发检查

```bash
pnpm run check:main
pnpm run check:preload
pnpm run check:renderer
pnpm test
pnpm run test:linux-artifacts
cargo test --manifest-path native/cyrene-overlay-host/Cargo.toml
pnpm run build
pnpm run build:overlay-host
pnpm run verify:linux-artifacts
pnpm run verify:linux-overlay-lifecycle
pnpm run verify:linux-window-input
pnpm run verify:linux-appimage-update
pnpm run verify:linux-window-behavior
```

真实宿主测试如 `verify:overlay-protocol` 使用主机 Wayland 会话；反复创建/删除输出需收集 QS 证据，当前回归脚本只使用已有输出。产物校验通过后仍要执行启动、输入和升级验证。安装包生成与 core 截断期间出现过配额写入错误，清理应只针对已确认属于测试的临时解包目录。

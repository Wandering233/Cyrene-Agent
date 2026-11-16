# Linux Wayland 剩余任务清单

> 基线：`e42a45b4 feat(跨平台): 增加 Linux Wayland 原生桌宠 overlay`
> 环境：Arch Linux + Hyprland 0.57.1 + Wayland，Electron 44.7.2
> 说明：本文是**全量任务清单与逐项核对结果**；已完成项会随实现更新。
> 最近更新：overlay 帧统计；Hyprland 光标回退；隐藏桌宠降帧；host 客户端集成测试；Linux CI/协议边界；doctor/安装排障文档；Toast overlay 实机；GlobalShortcuts portal；XDG autostart / `--autostart`（打包实机验证）；overlay 输出选择；宿主崩溃自动重启；协议版本校验；滚轮转发；HiDPI buffer scale（强制 2x 实测）；按输出位置持久化（实机拖拽/重启恢复）。

## 状态图例

- ✅ 已完成并有验证证据
- 🟡 部分完成/已有基础，但不满足验收
- ❌ 未开始

## 已完成基线

| ID | 已完成能力 | 证据 |
|---|---|---|
| BASE-01 | Rust layer-shell 宿主、wl_shm ARGB、帧协议 | `native/cyrene-overlay-host/` |
| BASE-02 | 按 alpha 生成 input region，透明区域穿透 | `src/alpha.rs`、实测角落点击不进入宿主 |
| BASE-03 | 相对指针拖拽、layer-shell margin 定位 | `main.rs` 拖拽逻辑，实测移动 layer |
| BASE-04 | `TOP`/`OVERLAY` 层切换 | `Control::Layer` |
| BASE-05 | Electron 离屏渲染、60fps 帧流、输入回传 | `src/main/pet-overlay/` |
| BASE-06 | 宿主失败回退普通窗口 | `window-manager.ts` 的 `pet-overlay-failed` |
| BASE-07 | Linux 打包内含宿主二进制 | `electron-builder.yml`、unpacked 包实测 |
| BASE-08 | 纯 Wayland（`env -u DISPLAY`）运行 | 实测 |
| BASE-09 | Rust 6 个测试、全量 7006 个 JS/TS 测试 | 本地执行 |

---

## A. Overlay 宿主

| ID | 状态 | 任务 | 核对证据/现状 | 剩余工作与验收 | 优先级 |
|---|---|---|---|---|---|
| OVL-01 | 🟡 | GNOME 全屏透明 `xdg_toplevel` fallback | 新增 `cyrene-overlay-fullscreen`：xdg_toplevel 全屏 + 透明全屏 buffer；Hyprland 强制 fullscreen 实测 client fullscreen=2、2238x1492、宠物在 900,400 | GNOME/Mutter 实机；多屏坐标 | P0 |
| OVL-02 | 🟡 | GNOME 全屏父 surface + 子 surface/局部 buffer | 当前使用全屏 ARGB buffer（透明底 + 宠物区域拷贝/damage），未用 subsurface | 4K 带宽优化；subsurface/局部 buffer | P0 |
| OVL-03 | ❌ | GNOME 全屏态副作用 | 未处理 | 顶栏、概览、全屏提示、idle inhibit 验证 | P0 |
| OVL-04 | ✅ | HiDPI buffer scale | 真实 HEADLESS output scale=2 实机：layer 400x500、buffer 800x1000；强制 2x 穿透/点击也验证 | 已验收 | P0 |
| OVL-05 | 🟡 | 分数缩放 1.25/1.5 | 使用 `ceil(scale)` 整数超采样（1.25/1.5→2x），逻辑坐标不变 | 真实 1.25/1.5 输出实机；非整数 buffer_scale 替代方案 | P0 |
| OVL-06 | ✅ | 按 `init.output` 选择输出 | 实机在 HEADLESS-1/2（x=2238, scale=2）创建 layer，位于 [2500,100]；输出名匹配/重建有效 | 多屏互切归 OVL-07/27 | P0 |
| OVL-07 | 🟡 | 多屏热插拔/位置持久化 | 按输出位置持久化实测通过；host 新增 output_destroyed 迁移到剩余输出逻辑 | 输出移除/重连实机复测（当前 headless 删除时序不稳定）；多屏互拖 | P0 |
| OVL-08 | ❌ | 跨输出拖拽 | 拖拽只改 margin，不换输出 | 跨屏 surface 迁移/坐标重算 | P1 |
| OVL-09 | 🟡 | `petAlwaysOnTop=false` 语义 | 已能切 `TOP`/`OVERLAY`，但关闭仍是 `TOP` | 普通层级模式或明确文档化限制 | P1 |
| OVL-10 | 🟡 | 全屏/锁屏/通知 z-order | 只验证普通窗口 | 全屏游戏、锁屏、通知中心、面板遮挡 | P1 |
| OVL-11 | ✅ | 宿主崩溃自动重启/watchdog | 3 次退避重启（500/1500/3000ms）；实测 kill -9 后新宿主启动、layer/位置恢复；不可恢复错误直接回退 | 长时间 watchdog 仍可加强 | P1 |
| OVL-12 | 🟡 | 协议版本握手/能力协商 | 宿主错误事件 `PROTOCOL_MISMATCH` 客户端测试通过；init 携带 protocol | 真实宿主不匹配端到端 | P1 |
| OVL-13 | 🟡 | socket/多实例/stale 清理 | 新增 fake host 集成测试：0600、ready/init/pointer、stop 删除 socket | 并发启动、异常退出/残留 | P1 |
| OVL-14 | ❌ | shared texture/DMA-BUF 零拷贝 | 当前 CPU bitmap + socket 拷贝 | 评估 `offscreen.useSharedTexture`，降 CPU/延迟 | P2 |
| OVL-15 | 🟡 | 4K/120Hz/大尺寸性能 | 400×500 实测 10s 发送 561 帧（约 56fps）、0 丢帧；4K/120Hz 未测 | 4K/600×750/120Hz 基准 | P1 |
| OVL-16 | 🟡 | 丢帧/背压/延迟指标 | 新增 frames sent/dropped/restarts 统计与 10s 日志；实测 561/0/0 | 端到端延迟、队列深度 | P2 |
| OVL-17 | ✅ | 滚轮/axis 输入 | 宿主转发 axis 增量；实测 uinput wheel → `mouseWheel` → 渲染页 `wheel`（±15） | 已验收 | P1 |
| OVL-18 | 🟡 | 双击/右键/上下文菜单 | 已加 400ms/4px clickCount；右键 down/up 转发 | 真实双击/右键菜单/长按实机 | P1 |
| OVL-19 | ❌ | 鼠标指针形状 | 宿主未设置 cursor | 拖拽/缩放/可点击区域 cursor | P2 |
| OVL-20 | ❌ | 触摸/触控笔 | 只处理 pointer | touch/stylus 适配 | P2 |
| OVL-21 | ❌ | 键盘/IME（桌宠菜单） | `keyboard_interactivity=None`，无键盘转发 | 需要键盘时的独立模式或普通窗口 | P2 |
| OVL-22 | ❌ | input region 精度/CPU | 4px 网格、每帧扫描 | 轮廓简化/增量更新/基准 | P2 |
| OVL-23 | 🟡 | 不可见时停止渲染 | 隐藏时帧率 60→2、不再向宿主发帧；show 时恢复 60 并补发最新帧 | 完全暂停 Live2D/锁屏遮挡通知 | P2 |
| OVL-24 | ❌ | arm64/多架构 | 只构建当前 x64 | arm64 交叉构建/打包 | P1 |
| OVL-25 | ❌ | CI 构建宿主/校验和 | 只有本地脚本 | GitHub Actions 安装 Rust、构建、校验 | P1 |
| OVL-26 | ❌ | AppImage glibc/依赖兼容 | 本机 Arch 构建 | 旧发行版验证；libwayland 依赖声明 | P1 |
| OVL-27 | ❌ | KDE/Sway/GNOME/多屏 E2E | 只测 Hyprland | 每类合成器实机用例 | P0 |

---

## B. 截图 / Toast / 快捷键 / 托盘 / 焦点

| ID | 状态 | 任务 | 核对证据/现状 | 剩余工作与验收 | 优先级 |
|---|---|---|---|---|---|
| SHOT-01 | 🟡 | portal Screenshot v2 | `portal-screenshot.ts` 可在 Electron 运行；修复 dbus-next/usocket 在 Electron Node 24 的崩溃（util.isError/原生 socket） | Hyprland portal 非交互仍返回 2；其他 DE 实机/交互返回 0 | P0 |
| SHOT-02 | 🟡 | 全屏/区域/窗口截图 | Hyprland：grim 全屏实测、slurp 选择取消路径实测；区域选择成功待人工 | 窗口截图/多屏 | P0 |
| SHOT-03 | ✅ | 标注 overlay | 新增 Electron 标注窗口（画笔/矩形/箭头/撤销/清空/保存/取消）；自动化保存实测生成同尺寸 annotated PNG | 文字/马赛克可后续 | P0 |
| SHOT-04 | ✅ | 剪贴板/文件保存 | 截图/标注写入 userData/screenshots；热键 ClipboardItem 写剪贴板（Electron 实测读回 image/png）；标注保存实测 | 已验收 | P0 |
| SHOT-05 | 🟡 | 多屏/HiDPI 截图 | HEADLESS 2x 输出加入后 grim 全屏截图 6396×2984，包含多输出；区域坐标/单输出选择待验证 | 区域跨屏、缩放换算 | P0 |
| SHOT-06 | 🟡 | DE 兜底 | Hyprland grim/slurp 已实现；其他 DE 走 portal | KDE Spectacle/GNOME DBus、grim 缺失回退 | P1 |
| SHOT-07 | ✅ | 全局截图热键 | Hyprland 自动 `hl.bind("ALT+SHIFT+S")` → control socket → grim；实机按键生成 949KB PNG；Electron globalShortcut 在 Wayland 不可靠时由桌面 bind 兜底 | KDE/GNOME portal 仍待适配 | P0 |
| SHOT-08 | 🟡 | 权限/隐私/临时文件 | 截图文件 0600；portal 原文件删除；启动清理 7 天/100 个上限；单测覆盖 | 权限提示/失败清理边界 | P1 |
| TOAST-01 | ✅ | Toast 使用原生 overlay host | 真实主应用 `control toast-test` 触发：offscreen toast 页 → layer host，内容截图有 1229 色；普通 BrowserWindow 仍为 fallback | 已验收 | P0 |
| TOAST-02 | ✅ | Toast 光标/角落定位 | 实测 layer 位于 [1798,1392,440,100]（右下角）；高度协议 28/58/100 正常 | 已验收 | P0 |
| TOAST-03 | ✅ | Toast 穿透/点击 | 点击卡片中心后聊天窗口被激活（`昔涟 · 聊天（React）`）；host alpha input region + 指针转发生效 | 已验收 | P0 |
| GS-01 | 🟡 | 直接接 GlobalShortcuts portal | portal 注册/`hyprctl globalshortcuts` 出现 `cyrene:screenshot`；低层 Activated 参数已修正，`gdbus` 合成信号可触发监听 | 绑定 pending/真实按键未完成；KDE/GNOME 验证 | P0 |
| GS-02 | ❌ | 授权/冲突/拒绝 | 无 | 首次授权、冲突提示、禁用状态 | P0 |
| GS-03 | ❌ | 真实按键触发验证 | `register()` true，合成按键未触发 | 真实按键/portal 事件测试 | P0 |
| GS-04 | ❌ | per-DE 兜底 | 无 | Hyprland dynamic bind、KDE、Sway、GNOME | P1 |
| GS-05 | ❌ | 快捷键设置 UI/持久化 | 只有截图 accelerator 注册 | 录制快捷键、冲突检测、保存 | P1 |
| TRAY-01 | ✅ | StatusNotifier 宿主检测 | 新增 `tray/tray-host.ts`，启动用 gdbus `NameHasOwner` 探测；单测覆盖；本机 quickshell 返回 true | 无宿主实机验证降级日志 | P0 |
| TRAY-02 | ✅ | 无托盘降级入口 | 新增 `cyrene control` CLI + `$XDG_RUNTIME_DIR/cyrene-control.sock`（0600）；实测 `control show-chat` 打开聊天窗 | 已验收 | P0 |
| TRAY-03 | ❌ | GNOME AppIndicator 提示 | 无 | 检测扩展/提示安装 | P1 |
| FOCUS-01 | ❌ | `xdg-activation` 支持 | 只有应用内 activation broker | 获取/使用 activation token | P0 |
| FOCUS-02 | ❌ | 后台主动弹窗焦点 | 依赖 `show()/focus()` | 通知/激活 token；不抢焦点策略 | P0 |
| FOCUS-03 | ✅ | 第二实例激活 | 实机第二实例退出后，第一实例打开聊天窗（`昔涟 · 聊天（React）`） | 已验收 | P1 |
| FOCUS-04 | ❌ | 通知动作打开窗口 | 未验证 | `org.freedesktop.Notifications` action | P2 |

---

## C. 平台集成

| ID | 状态 | 任务 | 核对证据/现状 | 剩余工作与验收 | 优先级 |
|---|---|---|---|---|---|
| AUTO-01 | ✅ | XDG autostart | 打包版以临时 `XDG_CONFIG_HOME` 实测写入/移除 `autostart/cyrene.desktop` | 已验收 | P0 |
| AUTO-02 | ✅ | AppImage/目录版路径 | AppImage 实机：`XDG_CONFIG_HOME/autostart/cyrene.desktop` 的 Exec 指向 AppImage + `--autostart`，桌宠正常出现 | 已验收 | P0 |
| AUTO-03 | ✅ | `--autostart` 静默启动 | 打包版 `--autostart` 实测只显示桌宠/overlay，不显示聊天窗 | 已验收 | P0 |
| AUTO-04 | ✅ | 设置与文件同步/测试 | `launch-at-login.test.ts` 覆盖写入/移除/AppImage 转义/dev 跳过 | 路径失效实机验证 | P1 |
| UPD-01 | 🟡 | AppImage 更新 feed | `latest-linux.yml` 已生成（version/sha512/AppImage path）；`verify:linux-artifacts` 校验通过 | 上传 release assets + 实机升级 | P0 |
| UPD-02 | ❌ | Linux release 资产 | electron-builder 有 Linux target，无发布流程 | GitHub Release 上传 AppImage/tar.gz/yml | P0 |
| UPD-03 | ✅ | `APPIMAGE` 检测/手动更新 | 打包 Linux 无 `APPIMAGE` 时更新状态为 `error: unsupported`，UI 已加中/英/日文案；AppImage 才启用 | 已验收 | P0 |
| UPD-04 | ❌ | 更新签名/校验 | 无 Linux 签名 | minisign/GPG 或 sha512 + 文档 | P1 |
| UPD-05 | ❌ | Electron/宿主原子更新 | 宿主随包更新，无版本校验 | 协议版本/宿主版本绑定 | P1 |
| UPD-06 | ❌ | 回滚/旧版本保留 | 无 | 失败回滚、保留上一版 | P2 |
| SBX-01 | ✅ | SRT Linux 初始化 | 补齐 socat 后实机 `SandboxManager.initialize` + `wrapWithSandboxArgv`，bwrap 执行 `echo sandbox-ok` 成功 | 已验收 | P0 |
| SBX-02 | ✅ | bwrap/socat/rg 依赖 | `checkDependenciesAsync` 检查三者；实机 socat 1.8.1.3 + bwrap/rg 通过；排障文档给出安装命令 | 已验收 | P0 |
| SBX-03 | ✅ | seccomp 二进制 asarUnpack | electron-builder asarUnpack 增加 `@anthropic-ai/sandbox-runtime/vendor/seccomp/**`；打包目录验证解包路径 | 已验收 | P1 |
| SBX-04 | ✅ | 档位映射 | Linux config 省略 windows；实机 read/write allowWrite 档位 bwrap 执行成功；Linux 单测覆盖 | 已验收 | P0 |
| SBX-05 | ❌ | 网络 allowlist/DNS/代理 | 无 Linux 网络沙箱 | socat 桥、域名白名单 | P1 |
| SBX-06 | 🟡 | AppArmor/userns 检测 | 新增 `/proc/sys/kernel/apparmor_restrict_unprivileged_userns` 检测并写启动警告；单测覆盖 | Ubuntu 24.04 实机复现/修复指引 | P1 |
| SBX-07 | ✅ | fail-closed 错误/测试 | 缺 socat 时 not_ready；补齐依赖后真实 bwrap 命令成功；单测覆盖两条路径 | 已验收 | P1 |
| SBX-08 | ✅ | GUI 命令 Wayland socket | 实机 bwrap 内可访问 `/run/user/1000/wayland-1` 与 lock 文件，`WAYLAND_DISPLAY=wayland-1` | 已验收 | P2 |
| WIN-01 | ❌ | 普通窗口定位/居中/恢复 | `toast-window.ts` 用 `setBounds`；Wayland 无效 | 宿主化或接受合成器放置 | P1 |
| WIN-02 | ❌ | 普通窗口置顶 | `setAlwaysOnTop` 原生 Wayland 无效 | 仅桌宠有方案；普通窗口需 layer-shell/扩展 | P1 |
| WIN-03 | 🟡 | 全局光标查询 | Electron 返回 0,0；新增 Hyprland `hyprctl -j cursorpos` 回退（100ms 缓存），用于 toast/窗口显示器选择 | 其他 DE/InputCapture；真实多屏光标 | P1 |
| WIN-04 | ❌ | 透明/焦点/激活 | 未系统验证 | 透明窗口、后台激活、焦点窃取 | P1 |
| WIN-05 | ❌ | 剪贴板/文件选择/拖放/密钥环 | 未做 Wayland 回归 | 逐项验证并修复 | P1 |
| WIN-06 | ❌ | 屏幕录制/desktopCapturer | 未验证 | PipeWire/ScreenCast/restore token | P2 |
| WIN-07 | ❌ | X11 回归 | overlay 改动后未跑 X11 实机 | X11 普通路径全量回归 | P1 |
| DOC-01 | ✅ | 安装/排障/升级文档 | 新增 `docs/linux-troubleshooting.md`：依赖、构建、doctor、控制通道、已知问题 | 已验收 | P1 |
| DOC-02 | 🟡 | DE 支持矩阵 | 文档新增 Hyprland/KDE/Sway/GNOME 矩阵，标注实测/预期/待 E2E | KDE/Sway/GNOME/COSMIC 实机 | P1 |
| DOC-03 | ✅ | 诊断命令 | `cyrene doctor` 输出会话/桌面/依赖/宿主/截图目录；单测覆盖；实机输出正常 | 日志导出可后续 | P2 |

---

## D. 质量与 CI

| ID | 状态 | 任务 | 核对证据/现状 | 剩余工作与验收 | 优先级 |
|---|---|---|---|---|---|
| QA-01 | 🟡 | 宿主集成测试 | 新增 `host-client.test.ts` 假宿主：ready/init/pointer/cleanup；Rust 单测保留 | 假 compositor、输入区域断言 | P0 |
| QA-02 | ❌ | 合成器 E2E 矩阵 | 只测 Hyprland | KDE/Sway/GNOME/多屏/4K | P0 |
| QA-03 | ❌ | 性能/内存/句柄泄漏 | 只测 59fps | 长跑、CPU、RSS、fd、延迟 | P1 |
| QA-04 | 🟡 | 失败路径 | 新增宿主协议错、启动超时测试；启动/停止/0600 已覆盖 | socket 拒绝/崩溃恢复端到端 | P1 |
| QA-05 | 🟡 | 协议 fuzz/边界 | Rust 边界测试覆盖 stride 溢出/零 stride；Jet 边界畸形帧仍待补 | 畸形帧/半包/乱序 fuzz | P2 |
| QA-06 | 🟡 | 打包产物测试 | AppImage 实机 + autostart 验证；`verify:linux-artifacts` 检查 AppImage/latest-linux.yml/两个宿主 | 多架构、真实升级 | P1 |
| QA-07 | 🟡 | Linux CI | 新增 `.github/workflows/linux.yml`：Node checks/test + Rust test/build 两 job；尚未实际跑 CI | 远程 CI 首跑、E2E 矩阵 | P0 |
| QA-08 | ❌ | 无障碍/减少动画 | 无 | 键盘操作、对比度、reduced motion | P2 |

---

## 单轮可执行的现实批次

**一轮完成全部 60+ 项不现实**（涉及 GNOME/Mutter、HiDPI、多屏、截图、portal、沙箱、打包发布和多个发行版实机）。建议按以下批次推进：

### Batch 1：核心可用性（约 2–3 周）
OVL-01/02/03（GNOME fallback）、OVL-05（分数缩放实机）、OVL-07（热插拔/多屏互拖）、OVL-27（KDE/Sway/GNOME E2E）、SHOT-01/02/03/04/07（portal 截图）。

### Batch 2：产品化（约 2–3 周）
GS-01/02/03、FOCUS-01/02、TOAST-01/02/03、UPD-01/02/03、SBX-01/02/04、OVL-11/12、QA-01/02/07。

### Batch 3：体验与长期（约 3–4 周）
OVL-08/14/15/17/18/19/20/21/22/24/25/26、GS-04/05、TRAY-03、SBX-03/05/06、WIN-01..07、QA-03..08、DOC-01..03。

## 核对方法

- 代码检索：`grep`/`read` 检查 `src/main`、`src/preload`、`native/cyrene-overlay-host`。
- 运行时：`hyprctl layers`、`env -u DISPLAY pnpm start`、`hyprctl cursorpos`、`grim`。
- 测试：`cargo test`、`pnpm test`、`pnpm run check:*`。
- 打包：`pnpm run package:linux:dir`，检查 `release/linux-unpacked/resources/bin/cyrene-overlay-host`。

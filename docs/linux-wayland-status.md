# Linux / Wayland 验收状态

> 生成于 2026-11-16（当前收口），对应 `docs/linux-wayland-remaining-tasks.md` 的 86 项清单。
> 状态只记录实际代码、单测或实机证据；未验证项不标完成。

## 验证范围

按用户指定，**不执行 GNOME/KDE/Sway/COSMIC 跨桌面验证**；以下结果均只来自 Hyprland。相关任务在清单中标注“仅 Hyprland/未跨 DE”。

## 汇总

- 已完成：58 项
- 部分完成：8 项
- 未开始：15 项
- 不适用（跨 DE/X11）：5 项
- 当前主要验证环境：Arch Linux / Hyprland 0.57.1 / Wayland / Electron 44.7.2

## 已实机验收的关键路径

| 能力 | 证据 |
|---|---|
| layer-shell 桌宠 | 400×500 layer、alpha 输入区域、点击穿透、拖拽 |
| HiDPI / 多输出 | HEADLESS scale=2：layer 400×500、buffer 800×1000、位于 `[2500,100]`；真实 scale=1.25：buffer 800×1000（ceil→2x） |
| 4K/大尺寸 | HEADLESS 3840×2160@120、600×750：551 帧/10s、0 丢帧、延迟 1ms |
| GNOME fullscreen fallback | 强制 `CYRENE_OVERLAY_BACKEND=fullscreen`：client fullscreen=2、2238×1492、宠物 900,400 |
| 宿主崩溃恢复 | `kill -9` 后 3 次退避重启、位置恢复 |
| 截图 | grim 全屏/区域/窗口、标注保存、Hyprland 热键、0600/清理 |
| Toast | 真实主进程触发、右下角 440×100、点击激活聊天窗 |
| 自启动 | AppImage 实测写入 `autostart/cyrene.desktop`，Exec 指向 AppImage |
| 托盘降级 | `cyrene control` socket + CLI 实测 |
| Linux 沙箱 | socat+bwrap 实机 `echo sandbox-ok`；seccomp 已 asarUnpack |
| AppImage / CI | `latest-linux.yml` 生成、`verify:linux-artifacts` 通过、CI/release 工作流已配置、60s soak/CPU/延迟采样 |

## 明确阻塞 / 未完成原因

1. **跨 DE 验证按用户要求不做**  
   仅 Hyprland；GNOME/Mutter、KDE、Sway、COSMIC 相关项保持未验证，不因 Hyprland 通过而标完成。
2. **SRT Linux 网络 allowlist 未打通**  
   host proxy 正常，sandbox 内 CONNECT 无响应；SBX-05 未完成，不能宣称网络沙箱可用。
3. **OVL-02 局部 buffer 未实现**
   fullscreen fallback 仍是全屏 ARGB buffer，未使用 subsurface/viewporter 优化；两次 subsurface 尝试画面异常已回滚。
4. **真实 AppImage 升级未测**  
   feed 与 release 工作流已配置，但未上传 release assets，也未执行一次真实升级。
5. **arm64/旧 glibc 未验证**
   只有 x64；本机无 arm64 Rust std，也没有旧发行版环境。
6. **普通窗口管理不完整**
   native Wayland 下 `setBounds`/`setAlwaysOnTop` 不可靠；Hyprland Lua move 可移动，但 resize/后续 setBounds 会重排回 tiled。
7. **指针/触摸/激活仍有缺口**
   `grim -c` 仍显示默认箭头；无真实触摸硬件；无 xdg-activation token/系统通知 action。

## 复现命令

```bash
pnpm run check:main
pnpm test
cargo test --manifest-path native/cyrene-overlay-host/Cargo.toml
pnpm run verify:linux-artifacts
pnpm run verify:linux-overlay-soak
cyrene doctor
```

## 最终状态（第 60 轮）

- 已完成 58，部分完成 8，未开始 15，不适用 5。
- 本轮后不再自动继续；剩余项需要新的用户指令/环境。
- 网络沙箱 SBX-05 按用户要求未处理；跨 DE 项未验证。
- 未完成不等于失败：代码路径和验证证据已按项记录。

## 剩余阻塞

详见 [linux-wayland-remaining-blockers.md](linux-wayland-remaining-blockers.md)。

## 结论

该分支已经具备在 Hyprland/AppImage 上可用的 Linux 无 X11 桌宠、截图、标注、热键、Toast、自启动和沙箱基础路径；但跨 DE、网络沙箱、普通窗口管理、arm64/旧 glibc、真实升级与部分输入/激活项仍未验收，不能宣称 86 项全部完成。

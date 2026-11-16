# Linux / Wayland 验收状态

> 生成于 2026-11-16（第 40 轮收口），对应 `docs/linux-wayland-remaining-tasks.md` 的 86 项清单。
> 状态只记录实际代码、单测或实机证据；未验证项不标完成。

## 验证范围

按用户指定，**不执行 GNOME/KDE/Sway/COSMIC 跨桌面验证**；以下结果均只来自 Hyprland。相关任务在清单中标注“仅 Hyprland/未跨 DE”。

## 汇总

- 已完成：56 项
- 部分完成：8 项
- 未开始：22 项
- 当前主要验证环境：Arch Linux / Hyprland 0.57.1 / Wayland / Electron 44.7.2

## 已实机验收的关键路径

| 能力 | 证据 |
|---|---|
| layer-shell 桌宠 | 400×500 layer、alpha 输入区域、点击穿透、拖拽 |
| HiDPI / 多输出 | HEADLESS 输出 scale=2：layer 400×500、buffer 800×1000、位于 `[2500,100]` |
| GNOME fullscreen fallback | 强制 `CYRENE_OVERLAY_BACKEND=fullscreen`：client fullscreen=2、2238×1492、宠物 900,400 |
| 宿主崩溃恢复 | `kill -9` 后 3 次退避重启、位置恢复 |
| 截图 | grim 全屏、标注保存、Hyprland 热键、0600/清理 |
| Toast | 真实主进程触发、右下角 440×100、点击激活聊天窗 |
| 自启动 | AppImage 实测写入 `autostart/cyrene.desktop`，Exec 指向 AppImage |
| 托盘降级 | `cyrene control` socket + CLI 实测 |
| Linux 沙箱 | socat+bwrap 实机 `echo sandbox-ok`；seccomp 已 asarUnpack |
| AppImage | `latest-linux.yml` 生成、`verify:linux-artifacts` 通过、soak RSS/fd 采样 |

## 明确阻塞 / 未完成原因

1. **跨 DE 验证按用户要求不做**  
   仅 Hyprland；GNOME/Mutter、KDE、Sway、COSMIC 相关项保持未验证，不因 Hyprland 通过而标完成。
2. **SRT Linux 网络 allowlist 未打通**  
   host proxy 正常，sandbox 内 CONNECT 无响应；SBX-05 未完成，不能宣称网络沙箱可用。
3. **分数缩放 1.25/1.5 实机缺失**  
   HEADLESS 只验证了整数 2x；当前实现是 `ceil(scale)` 超采样。
4. **真实 AppImage 升级未测**  
   feed 已生成，但没有上传 release assets/执行一次真实升级。
5. **4K/120Hz、长跑性能未测**  
   400×500 约 56fps，12s soak RSS +6.8%，不足以证明 4K/长跑。
6. **GlobalShortcuts 真实按键未验证**  
   portal 注册成功、合成 Activated 可触发；绑定 pending 和真实物理按键仍待。
7. **OVL-02 局部 buffer 未实现**  
   fullscreen fallback 仍是全屏 ARGB buffer，未使用 subsurface/viewporter 优化。

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

- 已完成 50，部分完成 12，未开始 24。
- 本轮后不再自动继续；剩余项需要新的用户指令/环境。
- 网络沙箱 SBX-05 按用户要求未处理；跨 DE 项未验证。
- 未完成不等于失败：代码路径和验证证据已按项记录。

## 结论

该分支已经具备在 Hyprland/AppImage 上可用的 Linux 无 X11 桌宠、截图、标注、热键、Toast、自启动和沙箱基础路径；但清单中跨合成器、网络沙箱、分数缩放、完整打包升级与性能/CI 项目仍未验收，不能宣称 86 项全部完成。

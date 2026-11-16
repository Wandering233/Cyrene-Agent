# Linux / Wayland 剩余项阻塞说明

> 范围：仅 Hyprland；不跨 DE；不处理 SRT 网络 allowlist。  
> 当前 56 完成 / 9 部分 / 21 未开始。

## 环境限制

- 没有 GNOME/Mutter、KDE、Sway 实机：OVL-03/27、SHOT-01/06、QA-02、TRAY-03 只能保持未跨 DE。
- 没有真实 125/150 分数缩放以外的输出：1.25 已验证；1.5 可用同一 ceil 逻辑，但未单独实机。
- 没有真实触摸屏/触控笔：OVL-20 代码已接；uinput 虚拟触摸屏未被 Hyprland 识别为 touch 设备，无法自动验收。
- 没有旧发行版/glibc 环境：OVL-26 不能验证兼容性。
- 没有 arm64 工具链 std：OVL-24 交叉构建不可用。

## Electron/合成器限制

- Native Wayland 下 Electron `setBounds`/`setAlwaysOnTop` 对普通窗口无效。  
  Hyprland Lua `window.move({relative=true})` 可移动到目标位置；但 `window.resize` 会重排/居中，Electron 随后的 setBounds 又铺回 tiled；WIN-01 未完成。
- uinput 虚拟触摸屏未被 Hyprland 识别为 touch 设备，OVL-20 只能在真实触控硬件上验收。
- xdg-activation token 未暴露给 Electron：FOCUS-01/02 未完成。
- 系统通知 action 未接入：FOCUS-04 未完成。

## 复杂优化

- OVL-02：fullscreen parent+child subsurface 两次尝试画面位置/缩放异常，已回滚；保持全屏 buffer。
- OVL-08：跨输出拖拽需要 host 输出邻接/坐标迁移，未实现。
- OVL-14：shared texture 零拷贝需要 native texture 处理，未评估完成。
- OVL-19：Hyprland 提供 `wp_cursor_shape_manager_v1`，但 `get_pointer_with_theme` 在当前主题下未产出可用的 shape device；`grim -c` 仍显示默认箭头，未验收。
- OVL-21：键盘/IME 需要独立交互模式，未实现。
- WIN-04/05/06/07：透明/焦点/剪贴板/文件选择/录制/X11 回归未系统验证。

## 结论

这些项不是“代码未写”单一原因，多数需要新环境或 Electron/协议能力；在不再扩大范围前，不应虚标完成。

## 剩余项矩阵（第 71 轮）

| 项 | 状态 | 阻塞 |
|---|---|---|
| OVL-02 | 🟡 | subsurface 画面异常，已回滚 |
| OVL-03 | ❌ | 仅 GNOME；跨 DE 不做 |
| OVL-08 | ❌ | 跨输出拖拽未实现 |
| OVL-10 | 🟡 | 只验证普通窗口 |
| OVL-14 | ❌ | shared texture/DMA-BUF 未实现 |
| OVL-19 | 🟡 | shape device 未生效 |
| OVL-20 | 🟡 | 无真实触控硬件；uinput 未被识别 |
| OVL-21 | ❌ | 键盘/IME 未实现 |
| OVL-24 | ❌ | 无 arm64 Rust std |
| OVL-26 | ❌ | 无旧 glibc 环境 |
| OVL-27 | ❌ | 跨 DE 不做 |
| SHOT-01 | 🟡 | 仅 Hyprland；portal 返回 2 |
| SHOT-06 | 🟡 | 仅 Hyprland |
| GS-02 | ❌ | 授权/冲突 UI 未做 |
| FOCUS-01 | ❌ | Electron 无 xdg-activation token |
| FOCUS-02 | ❌ | 后台激活 token/策略未做 |
| FOCUS-04 | ❌ | 通知 action 未接 |
| UPD-06 | ❌ | 回滚/旧版本保留未做 |
| WIN-01 | ❌ | Lua move 可动，resize/setBounds 重排 |
| WIN-02 | ❌ | 普通窗口置顶不可用 |
| WIN-04 | ❌ | 透明/焦点未验证 |
| WIN-05 | ❌ | 剪贴板/文件选择/拖放/密钥环未回归 |
| WIN-06 | ❌ | 屏幕录制未验证 |
| WIN-07 | ❌ | X11 不在范围 |
| QA-02 | ❌ | 跨 DE 不做 |
| TRAY-03 | ❌ | 跨 DE 不做 |

其中 OVL-03/27、SHOT-01/06、QA-02、TRAY-03、WIN-07 属于跨 DE/X11，按当前范围不应继续投入。

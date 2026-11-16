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

这里是荆雪的 Cyrene-Agent 的 Hyprland 分支咪
上游为：https://github.com/Playa-Cyrene/Cyrene-Agent

# Cyrene-Agent · Hyprland 分支

`cyreneOnHyprland` 使用 Electron 离屏渲染与 Rust Wayland 宿主。桌宠、截图、快捷键、提醒中心、自启动和普通窗口已有 Hyprland 验证；持续置顶、热插拔、正式整包升级与硬件兼容性仍有缺口。

安装、运行、86 项清单、验收证据、已修复问题和后续方案统一见 **[Linux / Hyprland 文档](docs/linux.md)**。验证范围限于 Hyprland；其他桌面/X11 不验，网络沙箱暂缓。

测试期间确认 26 次 Quickshell SIGSEGV，集中在输出销毁相关窗口生命周期；隔离复现确认 Caelestia/QS 无需 Cyrene 就能触发同栈崩溃；底层损坏指针来源仍待外部修复。项目自己的 configure/重显生命周期问题已修复，主机光标与普通窗口回归通过。完整业务交互和真实热插拔仍需补验，不能仅凭单测或包摘要通过判定稳定。

## 快速运行

准备 Node.js 24、pnpm 10.33.0、Rust 和文档所列系统依赖后：

```bash
pnpm install --frozen-lockfile
pnpm run build:overlay-host
pnpm run build
pnpm start
```

## 项目与许可

通用功能说明见 [English README](README.en.md)，其中保留上游项目介绍。源代码遵循 [MIT License](LICENSE)；角色 IP、Live2D 模型与美术资产遵循 [MODEL_LICENSE.md](MODEL_LICENSE.md)及米哈游同人创作规范。

本项目为非官方粉丝同人作品，与 HoYoverse / 米哈游无关联、背书或赞助关系。

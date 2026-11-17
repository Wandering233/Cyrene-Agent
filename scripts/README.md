# 项目脚本

这些脚本是项目的构建、打包与验证入口；脚本源码需要提交到 Git。

| 目录 | 用途 | 常用入口 |
| --- | --- | --- |
| `build/` | 构建 CLI 与原生截图辅助程序 | `pnpm run build:cli`、`pnpm run build:screenshot-helper` |
| `packaging/` | 为 Windows 发布包准备外部依赖 | `pnpm run prepare:mingit` |
| `verify/` | 手动或自动验证构建产物及运行链路 | `pnpm run verify:screenshot-helper`、`pnpm run smoke:music` |
| `diagnostics/` | 临时诊断脚本；不属于日常打包链路 | 按文件注释单独执行 |

`packaging/prepare-mingit.mjs` 会根据 `vendor/mingit-manifest.json` 下载、校验并解压 MinGit 到 `resources/mingit/`。该目录是本地打包输入，已被 `.gitignore` 忽略。

`pnpm run build:music-component` 使用固定版本的 PyInstaller 将网易云音乐 MCP 封装为 `dist/components/music/`。发布包会预置空的 `resources/components/music/` 目录；用户将整个 `music` 文件夹内容拖入其中即可使用。

Linux 验证统一见 [Linux / Hyprland 文档](../docs/linux.md#主机测试与环境清理)。`pnpm run verify:linux-overlay-lifecycle` 直接连接当前主机 Hyprland，检查光标、surface 隐藏重显和已有输出切换；不创建嵌套环境或第二份 QS。`--surface-only` 只验生命周期，`--cursor-theme` 用协议代理测试主题回退。发现 QS 进程变化、新 core 或协议错误即失败并保留诊断日志。

`pnpm run verify:linux-window-input` 在主桌面创建测试窗口，验证移动/恢复、键盘菜单和触控取消。`pnpm run verify:linux-window-behavior` 验证项目聊天最大化/还原、音乐窗口透明像素/激活和提醒 fallback 不抢焦点。先构建 main/preload/overlay-host；设置 `CYRENE_TEST_CODE_PATH=<app.asar>` 可检查包内主进程代码。`--real-motion` 可补真实 UInput motion（需 python-evdev 和 uinput 访问权限）。`pnpm run verify:linux-appimage-update` 使用本地 feed 和专用可执行载荷，验证下载、原子替换、配套检查与失败回滚；正式两版本和设备验收限制见统一文档。

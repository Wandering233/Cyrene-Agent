import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from "electron";
import { detectStatusNotifierWatcher } from "./tray/tray-host";
import { type WindowActivationRequest } from "./application/window-activation";
import { getCurrentAppIconPath } from "./windows/window-state";

export interface CreateTrayDependencies {
  /** 托盘窗口类菜单统一走激活请求；是否立即打开由 activation broker 决定。 */
  requestActivation(request: WindowActivationRequest): void;
  /** 桌宠开关保持立即执行：桌宠不接收通用主窗口激活请求。 */
  togglePetWindow(): void;
  quit(): void;
}

export function buildTrayMenuTemplate(deps: CreateTrayDependencies): MenuItemConstructorOptions[] {
  return [
    {
      label: "打开聊天窗口",
      click: () => { deps.requestActivation({ kind: "chat" }); },
    },
    {
      label: "打开音乐播放器",
      click: () => { deps.requestActivation({ kind: "music" }); },
    },
    {
      label: "设置",
      click: () => { deps.requestActivation({ kind: "settings" }); },
    },
    {
      label: "显示/隐藏桌宠",
      click: () => { deps.togglePetWindow(); },
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => { deps.quit(); },
    },
  ];
}

export function createTray(deps: CreateTrayDependencies): Tray {
  if (!detectStatusNotifierWatcher()) {
    console.warn(
      "[Tray] StatusNotifierWatcher 不存在：当前桌面没有托盘宿主，"
      + "托盘图标不可见。可再次启动应用打开聊天窗口，或安装 waybar/quickshell/AppIndicator。",
    );
  }
  const icon = nativeImage.createFromPath(getCurrentAppIconPath());
  const tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate(buildTrayMenuTemplate(deps));

  tray.setToolTip("Cyrene");
  tray.setContextMenu(contextMenu);

  return tray;
}

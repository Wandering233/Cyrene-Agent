import { app, BrowserWindow, screen } from "electron";
import path from "node:path";
import type { ToastWindowController } from "./toast-window";
import { attachHyprlandWindowPlacement } from "../linux/window-placement";
import { loadGeneralSettings } from "../settings/settings-facade";

/** A user-opened window shares the toast service's state and accepts real keyboard input. */
export function withAccessibleToastWindow(base: ToastWindowController, isDev: boolean) {
  let window: BrowserWindow | null = null;
  let opening: Promise<void> | null = null;
  let disposed = false;
  return {
    ...base,
    async openAccessible(): Promise<void> {
      if (disposed) return;
      if (opening) return opening;
      if (window && !window.isDestroyed()) { window.show(); window.focus(); window.webContents.focus(); return; }
      const created = new BrowserWindow({ width: 480, height: 560, show: false, title: "Cyrene · 提醒中心",
        backgroundColor: "#17181c", autoHideMenuBar: true, webPreferences: {
          preload: path.join(app.getAppPath(), "dist/preload/preload/index.js"),
          contextIsolation: true, nodeIntegration: false, sandbox: false,
        } });
      window = created;
      const area = screen.getPrimaryDisplay().workArea;
      attachHyprlandWindowPlacement(created, "notifications", { x: area.x + Math.floor((area.width - 480) / 2),
        y: area.y + Math.floor((area.height - 560) / 2), width: 480, height: 560 }, loadGeneralSettings().rememberWindowState);
      created.on("closed", () => { if (window === created) window = null; });
      opening = (async () => {
        try {
          if (isDev) await created.loadURL("http://localhost:5173/toast/?interactive=1");
          else await created.loadFile(path.join(app.getAppPath(), "dist/renderer/toast/index.html"), { query: { interactive: "1" } });
          if (!created.isDestroyed() && !disposed) { created.show(); created.focus(); created.webContents.focus(); }
        } catch (error) {
          if (!created.isDestroyed()) created.destroy();
          throw error;
        } finally { opening = null; }
      })();
      return opening;
    },
    send(channel: string, payload: unknown): void {
      base.send(channel, payload);
      if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
    },
    owns(contents: { id: number }): boolean {
      return base.owns(contents) || (!!window && !window.isDestroyed() && window.webContents.id === contents.id);
    },
    dispose(): void {
      disposed = true; base.dispose();
      if (window && !window.isDestroyed()) window.destroy();
      window = null;
    },
  };
}

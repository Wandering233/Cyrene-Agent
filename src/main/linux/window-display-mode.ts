import type { BrowserWindow } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readHyprlandWindowClient } from "./window-placement";

const execute = promisify(execFile);
const pending = new WeakMap<BrowserWindow, Promise<boolean>>();
const usesHyprland = () => process.platform === "linux" && Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE);

/** Hyprland's tiled xdg configure also sets maximized; query its internal mode. */
export async function isWindowMaximized(window: BrowserWindow): Promise<boolean> {
  if (window.isDestroyed()) return false;
  if (!usesHyprland()) return window.isMaximized();
  const client = await readHyprlandWindowClient(window);
  return Boolean(client && (client.fullscreen ?? 0) === 1);
}

export function toggleWindowMaximized(window: BrowserWindow): Promise<boolean> {
  const active = pending.get(window);
  if (active) return active;
  const task = (async () => {
    if (window.isDestroyed()) return false;
    if (!usesHyprland()) {
      if (window.isMaximized()) window.unmaximize(); else window.maximize();
      return true;
    }
    const client = await readHyprlandWindowClient(window);
    if (!client || window.isDestroyed() || (client.fullscreen ?? 0) > 1) return false;
    const action = client.fullscreen === 1 ? "unset" : "set";
    await execute("hyprctl", ["dispatch", `hl.dsp.window.fullscreen({window=${JSON.stringify(`address:${client.address}`)},mode="maximized",action="${action}"})`],
      { encoding: "utf8", timeout: 2500 });
    return true;
  })().finally(() => { pending.delete(window); });
  pending.set(window, task);
  return task;
}

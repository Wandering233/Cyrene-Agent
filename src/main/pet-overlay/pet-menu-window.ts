import { app, BrowserWindow, screen } from "electron";
import path from "node:path";
import { IPC } from "../../shared/ipc-channels";
import type { IpcScope } from "../application/ipc-scope";
import { attachHyprlandWindowPlacement } from "../linux/window-placement";

export function createPetMenuWindow(deps: {
  ipc: Pick<IpcScope, "handle">;
  openSettings(): void | Promise<void>;
  hidePet(): void;
  quit(): void;
}) {
  let window: BrowserWindow | null = null;
  let opening: Promise<void> | null = null;
  let disposed = false;
  deps.ipc.handle(IPC.PET_MENU_ACTION, async (event: Electron.IpcMainInvokeEvent, action: unknown) => {
    if (!window || window.isDestroyed() || event.sender !== window.webContents) throw new Error("PET_MENU_UNAUTHORIZED");
    if (!["settings", "hide", "quit", "close"].includes(action as string)) throw new Error("PET_MENU_INVALID_ACTION");
    window.close();
    if (action === "settings") await deps.openSettings();
    else if (action === "hide") deps.hidePet();
    else if (action === "quit") deps.quit();
  });

  return {
    async open(): Promise<void> {
      if (disposed) return;
      if (opening) return opening;
      if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
      const created = new BrowserWindow({ width: 300, height: 280, show: false, resizable: false,
        title: "Cyrene · 桌宠菜单", backgroundColor: "#17181c", autoHideMenuBar: true,
        webPreferences: { preload: path.join(app.getAppPath(), "dist/preload/preload/pet-menu.js"),
          contextIsolation: true, nodeIntegration: false, sandbox: false } });
      window = created;
      created.once("closed", () => { if (window === created) window = null; });
      created.on("blur", () => { if (!created.isDestroyed()) created.close(); });
      const area = screen.getPrimaryDisplay().workArea;
      attachHyprlandWindowPlacement(created, "pet-menu", { x: area.x + Math.floor((area.width - 300) / 2),
        y: area.y + Math.floor((area.height - 280) / 2), width: 300, height: 280 }, false);
      opening = (async () => {
        try {
          await created.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PET_MENU_HTML)}`);
          if (!created.isDestroyed() && !disposed) { created.show(); created.focus(); created.webContents.focus(); }
        } catch (error) { if (!created.isDestroyed()) created.destroy(); throw error; }
        finally { opening = null; }
      })();
      return opening;
    },
    dispose(): void {
      disposed = true;
      if (window && !window.isDestroyed()) window.destroy();
      window = null;
    },
  };
}

const PET_MENU_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Cyrene · 桌宠菜单</title><style>
body { margin:16px; color:#eee; background:#17181c; font:14px system-ui,sans-serif; }
p { margin:0 0 12px; color:#bfc3cc; font-size:12px; }
button { display:block; width:100%; margin:6px 0; padding:10px; color:inherit; background:#2b2d35;
  border:1px solid #606575; border-radius:6px; text-align:left; font:inherit; cursor:pointer; }
button:focus-visible { outline:3px solid #b3c5ff; outline-offset:1px; }
</style></head><body><p>方向键或 Tab 选择，Enter 确认，Esc 关闭</p><div role="menu" aria-label="桌宠菜单">
<button role="menuitem" data-action="settings">设置</button>
<button role="menuitem" data-action="hide">隐藏桌宠</button>
<button role="menuitem" data-action="quit">退出 Cyrene</button>
</div><script>
const buttons = Array.from(document.querySelectorAll('button'));
let pending = false;
const run = async (action) => {
  if (pending) return;
  pending = true;
  try { await window.petMenu.action(action); }
  catch { pending = false; }
};
buttons.forEach(button => button.addEventListener('click', () => run(button.dataset.action)));
window.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); void run('close'); }
  const index = buttons.indexOf(document.activeElement);
  const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length
    : event.key === 'ArrowUp' ? (index + buttons.length - 1) % buttons.length
    : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
  if (next !== null) { event.preventDefault(); buttons[next].focus(); }
});
buttons[0].focus();
</script></body></html>`;

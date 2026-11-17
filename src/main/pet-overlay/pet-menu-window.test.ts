import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { IPC } from "../../shared/ipc-channels";

const state = vi.hoisted(() => ({ windows: [] as any[], failLoad: false }));
vi.mock("electron", () => ({ app: { getAppPath: () => "/app" },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  BrowserWindow: class extends EventEmitter {
    webContents = { send: vi.fn(), focus: vi.fn() }; html = ""; destroyed = false;
    show = vi.fn(); focus = vi.fn();
    constructor(public options: any) { super(); state.windows.push(this); }
    async loadURL(url: string) { if (state.failLoad) throw new Error("load failed"); this.html = decodeURIComponent(url.split(",").slice(1).join(",")); }
    isDestroyed() { return this.destroyed; }
    close() { this.destroy(); }
    destroy() { this.destroyed = true; this.emit("closed"); }
  } }));
vi.mock("../linux/window-placement", () => ({ attachHyprlandWindowPlacement: vi.fn() }));
import { createPetMenuWindow } from "./pet-menu-window";

beforeEach(() => { state.windows = []; state.failLoad = false; });
function setup() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const deps = { ipc: { handle: (channel: string, handler: (...args: any[]) => any) => { handlers.set(channel, handler); } },
    openSettings: vi.fn(), hidePet: vi.fn(), quit: vi.fn() };
  return { deps, menu: createPetMenuWindow(deps), action: (sender: unknown, action: unknown) => handlers.get(IPC.PET_MENU_ACTION)!({sender}, action) };
}

describe("桌宠菜单键盘窗口", () => {
  it("按需打开并复用，失焦关闭；动作只接受菜单窗口本人和固定动作", async () => {
    const { deps, menu, action } = setup();
    expect(state.windows).toHaveLength(0);
    await Promise.all([menu.open(), menu.open()]);
    expect(state.windows).toHaveLength(1);
    const win = state.windows[0];
    expect(win.options.webPreferences).toMatchObject({nodeIntegration:false,contextIsolation:true});
    await expect(action({}, "hide")).rejects.toThrow("UNAUTHORIZED");
    await expect(action(win.webContents, "arbitrary-command")).rejects.toThrow("INVALID_ACTION");
    expect(deps.hidePet).not.toHaveBeenCalled();
    await action(win.webContents, "settings");
    expect(deps.openSettings).toHaveBeenCalledOnce(); expect(win.destroyed).toBe(true);
    await menu.open(); state.windows[1].emit("blur"); expect(state.windows[1].destroyed).toBe(true);
    menu.dispose(); await menu.open(); expect(state.windows).toHaveLength(2);
  });
  it("加载失败能重新打开，已关闭窗口不能继续执行动作", async () => {
    const { menu, action } = setup();
    state.failLoad=true; await expect(menu.open()).rejects.toThrow("load failed");
    expect(state.windows[0].destroyed).toBe(true);
    await expect(action(state.windows[0].webContents,"quit")).rejects.toThrow("UNAUTHORIZED");
    state.failLoad=false; await menu.open(); expect(state.windows).toHaveLength(2); menu.dispose();
  });
  it("方向键循环、Home/End 和 Escape 使用同一个动作入口", async () => {
    const { menu } = setup(); await menu.open();
    const dom = new JSDOM(state.windows[0].html, {runScripts:"dangerously", beforeParse(window) {
      (window as any).petMenu = {action:vi.fn(async()=>{})};
    }});
    try {
      const key = (key: string) => dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown",{key}));
      const active = () => (dom.window.document.activeElement as HTMLElement).dataset.action;
      expect(active()).toBe("settings"); key("ArrowUp"); expect(active()).toBe("quit");
      key("ArrowDown"); expect(active()).toBe("settings"); key("End"); expect(active()).toBe("quit");
      key("Home"); expect(active()).toBe("settings"); key("Escape");
      expect((dom.window as any).petMenu.action).toHaveBeenCalledWith("close");
    } finally { dom.window.close(); menu.dispose(); }
  });
});

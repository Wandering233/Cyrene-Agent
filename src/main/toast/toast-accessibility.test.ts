import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ windows: [] as any[] }));
vi.mock("electron", () => ({ app: { getAppPath: () => "/app" }, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) }, BrowserWindow: class extends EventEmitter {
  webContents = { id: 80, send: vi.fn(), focus: vi.fn() }; show = vi.fn(); focus = vi.fn(); destroyed = false;
  constructor(public options: unknown) { super(); mocks.windows.push(this); }
  async loadFile() {} async loadURL() {} isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit("closed"); }
} }));
vi.mock("../linux/window-placement", () => ({ attachHyprlandWindowPlacement: vi.fn() }));
vi.mock("../settings/settings-facade", () => ({ loadGeneralSettings: () => ({ rememberWindowState: true }) }));
import { withAccessibleToastWindow } from "./toast-accessibility";
beforeEach(() => { mocks.windows = []; });
function setup() {
  const base = { updateHeight: vi.fn(), syncVisibility: vi.fn(), send: vi.fn(), preload: vi.fn(),
    owns: (contents: { id: number }) => contents.id === 42, isVisible: () => false, dispose: vi.fn() };
  return { base, controller: withAccessibleToastWindow(base, false) };
}
describe("键盘提醒窗口", () => {
  it("后台推送不打开窗口，主动打开后共享数据和 sender 权限", async () => {
    const { base, controller } = setup();
    controller.send("push", {}); expect(mocks.windows).toHaveLength(0);
    await controller.openAccessible();
    const w = mocks.windows[0]; expect(w.show).toHaveBeenCalledOnce(); expect(w.focus).toHaveBeenCalledOnce();
    controller.send("push", { id: "a" }); expect(w.webContents.send).toHaveBeenCalledWith("push", { id: "a" });
    expect(controller.owns({ id: 42 })).toBe(true); expect(controller.owns({ id: 80 })).toBe(true);
    expect(controller.owns({ id: 9 })).toBe(false);
    controller.updateHeight(100); expect(base.updateHeight).toHaveBeenCalledWith(100);
    controller.dispose(); expect(w.destroyed).toBe(true); expect(controller.owns({ id: 80 })).toBe(false);
  });
  it("重复打开复用，关闭后能重新打开，销毁后不重建", async () => {
    const { controller } = setup();
    await controller.openAccessible(); await controller.openAccessible(); expect(mocks.windows).toHaveLength(1);
    mocks.windows[0].destroy(); await controller.openAccessible(); expect(mocks.windows).toHaveLength(2);
    controller.dispose(); await controller.openAccessible(); expect(mocks.windows).toHaveLength(2);
  });
});

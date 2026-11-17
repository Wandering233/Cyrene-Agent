import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  directory: "", active: new Set<string>(), failures: new Set<string>(),
  install: vi.fn(), conflict: vi.fn(), portalBind: vi.fn(), portalClose: vi.fn(), trigger: vi.fn(), fallback: vi.fn(), unregister: vi.fn(), shutdown: vi.fn(),
  quit: [] as Array<() => void>,
}));
vi.mock("electron", () => ({
  app: { getPath: () => mocks.directory, getAppPath: () => mocks.directory, isPackaged: false,
    once: (_event: string, callback: () => void) => mocks.quit.push(callback) },
  BrowserWindow: class {}, ClipboardItem: class {}, clipboard: {}, nativeImage: {},
  globalShortcut: { register: mocks.fallback, unregister: mocks.unregister, isRegistered: () => false },
}));
vi.mock("./hyprland-hotkey", () => ({ installHyprlandScreenshotHotkey: mocks.install, hasHyprlandShortcutConflict: mocks.conflict }));
vi.mock("../portal/global-shortcuts", () => ({
  toPortalTrigger: mocks.trigger,
  GlobalShortcutsPortal: class { bind = mocks.portalBind; close = mocks.portalClose; onActivated() {} },
}));
vi.mock("./helper-client", () => ({ ElectronScreenshotHelperClient: class { shutdown = mocks.shutdown; } }));
vi.mock("./linux-screenshot", () => ({ captureLinuxScreenshot: vi.fn(), pruneScreenshotDirectory: vi.fn() }));
vi.mock("../annotation/annotation-window", () => ({ annotateScreenshot: vi.fn() }));
import { initializeScreenshotService } from "./screenshot-lifecycle";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.stubEnv("WAYLAND_DISPLAY", "wayland-test");
  mocks.directory = mkdtempSync(path.join(os.tmpdir(), "cyrene-hotkey-lifecycle-"));
  mocks.active.clear(); mocks.failures.clear(); mocks.quit = [];
  mocks.fallback.mockReturnValue(false);
  mocks.conflict.mockReturnValue(false);
  mocks.trigger.mockReturnValue("CTRL+S");
  mocks.portalBind.mockRejectedValue(new Error("portal unavailable"));
  mocks.portalClose.mockResolvedValue(undefined);
  mocks.shutdown.mockResolvedValue(undefined);
  mocks.install.mockImplementation((accelerator: string) => {
    if (mocks.failures.has(accelerator)) return null;
    mocks.active.add(accelerator);
    return { bind: accelerator, uninstall: () => mocks.active.delete(accelerator) };
  });
});
afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  rmSync(mocks.directory, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
function createService() {
  return initializeScreenshotService({ initialHotkey: "Alt+Shift+S",
    getReactChatWindow: () => null, capturePetWindow: async () => null,
    ipc: { handle() {}, removeHandler() {}, on() {}, dispose() {} },
  });
}

describe("Hyprland 截图绑定生命周期", () => {
  it("修改解绑旧按键，暂停时保持无绑定，恢复使用暂停期间保存的新值", async () => {
    const service = createService();
    expect([...mocks.active]).toEqual(["Alt+Shift+S"]);
    expect(service.replaceHotkey("Control+Shift+S")).toEqual({ ok: true, activeHotkey: "Control+Shift+S" });
    expect([...mocks.active]).toEqual(["Control+Shift+S"]);
    service.suspendHotkey();
    service.replaceHotkey("Alt+Shift+F12");
    expect([...mocks.active]).toEqual([]);
    service.resumeHotkey();
    expect([...mocks.active]).toEqual(["Alt+Shift+F12"]);
    await service.shutdown();
    expect([...mocks.active]).toEqual([]);
    expect(mocks.shutdown).toHaveBeenCalled();
  });
  it("注册失败后恢复旧绑定，并在退出时移除", () => {
    const service = createService();
    mocks.failures.add("Control+Shift+S"); mocks.trigger.mockReturnValue(null);
    expect(service.replaceHotkey("Control+Shift+S")).toEqual({ ok: false, activeHotkey: "Alt+Shift+S" });
    expect([...mocks.active]).toEqual(["Alt+Shift+S"]);
    mocks.quit[0]();
    expect([...mocks.active]).toEqual([]);
  });
  it("Hyprland 注册不可用时使用 Electron 回退，停止后注销", async () => {
    mocks.failures.add("Alt+Shift+S"); mocks.fallback.mockReturnValue(true);
    const service = createService();
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.fallback).toHaveBeenCalledWith("Alt+Shift+S", expect.any(Function));
    await service.shutdown();
    expect(mocks.unregister).toHaveBeenCalledWith("Alt+Shift+S");
  });
});

describe("截图按键配置 IPC", () => {
  function ipcHarness() {
    const handlers = new Map<string, (...args: any[]) => any>();
    const saved = vi.fn();
    const service = initializeScreenshotService({ initialHotkey: "Alt+Shift+S", getReactChatWindow: () => null,
      capturePetWindow: async () => null, saveShortcutSettings: saved,
      ipc: { handle: (channel, handler) => { handlers.set(channel, handler); }, removeHandler() {}, on() {}, dispose() {} } });
    return { service, saved, configure: (input: unknown) => handlers.get("screenshot:shortcut-set")!({}, input),
      status: () => handlers.get("screenshot:shortcut-get")!() };
  }
  it("冲突/格式无效不替换原绑定，禁用/重启配置持久化", async () => {
    const h = ipcHarness();
    vi.stubEnv("HYPRLAND_INSTANCE_SIGNATURE", "test");
    mocks.conflict.mockReturnValue(true);
    expect(await h.configure({ accelerator: "Control+Shift+S", enabled: true })).toMatchObject({ ok: false, error: "conflict" });
    expect(await h.configure({ accelerator: "oops", enabled: true })).toMatchObject({ ok: false, error: "invalid" });
    expect([...mocks.active]).toEqual(["Alt+Shift+S"]); expect(h.saved).not.toHaveBeenCalled();
    mocks.conflict.mockReturnValue(false);
    expect(await h.configure({ accelerator: "Control+Shift+S", enabled: false })).toMatchObject({ ok: true, status: { phase: "disabled" } });
    expect([...mocks.active]).toEqual([]);
    expect(h.saved).toHaveBeenCalledWith({ screenshotHotkey: "Control+Shift+S", screenshotHotkeyEnabled: false });
    expect(await h.configure({ accelerator: "Control+Shift+S", enabled: true })).toMatchObject({ ok: true, status: { phase: "active" } });
    expect([...mocks.active]).toEqual(["Control+Shift+S"]);
    await h.service.shutdown();
  });
  it("portal 拒绝时不绕过授权并恢复原绑定", async () => {
    const h = ipcHarness(); mocks.failures.add("Control+Shift+S");
    mocks.portalBind.mockRejectedValue(new Error("GlobalShortcuts failed with response 1"));
    expect(await h.configure({ accelerator: "Control+Shift+S", enabled: true })).toMatchObject({ ok: false, error: "denied" });
    expect(mocks.fallback).not.toHaveBeenCalled(); expect(mocks.portalClose).toHaveBeenCalled();
    expect([...mocks.active]).toEqual(["Alt+Shift+S"]); expect(h.saved).not.toHaveBeenCalled();
    await h.service.shutdown();
  });
  it("保存失败会撤销新注册", async () => {
    const h = ipcHarness(); h.saved.mockImplementation(() => { throw new Error("disk failed"); });
    expect(await h.configure({ accelerator: "Control+Shift+S", enabled: true })).toMatchObject({ ok: false });
    expect([...mocks.active]).toEqual(["Alt+Shift+S"]); await h.service.shutdown();
  });
  it("关闭设置恢复按键后，停用状态仍不会注册", async () => {
    const h = ipcHarness();
    await h.configure({ accelerator: "Control+Shift+S", enabled: false });
    h.service.suspendHotkey(); h.service.resumeHotkey(); expect([...mocks.active]).toEqual([]);
    await h.service.shutdown();
  });
});

import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ windows: [] as any[] }));
vi.mock("electron", () => ({
  app: {}, ipcMain: new EventEmitter(),
  nativeImage: { createFromPath: () => ({ isEmpty: () => false, getSize: () => ({ width: 800, height: 600 }), toDataURL: () => "data:image/png;base64,cG5n" }) },
  screen: { getDisplayMatching: () => ({ workArea: { width: 1920, height: 1080 } }) },
  BrowserWindow: class extends EventEmitter {
    webContents = { send: vi.fn() }; html = ""; destroyed = false;
    constructor(){ super(); mocks.windows.push(this); }
    async loadURL(url: string) { this.html = decodeURIComponent(url.split(",").slice(1).join(",")); }
    show() {} close() { this.destroyed = true; this.emit("closed"); } isDestroyed() { return this.destroyed; }
  },
}));
import { ipcMain } from "electron";
import { annotateScreenshot } from "./annotation-window";
vi.mock("../linux/window-placement", () => ({ attachHyprlandWindowPlacement: vi.fn() }));
let dir: string;
let dom: JSDOM | undefined;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "cyrene-annotation-")); mocks.windows = []; });
afterEach(() => { dom?.window.close(); dom = undefined; for(const w of mocks.windows) w.close(); rmSync(dir, { recursive: true, force: true }); });
async function editor() {
  const result = annotateScreenshot(path.join(dir, "original.png"));
  await Promise.resolve();
  const window = mocks.windows[0];
  dom = new JSDOM(window.html, { runScripts: "outside-only" });
  const calls: Array<[string, ...unknown[]]> = [];
  const context = Object.fromEntries(["beginPath", "moveTo", "lineTo", "stroke", "strokeRect", "putImageData", "clearRect", "drawImage"]
    .map((name) => [name, (...args: unknown[]) => calls.push([name, ...args])]));
  Object.assign(context, { getImageData: () => ({}) });
  const canvas = dom.window.document.querySelector("canvas")!;
  canvas.getContext = (() => context) as any;
  canvas.setPointerCapture = () => {};
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect;
  canvas.toDataURL = () => "data:image/png;base64,cG5n";
  canvas.width = 800; canvas.height = 600;
  let imageListener: ((event: unknown, data: string) => void) | undefined;
  const renderer = { on(_event: string, listener: typeof imageListener) { imageListener = listener; },
    send(channel: string, data: string) { ipcMain.emit(channel, { sender: window.webContents }, data); } };
  const sandbox = dom.getInternalVMContext();
  Object.assign(sandbox, { require: () => ({ ipcRenderer: renderer }),
    Image: class { onload?: () => void; width = 800; height = 600; set src(_value: string) { this.onload?.(); } } });
  vm.runInContext(dom.window.document.querySelector("script")!.textContent!, sandbox);
  imageListener?.({}, "original-image");
  function drag(tool: string) {
    (dom!.window.document.querySelector(`[data-tool="${tool}"]`) as HTMLElement).click();
    canvas.dispatchEvent(new dom!.window.MouseEvent("pointerdown", { clientX: 100, clientY: 100 }));
    canvas.dispatchEvent(new dom!.window.MouseEvent("pointermove", { clientX: 300, clientY: 200 }));
    canvas.dispatchEvent(new dom!.window.MouseEvent("pointerup"));
  }
  return { result, window, calls, drag, click: (id: string) => (dom!.window.document.getElementById(id) as HTMLElement).click() };
}
describe("标注绘制与窗口保存契约", () => {
  it("矩形只有边框，撤销恢复原图，保存返回 PNG", async () => {
    const e = await editor(); e.calls.length = 0; e.drag("rect");
    expect(e.calls.filter(([name]) => name === "strokeRect")).toEqual([["strokeRect", 100, 100, 200, 100]]);
    expect(e.calls.some(([name]) => name === "lineTo")).toBe(false);
    e.click("undo"); expect(e.calls.at(-1)?.[0]).toBe("drawImage");
    e.click("save"); const output = await e.result;
    expect(output).toMatch(/-annotated\.png$/);
    expect(readFileSync(output!)).toEqual(Buffer.from("png"));
    expect(ipcMain.listenerCount("screenshot:annotate-save")).toBe(0);
  });
  it("箭头保留直线和箭头，关闭窗口返回取消并移除监听器", async () => {
    const e = await editor(); e.calls.length = 0; e.drag("arrow");
    expect(e.calls.filter(([name]) => name === "lineTo")).toHaveLength(3);
    expect(e.calls.some(([name]) => name === "strokeRect")).toBe(false);
    e.window.close(); expect(await e.result).toBeNull();
    expect(ipcMain.listenerCount("screenshot:annotate-save")).toBe(0);
  });
});

import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ dir: "", clients: [] as any[], execute: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => mocks.dir }, screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] } }));
vi.mock("node:child_process", () => ({ execFile: (_name: string, args: string[], _options: unknown, callback: (error: null, output: string) => void) => {
  if (args[0] === "-j") { callback(null, JSON.stringify(mocks.clients)); return; }
  mocks.execute(args); callback(null, "ok");
} }));
import { attachHyprlandWindowPlacement, fitWindowBounds, placeHyprlandWindow, readWindowBounds } from "./window-placement";
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv("HYPRLAND_INSTANCE_SIGNATURE", "test"); mocks.dir = mkdtempSync(path.join(os.tmpdir(), "cyrene-window-place-")); mocks.clients=[]; mocks.execute.mockClear(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(mocks.dir,{recursive:true,force:true}); });
function windowStub() {
  return Object.assign(new EventEmitter(), { getTitle: () => "Cyrene test", isDestroyed: () => false, isVisible: () => true,
    isMaximized: () => false, isFullScreen: () => false });
}
const client = { address: "0x123", pid: process.pid, title: "new title", initialTitle: "Cyrene test", at:[100,200],size:[800,600],floating:true };
describe("Hyprland 普通窗口定位与保存", () => {
 it("使用唯一当前进程窗口，先 resize 后 move，保存 compositor 坐标并在重建时恢复", async () => {
  mocks.clients=[client];const win=windowStub();
  attachHyprlandWindowPlacement(win as never,"music",{x:300,y:250,width:500,height:400},true);win.emit("show"); await vi.advanceTimersByTimeAsync(0);
  expect(mocks.execute.mock.calls[0][0][1]).toContain('resize({window="address:0x123",x=500,y=400');
  expect(mocks.execute.mock.calls[1][0][1]).toContain('move({window="address:0x123",x=300,y=250');
  await vi.advanceTimersByTimeAsync(750);
  expect(JSON.parse(readFileSync(path.join(mocks.dir,"hyprland-window-bounds.json"),"utf8")).music).toEqual({x:100,y:200,width:800,height:600,floating:true});
  win.emit("closed");mocks.execute.mockClear();const next=windowStub();
  attachHyprlandWindowPlacement(next as never,"music",{x:0,y:0,width:500,height:400},true);next.emit("show"); await vi.advanceTimersByTimeAsync(0);
  expect(mocks.execute.mock.calls[0][0][1]).toContain('x=800,y=600');
  expect(mocks.execute.mock.calls[1][0][1]).toContain('x=100,y=200');next.emit("closed");
 });
 it("不匹配其他进程、同名多个窗口或注入地址", async () => {
  mocks.clients=[{...client,pid:process.pid+1}];const win=windowStub();
  attachHyprlandWindowPlacement(win as never,"test",{x:0,y:0,width:500,height:400},false);win.emit("show");
  await vi.advanceTimersByTimeAsync(1000);expect(mocks.execute).not.toHaveBeenCalled();win.emit("closed");
  mocks.clients=[client,{...client,address:"0x456"}];const ambiguous=windowStub();
  attachHyprlandWindowPlacement(ambiguous as never,"test",{x:0,y:0,width:500,height:400},false);ambiguous.emit("show");
  await vi.advanceTimersByTimeAsync(1000);expect(mocks.execute).not.toHaveBeenCalled();ambiguous.emit("closed");
  const execute=vi.fn();await expect(placeHyprlandWindow({...client,address:'0x123\";bad'}, {x:0,y:0,width:500,height:400},execute)).rejects.toThrow();expect(execute).not.toHaveBeenCalled();
 });
 it("已断开输出的位置回退到初始工作区，关闭后停止采样", async () => {
  writeFileSync(path.join(mocks.dir,"hyprland-window-bounds.json"),JSON.stringify({music:{x:5000,y:100,width:500,height:400}}));
  mocks.clients=[client];const win=windowStub();
  attachHyprlandWindowPlacement(win as never,"music",{x:300,y:250,width:500,height:400},true);win.emit("show");
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.execute.mock.calls[1][0][1]).toContain('x=300,y=250');
  win.emit("closed");mocks.execute.mockClear();await vi.advanceTimersByTimeAsync(1500);
  expect(mocks.execute).not.toHaveBeenCalled();
 });
 it("辅助窗口读到父窗口的实际位置，同名或外部进程不会误用", async () => {
  mocks.clients=[client];const win=windowStub();
  expect(await readWindowBounds(win as never)).toEqual({x:100,y:200,width:800,height:600});
  mocks.clients=[{...client,pid:process.pid+1}];
  expect(await readWindowBounds(win as never)).toBeUndefined();
  mocks.clients=[client,{...client,address:"0x456"}];
  expect(await readWindowBounds(win as never)).toBeUndefined();
 });
 it("最大化或全屏窗口保留显示模式和此前的普通窗口记录", async () => {
  const saved={x:300,y:250,width:500,height:400};
  writeFileSync(path.join(mocks.dir,"hyprland-window-bounds.json"),JSON.stringify({test:saved}));
  mocks.clients=[{...client,fullscreen:1}];const win=windowStub();
  attachHyprlandWindowPlacement(win as never,"test",saved,true);win.emit("show");
  await vi.advanceTimersByTimeAsync(1500);
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(path.join(mocks.dir,"hyprland-window-bounds.json"),"utf8")).test).toEqual(saved);
  win.emit("closed");
 });
 it("关闭或隐藏发生在 resize 期间时不继续移动；resize 失败也不移动", async () => {
  let active=true;
  const execute=vi.fn(async()=>{active=false;return "ok";});
  await placeHyprlandWindow(client,{x:300,y:250,width:500,height:400},execute,()=>active);
  expect(execute).toHaveBeenCalledOnce();
  const failed=vi.fn(async()=>{throw new Error("compositor disconnected");});
  await expect(placeHyprlandWindow(client,{x:300,y:250,width:500,height:400},failed)).rejects.toThrow("disconnected");
  expect(failed).toHaveBeenCalledOnce();
 });
 it("Hyprland 普通平铺窗口的 Electron maximized 标志不阻止初始定位", async () => {
  mocks.clients=[{...client,floating:false,fullscreen:0}];
  const win=Object.assign(windowStub(),{isMaximized:()=>true});
  attachHyprlandWindowPlacement(win as never,"test",{x:300,y:250,width:500,height:400},false);win.emit("show");
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.execute).toHaveBeenCalledTimes(3);
  expect(mocks.execute.mock.calls[0][0][1]).toContain('float({window="address:0x123",action="enable"})');win.emit("closed");
 });
 it("用户切回平铺后保存模式，重建时不强制浮动或移动平铺位置", async () => {
  mocks.clients=[{...client,floating:false}];const win=windowStub();
  attachHyprlandWindowPlacement(win as never,"test",{x:300,y:250,width:500,height:400},true);win.emit("show");
  await vi.advanceTimersByTimeAsync(750);
  expect(JSON.parse(readFileSync(path.join(mocks.dir,"hyprland-window-bounds.json"),"utf8")).test.floating).toBe(false);
  win.emit("closed");mocks.execute.mockClear();const restored=windowStub();
  attachHyprlandWindowPlacement(restored as never,"test",{x:0,y:0,width:500,height:400},true);restored.emit("show");
  await vi.advanceTimersByTimeAsync(0);expect(mocks.execute).not.toHaveBeenCalled();restored.emit("closed");
 });
 it("隐藏重显后 xdg 地址更换时恢复最新用户位置，停止使用旧地址", async () => {
  mocks.clients=[client];const win=windowStub();
  attachHyprlandWindowPlacement(win as never,"test",{x:300,y:250,width:500,height:400},true);win.emit("show");
  await vi.advanceTimersByTimeAsync(750);
  mocks.execute.mockClear();mocks.clients=[{...client,address:"0x456",floating:false}];win.emit("show");
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.execute.mock.calls).toHaveLength(3);
  expect(mocks.execute.mock.calls[2][0][1]).toContain('move({window="address:0x456",x=100,y=200');win.emit("closed");
 });
 it("负坐标与分数布局按最大交叠输出收回边缘窗口", () => {
  const areas=[{x:0,y:0,width:1920,height:1080},{x:-1280,y:-200,width:1280,height:720}];
  expect(fitWindowBounds({x:-1270,y:-250,width:800,height:600},areas)).toEqual({x:-1270,y:-200,width:800,height:600});
  expect(fitWindowBounds({x:1850,y:1040,width:800,height:600},areas)).toEqual({x:1120,y:480,width:800,height:600});
 });
});

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostEvent, ControlMessage } from "./protocol";
const state = vi.hoisted(() => ({
  events: [] as Array<{ callbacks: { onEvent(event: HostEvent): void; onFailure(error: Error): void }; controls: ControlMessage[]; args: string[] }>,
  version: "0.1.5" as string | undefined,
}));
vi.mock("electron", () => ({
  app: { getAppPath: () => "/test" },
  BrowserWindow: class extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { setFrameRate: vi.fn(), send: vi.fn(), sendInputEvent: vi.fn() });
    setTitle() {} loadFile() {} loadURL() {} isDestroyed() { return false; } setSize = vi.fn();
  },
}));
vi.mock("./host-client", () => ({
  PetOverlayHostClient: class {
    record: typeof state.events[number];
    constructor(_binary: string, callbacks: typeof state.events[number]["callbacks"], args: string[]) {
      this.record = { callbacks, controls: [], args }; state.events.push(this.record);
    }
    async start() {
      this.record.callbacks.onEvent({ type: "ready", protocol: 1, version: state.version,
        width: 400, height: 500, output: "PRIMARY", scale: 1 });
      this.record.callbacks.onEvent({ type: "position", x: 100, y: 100 });
    }
    sendControl(message: ControlMessage) { this.record.controls.push(message); }
    sendFrame() { return true; } stop() {}
  },
}));
import { PetOverlayController } from "./controller";
const controllers: PetOverlayController[] = [];
function create(x = 2500, originX = 2238) {
  const controller = new PetOverlayController({ isDev: false, binaryPath: "host", width: 400, height: 500,
    x, y: 100, output: "SECONDARY", outputOrigin: { x: originX, y: 0 }, zoom: 1,
    alwaysOnTop: false, showOnReady: false });
  controllers.push(controller); return controller;
}
beforeEach(() => { vi.useFakeTimers(); state.events = []; state.version = "0.1.5"; });
afterEach(() => { for (const c of controllers.splice(0)) c.dispose(); vi.useRealTimers(); });

describe("桌宠主进程与宿主契约", () => {
  it("发送渲染页光标变化并在宿主重启后恢复", async () => {
    const c = create(); await Promise.resolve();
    c.window.webContents.emit("cursor-changed", {}, "hand");
    expect(state.events[0].controls.at(-1)).toEqual({type:"cursor",cursor:"hand"});
    state.events[0].callbacks.onFailure(new Error("host exited"));
    c.window.webContents.emit("cursor-changed", {}, "grab");
    await vi.advanceTimersByTimeAsync(500);
    expect(state.events[1].controls).toContainEqual({type:"cursor",cursor:"grab"});
  });
  it("触点取消释放到页面外，不合成点击；宿主失败也释放按键", async () => {
    const c = create(); await Promise.resolve();
    const emit = (event: "down" | "up" | "cancel") => state.events[0].callbacks.onEvent({type:"pointer",event,x:10,y:20,button:0x110});
    emit("down"); emit("cancel");
    expect(c.window.webContents.sendInputEvent).toHaveBeenLastCalledWith({type:"mouseLeave",x:-1,y:-1});
    expect(c.window.webContents.sendInputEvent).toHaveBeenNthCalledWith(2,{type:"mouseUp",x:-1,y:-1,button:"left",clickCount:1});
    emit("down");
    expect(c.window.webContents.sendInputEvent).toHaveBeenLastCalledWith({type:"mouseDown",x:10,y:20,button:"left",clickCount:1});
    state.events[0].callbacks.onFailure(new Error("host exited"));
    expect(c.window.webContents.sendInputEvent).toHaveBeenNthCalledWith(5,{type:"mouseUp",x:-1,y:-1,button:"left",clickCount:1});
  });
  it.each([[2500, 2238], [-1600, -1920]])("副屏 %i 在发送/回传时转换坐标并保留拖拽结果", async (x, origin) => {
    const c = create(x, origin);
    await Promise.resolve();
    expect(state.events[0].controls[0]).toMatchObject({ type: "init", x: x - origin, y: 100, output: "SECONDARY" });
    expect(c.getPosition()).toEqual({ x, y: 100 }); // 忽略初始化之前的默认输出位置。
    state.events[0].callbacks.onEvent({ type: "position", x: 300, y: 120, output: "SECONDARY", output_x: origin, output_y: 0 });
    expect(c.getPosition()).toEqual({ x: origin + 300, y: 120 });
    state.events[0].callbacks.onEvent({ type: "drag", phase: "end", x: 350, y: 125 });
    expect(c.getPosition()).toEqual({ x: origin + 350, y: 125 });
    c.moveBy(10, 5);
    expect(state.events[0].controls.at(-1)).toEqual({ type: "move", x: 360, y: 130 });
  });
  it("输出移除后回传新输出，宿主重启沿用新位置与 bottom 层级", async () => {
    const c = create(); await Promise.resolve();
    state.events[0].callbacks.onEvent({ type: "position", x: 90, y: 110, output: "PRIMARY", output_x: 0, output_y: 0 });
    expect(c.getOutput()).toBe("PRIMARY");
    c.setAlwaysOnTop(true); c.setAlwaysOnTop(false);
    expect(state.events[0].controls.at(-1)).toEqual({ type: "layer", layer: "bottom" });
    state.events[0].callbacks.onFailure(new Error("host exited"));
    await vi.advanceTimersByTimeAsync(500);
    expect(state.events[1].args).toEqual(["--layer", "bottom"]);
    expect(state.events[1].controls[0]).toMatchObject({ type: "init", x: 90, y: 110, output: "PRIMARY" });
    expect(state.events[1].controls[1]).toEqual({ type: "layer", layer: "bottom" });
  });
  it.each([undefined, "0.1.1", "0.1.4"])("拒绝缺少或不匹配的宿主版本 %s", async (version) => {
    state.version = version;
    create();
    await Promise.resolve();
    expect(state.events[0].controls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(4000);
    expect(state.events).toHaveLength(1);
  });
});

describe("跨输出与重连", () => {
  it("跨屏松手转换原点和缩放，旧绘制帧不会送入新宿主", async () => {
    const c = new PetOverlayController({ isDev: false, binaryPath: "host", width: 400, height: 500,
      x: 100, y: 100, output: "PRIMARY", outputOrigin: { x: 0, y: 0 }, zoom: 1,
      alwaysOnTop: true, showOnReady: false, followOutputScale: true });
    controllers.push(c);
    c.reconcileOutputs([{ name: "PRIMARY", origin: { x: 0, y: 0 }, scale: 1 },
      { name: "SECONDARY", origin: { x: 1920, y: 0 }, scale: 2 }]);
    await Promise.resolve();
    const host = state.events[0];
    expect(host.args).toEqual(["--layer", "overlay"]);
    host.callbacks.onEvent({ type: "drag", phase: "start", x: 100, y: 100 });
    host.callbacks.onEvent({ type: "position", x: 20, y: 40, output: "SECONDARY", output_x: 1920, output_y: 0, scale: 2 });
    host.callbacks.onEvent({ type: "drag", phase: "end", x: 20, y: 40 });
    expect(c.getPosition()).toEqual({ x: 1940, y: 40 });
    expect(c.window.setSize).toHaveBeenCalledWith(800, 1000);
    expect(host.controls.at(-1)).toMatchObject({ type: "init", output: "SECONDARY", scale: 2, x: 20 });
    host.callbacks.onEvent({ type: "position", x: 200, y: 40, output: "PRIMARY", output_x: 0, output_y: 0, scale: 1 });
    expect(c.getPosition()).toEqual({ x: 200, y: 40 });
    expect(c.window.setSize).toHaveBeenCalledTimes(1); // keep 2x sampling when returning to 1x output

  });
  it("输出离线后同名重连恢复原位置，期间手动移动取消恢复", async () => {
    const c = create(); await Promise.resolve();
    const main = { name: "PRIMARY", origin: { x: 0, y: 0 }, scale: 1 };
    const secondary = { name: "SECONDARY", origin: { x: 2238, y: 0 }, scale: 2 };
    c.reconcileOutputs([main, secondary]);
    c.reconcileOutputs([main]);
    state.events[0].callbacks.onEvent({ type: "position", output: "PRIMARY", x: 50, y: 80, output_x: 0, output_y: 0 });
    c.reconcileOutputs([main, secondary]);
    expect(c.getOutput()).toBe("SECONDARY"); expect(c.getPosition()).toEqual({ x: 2500, y: 100 });
    expect(state.events[0].controls.at(-1)).toMatchObject({ type: "init", output: "SECONDARY", x: 262, y: 100 });
    c.reconcileOutputs([main]);
    state.events[0].callbacks.onEvent({ type: "position", output: "PRIMARY", x: 50, y: 80, output_x: 0, output_y: 0 });
    c.moveTo(200, 250); c.reconcileOutputs([main, secondary]);
    expect(c.getOutput()).toBe("PRIMARY"); expect(c.getPosition()).toEqual({ x: 200, y: 250 });
  });
});

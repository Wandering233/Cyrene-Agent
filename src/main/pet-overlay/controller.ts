import { app, BrowserWindow, type NativeImage } from "electron";
import path from "node:path";
import { IPC } from "../../shared/ipc-channels";
import { PetOverlayHostClient } from "./host-client";
import {
  PROTOCOL_VERSION,
  frameStride,
  pointerButtonName,
  type ControlMessage,
  type DragEvent,
  type HostEvent,
  type PointerEvent,
} from "./protocol";

export interface PetOverlayControllerOptions {
  isDev: boolean;
  binaryPath: string;
  width: number;
  height: number;
  x: number;
  y: number;
  zoom: number;
  alwaysOnTop: boolean;
  showOnReady: boolean;
  /** Integer render scale (physical pixels per logical pixel). */
  scale?: number;
  /** Output name (e.g. HDMI-A-1) selected by Electron; empty/undefined = compositor default. */
  output?: string;
}

interface LatestFrame {
  bitmap: Buffer;
  width: number;
  height: number;
}

const MAX_HOST_RESTARTS = 3;
const HOST_RESTART_DELAYS_MS = [500, 1500, 3000];

/**
 * Linux/Wayland pet backend.
 *
 * The renderer is a normal, hidden offscreen BrowserWindow running the exact
 * same Live2D page as the Windows pet. Each painted frame is streamed to a
 * small native Wayland process which owns the real layer-shell surface,
 * computes the alpha input region and handles dragging. Electron never needs
 * to position or hit-test a real Wayland window.
 */
export class PetOverlayController {
  readonly window: BrowserWindow;
  private readonly options: PetOverlayControllerOptions;
  private readonly renderScale: number;
  private x: number;
  private y: number;
  private width: number;
  private height: number;
  private zoom: number;
  private visible: boolean;
  private alwaysOnTop: boolean;
  private host: PetOverlayHostClient | null = null;
  private hostReady = false;
  private hostGeneration = 0;
  private restartAttempts = 0;
  private restartScheduled = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private failed = false;
  private disposed = false;
  private latest: LatestFrame | null = null;
  private lastPointerClick: {
    button: "left" | "middle" | "right";
    at: number;
    x: number;
    y: number;
    count: number;
  } | null = null;
  private frameSeq = 0;
  private readyEmitted = false;
  private pageLoaded = false;

  constructor(options: PetOverlayControllerOptions) {
    this.options = options;
    this.renderScale = Math.max(1, Math.round(options.scale ?? 1));
    this.width = options.width;
    this.height = options.height;
    this.x = options.x;
    this.y = options.y;
    this.zoom = options.zoom;
    this.visible = options.showOnReady;
    this.alwaysOnTop = options.alwaysOnTop;

    this.window = new BrowserWindow({
      width: Math.round(this.width * this.renderScale),
      height: Math.round(this.height * this.renderScale),
      show: false,
      frame: false,
      transparent: true,
      skipTaskbar: true,
      resizable: false,
      hasShadow: false,
      focusable: false,
      webPreferences: {
        preload: path.join(app.getAppPath(), "dist", "preload", "preload", "index.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        offscreen: true,
        backgroundThrottling: false,
        additionalArguments: ["--cyrene-pet-overlay=1"],
      },
    });

    this.window.setTitle("Cyrene Pet Overlay");
    this.window.webContents.setFrameRate(60);
    this.window.webContents.on("paint", (_event, _dirty, image) => this.handlePaint(image));
    this.window.webContents.on("console-message", (_event, _level, message) => {
      console.log("[PetOverlayRenderer]", message);
    });

    this.window.on("closed", () => this.dispose());
    this.window.webContents.on("render-process-gone", (_event, details) => {
      this.fail(new Error(`pet overlay renderer gone: ${details.reason}`));
    });
    this.window.webContents.once("did-finish-load", () => {
      this.pageLoaded = true;
      this.window.webContents.send(IPC.PET_VISIBILITY_CHANGED, this.visible);
      this.emitReady();
    });

    if (options.isDev) {
      void this.window.loadURL("http://localhost:5173");
    } else {
      void this.window.loadFile(path.join(app.getAppPath(), "dist", "renderer", "index.html"));
    }

    void this.startHost();
  }

  getPosition(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  getOutput(): string | undefined {
    return this.options.output;
  }

  isVisible(): boolean {
    return this.visible;
  }

  show(): void {
    if (this.failed || this.disposed) return;
    this.visible = true;
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(IPC.PET_VISIBILITY_CHANGED, true);
    }
    if (this.hostReady) this.host?.sendControl({ type: "show" });
  }

  hide(): void {
    if (this.failed || this.disposed) return;
    this.visible = false;
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(IPC.PET_VISIBILITY_CHANGED, false);
    }
    if (this.hostReady) this.host?.sendControl({ type: "hide" });
  }

  moveTo(x: number, y: number): void {
    if (this.failed || this.disposed) return;
    this.x = Math.round(x);
    this.y = Math.round(y);
    if (this.hostReady) this.host?.sendControl({ type: "move", x: this.x, y: this.y });
    this.emitMoved();
  }

  moveBy(dx: number, dy: number): void {
    this.moveTo(this.x + dx, this.y + dy);
  }

  setZoom(zoom: number): void {
    if (this.failed || this.disposed) return;
    if (!Number.isFinite(zoom) || zoom <= 0) return;
    this.zoom = zoom;
    const width = Math.round(this.options.width / this.options.zoom * zoom);
    const height = Math.round(this.options.height / this.options.zoom * zoom);
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.window.setSize(
      Math.round(width * this.renderScale),
      Math.round(height * this.renderScale),
    );
    this.latest = null;
    if (this.hostReady) {
      this.host?.sendControl({ type: "size", width, height });
    }
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(IPC.PET_ZOOM, zoom);
    }
  }

  setAlwaysOnTop(alwaysOnTop: boolean): void {
    this.alwaysOnTop = alwaysOnTop;
    if (this.hostReady) {
      this.host?.sendControl({ type: "layer", layer: alwaysOnTop ? "overlay" : "top" });
    }
  }

  setInteractive(interactive: boolean): void {
    if (!this.hostReady) return;
    this.host?.sendControl({ type: "interactive", interactive });
  }

  async capturePage(): Promise<NativeImage> {
    return this.window.webContents.capturePage();
  }

  send(channel: string, payload?: unknown): void {
    if (this.window.isDestroyed()) return;
    if (payload === undefined) this.window.webContents.send(channel);
    else this.window.webContents.send(channel, payload);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearRestartTimers();
    this.host?.stop();
    this.host = null;
    this.hostReady = false;
  }

  private async startHost(): Promise<void> {
    if (this.failed || this.disposed) return;
    this.restartScheduled = false;
    const generation = ++this.hostGeneration;
    const host = new PetOverlayHostClient(this.options.binaryPath, {
      onEvent: (event) => {
        if (generation === this.hostGeneration) this.handleHostEvent(event);
      },
      onFailure: (error) => {
        if (generation === this.hostGeneration) this.handleHostFailure(error);
      },
      onLog: (message) => console.log("[PetOverlayHost]", message),
    });
    this.host = host;

    try {
      await host.start();
    } catch (error) {
      if (this.host !== host || this.disposed) return;
      this.handleHostFailure(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    if (this.disposed || this.failed || this.host !== host) {
      host.stop();
      return;
    }

    this.hostReady = true;
    host.sendControl({
      type: "init",
      protocol: PROTOCOL_VERSION,
      width: this.width,
      height: this.height,
      x: this.x,
      y: this.y,
      scale: this.renderScale,
      output: this.options.output,
    });
    host.sendControl({
      type: "layer",
      layer: this.alwaysOnTop ? "overlay" : "top",
    });
    host.sendControl({ type: this.visible ? "show" : "hide" });
    this.flushLatestFrame();
    this.emitReady();
    this.scheduleStableReset(generation);
  }

  private scheduleStableReset(generation: number): void {
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      if (generation === this.hostGeneration && this.hostReady) {
        this.restartAttempts = 0;
      }
    }, 10_000);
    this.stableTimer.unref?.();
  }

  private handleHostFailure(error: Error): void {
    if (this.failed || this.disposed || this.restartScheduled) return;
    this.hostReady = false;
    const host = this.host;
    this.host = null;
    host?.stop();

    if (this.isUnrecoverable(error) || this.restartAttempts >= MAX_HOST_RESTARTS) {
      this.fail(error);
      return;
    }

    this.restartScheduled = true;
    const delay = HOST_RESTART_DELAYS_MS[
      Math.min(this.restartAttempts, HOST_RESTART_DELAYS_MS.length - 1)
    ];
    this.restartAttempts += 1;
    console.warn(
      `[PetOverlay] host failed (attempt ${this.restartAttempts}/${MAX_HOST_RESTARTS}); retrying in ${delay}ms:`,
      error,
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.restartScheduled = false;
      void this.startHost();
    }, delay);
    this.restartTimer.unref?.();
  }

  private isUnrecoverable(error: Error): boolean {
    return error.message.includes("LAYER_SHELL_UNAVAILABLE")
      || error.message.includes("PROTOCOL_MISMATCH");
  }

  private clearRestartTimers(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    this.restartScheduled = false;
  }

  private handlePaint(image: NativeImage): void {
    if (this.failed || this.disposed) return;
    const size = image.getSize();
    const bitmap = image.toBitmap();
    const stride = frameStride(bitmap.length, size.width, size.height);
    if (stride === null) {
      console.warn("[PetOverlay] ignored malformed frame", size, bitmap.length);
      return;
    }
    this.latest = { bitmap, width: size.width, height: size.height };
    if (this.hostReady) this.flushLatestFrame();
  }

  private flushLatestFrame(): void {
    const frame = this.latest;
    const host = this.host;
    if (!frame || !host || !this.hostReady) return;
    const sent = host.sendFrame(
      this.frameSeq++,
      frame.bitmap,
      frame.width,
      frame.height,
    );
    if (sent) this.latest = null;
  }

  private emitReady(): void {
    if (this.readyEmitted || !this.hostReady || !this.pageLoaded) return;
    this.readyEmitted = true;
    this.window.emit("ready-to-show");
  }

  private emitMoved(): void {
    if (this.window.isDestroyed()) return;
    this.window.emit("moved");
  }

  private handleHostEvent(event: HostEvent): void {
    switch (event.type) {
      case "ready":
        if (event.protocol !== PROTOCOL_VERSION) {
          this.fail(new Error(
            `PROTOCOL_MISMATCH: host ${event.protocol}, Electron ${PROTOCOL_VERSION}`,
          ));
          return;
        }
        this.hostReady = true;
        this.flushLatestFrame();
        this.emitReady();
        break;
      case "pointer":
        this.forwardPointer(event);
        break;
      case "drag":
        this.handleDrag(event);
        break;
      case "position":
        this.x = event.x;
        this.y = event.y;
        this.emitMoved();
        break;
      case "log":
        console.log("[PetOverlayHost]", event.message);
        break;
      case "error":
        this.handleHostFailure(new Error(`${event.code}: ${event.message}`));
        break;
    }
  }

  private forwardPointer(event: PointerEvent): void {
    if (this.window.isDestroyed()) return;
    // Host pointer coordinates are logical; the offscreen page is rendered at
    // physical pixels so a 2x buffer stays sharp.
    const x = Math.round(event.x * this.renderScale);
    const y = Math.round(event.y * this.renderScale);
    switch (event.event) {
      case "enter":
        this.window.webContents.sendInputEvent({ type: "mouseEnter", x, y });
        break;
      case "leave":
        this.window.webContents.sendInputEvent({ type: "mouseLeave", x, y });
        break;
      case "motion":
        this.window.webContents.sendInputEvent({ type: "mouseMove", x, y });
        break;
      case "down":
      case "up": {
        const button = pointerButtonName(event.button);
        if (!button) return;
        const clickCount = event.event === "down"
          ? this.resolveClickCount(button, x, y)
          : this.lastPointerClick?.count ?? 1;
        this.window.webContents.sendInputEvent({
          type: event.event === "down" ? "mouseDown" : "mouseUp",
          x,
          y,
          button,
          clickCount,
        });
        break;
      }
      case "axis": {
        const deltaX = event.delta_x ?? 0;
        const deltaY = event.delta_y ?? 0;
        if (deltaX === 0 && deltaY === 0) return;
        this.window.webContents.sendInputEvent({
          type: "mouseWheel",
          x,
          y,
          deltaX,
          deltaY,
          canScroll: true,
        });
        break;
      }
    }
  }

  private resolveClickCount(
    button: "left" | "middle" | "right",
    x: number,
    y: number,
  ): number {
    const now = Date.now();
    const previous = this.lastPointerClick;
    const near = previous
      && previous.button === button
      && now - previous.at <= 400
      && Math.abs(previous.x - x) <= 4
      && Math.abs(previous.y - y) <= 4;
    const count = near ? Math.min(3, previous!.count + 1) : 1;
    this.lastPointerClick = { button, at: now, x, y, count };
    return count;
  }

  private handleDrag(event: DragEvent): void {
    if (event.phase === "start") {
      this.window.webContents.send(IPC.PET_OVERLAY_DRAG, { phase: "start" });
    } else if (event.phase === "end") {
      this.x = event.x;
      this.y = event.y;
      this.window.webContents.send(IPC.PET_OVERLAY_DRAG, { phase: "end" });
      this.emitMoved();
    } else {
      this.x = event.x;
      this.y = event.y;
    }
  }

  private fail(error: Error): void {
    if (this.failed || this.disposed) return;
    this.failed = true;
    console.error("[PetOverlay] failed:", error);
    this.clearRestartTimers();
    this.host?.stop();
    this.host = null;
    this.hostReady = false;
    if (!this.window.isDestroyed()) {
      this.window.emit("pet-overlay-failed", error);
    }
  }
}

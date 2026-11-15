import { app, BrowserWindow, type NativeImage } from "electron";
import path from "node:path";
import { IPC } from "../../shared/ipc-channels";
import { PetOverlayHostClient } from "./host-client";
import {
  frameStride,
  pointerButtonName,
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
}

interface LatestFrame {
  bitmap: Buffer;
  width: number;
  height: number;
}

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
  private readonly host: PetOverlayHostClient;
  private readonly options: PetOverlayControllerOptions;
  private x: number;
  private y: number;
  private width: number;
  private height: number;
  private zoom: number;
  private visible: boolean;
  private alwaysOnTop: boolean;
  private hostReady = false;
  private failed = false;
  private disposed = false;
  private latest: LatestFrame | null = null;
  private frameSeq = 0;
  private readyEmitted = false;
  private pageLoaded = false;

  constructor(options: PetOverlayControllerOptions) {
    this.options = options;
    this.width = options.width;
    this.height = options.height;
    this.x = options.x;
    this.y = options.y;
    this.zoom = options.zoom;
    this.visible = options.showOnReady;
    this.alwaysOnTop = options.alwaysOnTop;

    this.window = new BrowserWindow({
      width: this.width,
      height: this.height,
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

    this.host = new PetOverlayHostClient(options.binaryPath, {
      onEvent: (event) => this.handleHostEvent(event),
      onFailure: (error) => this.fail(error),
      onLog: (message) => console.log("[PetOverlayHost]", message),
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

  isVisible(): boolean {
    return this.visible;
  }

  show(): void {
    if (this.failed || this.disposed) return;
    this.visible = true;
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(IPC.PET_VISIBILITY_CHANGED, true);
    }
    if (this.hostReady) this.host.sendControl({ type: "show" });
  }

  hide(): void {
    if (this.failed || this.disposed) return;
    this.visible = false;
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(IPC.PET_VISIBILITY_CHANGED, false);
    }
    if (this.hostReady) this.host.sendControl({ type: "hide" });
  }

  moveTo(x: number, y: number): void {
    if (this.failed || this.disposed) return;
    this.x = Math.round(x);
    this.y = Math.round(y);
    if (this.hostReady) this.host.sendControl({ type: "move", x: this.x, y: this.y });
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
    this.window.setSize(width, height);
    this.latest = null;
    if (this.hostReady) {
      this.host.sendControl({ type: "size", width, height });
    }
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(IPC.PET_ZOOM, zoom);
    }
  }

  setAlwaysOnTop(alwaysOnTop: boolean): void {
    this.alwaysOnTop = alwaysOnTop;
    if (this.hostReady) {
      this.host.sendControl({ type: "layer", layer: alwaysOnTop ? "overlay" : "top" });
    }
  }

  setInteractive(interactive: boolean): void {
    if (!this.hostReady) return;
    this.host.sendControl({ type: "interactive", interactive });
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
    this.host.stop();
  }

  private async startHost(): Promise<void> {
    try {
      await this.host.start();
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (this.disposed) return;
    this.hostReady = true;
    this.host.sendControl({
      type: "init",
      width: this.width,
      height: this.height,
      x: this.x,
      y: this.y,
    });
    this.host.sendControl({
      type: "layer",
      layer: this.alwaysOnTop ? "overlay" : "top",
    });
    if (this.visible) this.host.sendControl({ type: "show" });
    else this.host.sendControl({ type: "hide" });
    this.flushLatestFrame();
    this.emitReady();
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
    if (!frame || !this.hostReady) return;
    const sent = this.host.sendFrame(
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
        this.fail(new Error(`${event.code}: ${event.message}`));
        break;
    }
  }

  private forwardPointer(event: PointerEvent): void {
    if (this.window.isDestroyed()) return;
    const x = Math.round(event.x);
    const y = Math.round(event.y);
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
        this.window.webContents.sendInputEvent({
          type: event.event === "down" ? "mouseDown" : "mouseUp",
          x,
          y,
          button,
          clickCount: 1,
        });
        break;
      }
      case "axis":
        // The pet page currently has no wheel interaction; ignore until the
        // host forwards precise scroll deltas.
        break;
    }
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
    this.host.stop();
    if (!this.window.isDestroyed()) {
      this.window.emit("pet-overlay-failed", error);
    }
  }
}

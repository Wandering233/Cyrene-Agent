import { app, BrowserWindow, screen } from "electron";
import path from "node:path";
import { PetOverlayHostClient } from "../pet-overlay/host-client";
import { resolveOverlayHostBinary } from "../pet-overlay";
import type { HostEvent } from "../pet-overlay/protocol";
import {
  TOAST_MAX_WORKAREA_RATIO,
  TOAST_WINDOW_WIDTH,
} from "./types";

export interface ToastOverlayDisplay {
  workArea: { x: number; y: number; width: number; height: number };
  label?: string;
}

export interface ToastOverlayOptions {
  isDev: boolean;
  resolveDisplay?: () => ToastOverlayDisplay;
}

export interface ToastOverlayController {
  updateHeight(height: number): void;
  syncVisibility(hasToasts: boolean): void;
  send(channel: string, payload: unknown): void;
  preload(): void;
  isVisible(): boolean;
  owns(webContents: { id: number }): boolean;
  dispose(): void;
}

function normalizeOutputName(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const match = /\(([^)]+)\)\s*$/.exec(label);
  return (match?.[1] ?? label).trim() || undefined;
}

/**
 * Wayland toast overlay backend.
 *
 * Mirrors the pet overlay architecture: the real toast page renders in a
 * hidden offscreen window, and a native layer-shell host presents the frames
 * at the work-area's bottom-right corner with alpha-shaped input. This gives
 * real click-through outside the toast cards and no focus stealing.
 */
export function createToastOverlayController(
  options: ToastOverlayOptions,
): ToastOverlayController {
  const binaryPath = resolveOverlayHostBinary("layer");
  if (!binaryPath) throw new Error("toast overlay host binary unavailable");

  let window: BrowserWindow | null = null;
  let host: PetOverlayHostClient | null = null;
  let hostReady = false;
  let visible = false;
  let disposed = false;
  let contentHeight = 1;
  let latest: { bitmap: Buffer; width: number; height: number } | null = null;
  let frameSeq = 0;

  const displayInfo = (): ToastOverlayDisplay => {
    if (options.resolveDisplay) return options.resolveDisplay();
    const point = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point);
    return { workArea: display.workArea, label: display.label };
  };

  const position = (): { x: number; y: number; output?: string } => {
    const area = displayInfo().workArea;
    const output = normalizeOutputName(displayInfo().label);
    return {
      x: Math.max(0, area.width - TOAST_WINDOW_WIDTH),
      y: Math.max(0, area.height - contentHeight),
      output,
    };
  };

  const ensureWindow = (): BrowserWindow => {
    if (window && !window.isDestroyed()) return window;
    const created = new BrowserWindow({
      width: TOAST_WINDOW_WIDTH,
      height: contentHeight,
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
        additionalArguments: ["--cyrene-toast-overlay=1"],
      },
    });
    created.setTitle("Cyrene Toast Overlay");
    created.webContents.setFrameRate(30);
    created.webContents.on("paint", (_event, _dirty, image) => {
      if (disposed) return;
      const size = image.getSize();
      latest = { bitmap: image.toBitmap(), width: size.width, height: size.height };
      if (hostReady && visible) sendLatest();
    });
    created.webContents.on("console-message", (_event, _level, message) => {
      console.log("[ToastOverlayRenderer]", message);
    });
    created.on("closed", () => { window = null; });
    if (options.isDev) {
      void created.loadURL("http://localhost:5173/toast/");
    } else {
      void created.loadFile(path.join(app.getAppPath(), "dist", "renderer", "toast", "index.html"));
    }
    window = created;
    return created;
  };

  const startHost = (): void => {
    if (host || disposed) return;
    const client = new PetOverlayHostClient(binaryPath, {
      onEvent: (event) => handleHostEvent(event),
      onFailure: (error) => {
        console.warn("[ToastOverlay] host failed:", error.message);
        hostReady = false;
      },
      onLog: (message) => console.log("[ToastOverlayHost]", message),
    }, ["--layer", "overlay"]);
    host = client;
    void client.start().then(() => {
      if (disposed || host !== client) return;
      hostReady = true;
      const pos = position();
      client.sendControl({
        type: "init",
        protocol: 1,
        width: TOAST_WINDOW_WIDTH,
        height: contentHeight,
        x: pos.x,
        y: pos.y,
        scale: 1,
        output: pos.output,
        namespace: "cyrene-toast",
        layer: "overlay",
      });
      client.sendControl({ type: "size", width: TOAST_WINDOW_WIDTH, height: contentHeight });
      if (latest) sendLatest();
      if (visible) client.sendControl({ type: "show" });
    }).catch((error: unknown) => {
      console.warn("[ToastOverlay] host start failed:", error instanceof Error ? error.message : String(error));
      hostReady = false;
    });
  };

  const sendLatest = (): void => {
    if (!host || !latest) return;
    // Ignore stale paints from before a resize: the host rejects a frame whose
    // dimensions do not match the current buffer.
    if (latest.height !== contentHeight) return;
    if (host.sendFrame(frameSeq++, latest.bitmap, latest.width, latest.height)) {
      if (visible) host.sendControl({ type: "show" });
    }
  };

  const handleHostEvent = (event: HostEvent): void => {
    if (event.type === "pointer" && window && !window.isDestroyed()) {
      const x = Math.round(event.x);
      const y = Math.round(event.y);
      if (event.event === "motion" || event.event === "enter") {
        window.webContents.sendInputEvent({ type: "mouseMove", x, y });
      } else if (event.event === "down" || event.event === "up") {
        const button = event.button === 0x111 ? "middle" : event.button === 0x112 ? "right" : "left";
        window.webContents.sendInputEvent({
          type: event.event === "down" ? "mouseDown" : "mouseUp",
          x, y, button, clickCount: 1,
        });
      } else if (event.event === "axis") {
        window.webContents.sendInputEvent({
          type: "mouseWheel",
          x, y,
          deltaX: Math.round(-(event.delta_x ?? 0)),
          deltaY: Math.round(-(event.delta_y ?? 0)),
          canScroll: true,
        });
      }
    }
  };

  const applyBounds = (): void => {
    const win = window;
    if (!win || win.isDestroyed()) return;
    const pos = position();
    try { win.setBounds({ x: 0, y: 0, width: TOAST_WINDOW_WIDTH, height: contentHeight }); } catch { /* ignore */ }
    if (host && hostReady) {
      host.sendControl({ type: "move", x: pos.x, y: pos.y });
      host.sendControl({ type: "size", width: TOAST_WINDOW_WIDTH, height: contentHeight });
      if (latest) sendLatest();
    }
  };

  return {
    updateHeight(height: number): void {
      if (!Number.isFinite(height) || height <= 0) return;
      const area = displayInfo().workArea;
      const maxHeight = Math.max(1, Math.floor(area.height * TOAST_MAX_WORKAREA_RATIO));
      const next = Math.max(1, Math.min(Math.round(height), maxHeight));
      if (next === contentHeight) return;
      contentHeight = next;
      const win = ensureWindow();
      applyBounds();
      try { win.webContents.invalidate(); } catch { /* destroyed */ }
    },
    syncVisibility(hasToasts: boolean): void {
      visible = hasToasts;
      ensureWindow();
      startHost();
      if (!hasToasts) {
        if (hostReady) host?.sendControl({ type: "hide" });
        return;
      }
      applyBounds();
      if (hostReady) host?.sendControl({ type: "show" });
    },
    send(channel: string, payload: unknown): void {
      const win = window;
      if (!win || win.isDestroyed()) return;
      try { win.webContents.send(channel, payload); } catch { /* page not ready */ }
    },
    preload(): void {
      ensureWindow();
      startHost();
    },
    isVisible(): boolean {
      return visible && !!host;
    },
    owns(webContents: { id: number }): boolean {
      return !!window && !window.isDestroyed() && window.webContents.id === webContents.id;
    },
    dispose(): void {
      disposed = true;
      host?.stop();
      host = null;
      if (window && !window.isDestroyed()) window.destroy();
      window = null;
      latest = null;
    },
  };
}

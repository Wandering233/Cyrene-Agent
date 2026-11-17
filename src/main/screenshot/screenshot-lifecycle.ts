import * as path from "node:path";
import * as fs from "fs";
import { spawn } from "node:child_process";
import { app, BrowserWindow, ClipboardItem, clipboard, globalShortcut, nativeImage } from "electron";
import { randomUUID } from "crypto";
import { normalizeScreenshotShortcut, type ScreenshotShortcutStatus, type ScreenshotShortcutResult } from "../../shared/screenshot-shortcut";
import { IPC } from "../../shared/ipc-channels";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import { ElectronScreenshotHelperClient } from "./helper-client";
import { resolveScreenshotHelperPath } from "./helper-path";
import { captureLinuxScreenshot, pruneScreenshotDirectory } from "./linux-screenshot";
import { annotateScreenshot } from "../annotation/annotation-window";
import { hasHyprlandShortcutConflict, installHyprlandScreenshotHotkey } from "./hyprland-hotkey";
import { GlobalShortcutsPortal, toPortalTrigger } from "../portal/global-shortcuts";
import {
  setScreenshotControlHandler,
  setScreenshotWindowControlHandler,
} from "../control/control-server";
import {
  createScreenshotService,
  validateScreenshotInsert,
  type ScreenshotInsertData,
  type ScreenshotService,
} from "./screenshot-service";

export type { ScreenshotService };

export interface ScreenshotLifecycleOptions {
  initialHotkey: string;
  initialHotkeyEnabled?: boolean;
  saveShortcutSettings?(settings: { screenshotHotkey: string; screenshotHotkeyEnabled: boolean }): void;
  getReactChatWindow: () => BrowserWindow | null;
  capturePetWindow: () => Promise<Electron.NativeImage | null>;
  /** 传入共享 scope 以便退出时统一注销；缺省时使用独立 scope。 */
  ipc?: IpcScope;
}

const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;

function getScreenshotDirectory(): string {
  return path.join(app.getPath("userData"), "screenshots");
}

/**
 * 确保 helper 的输出目录存在。
 * WIC InitializeFromFilename 不会创建父目录：目录缺失时打开 `<uuid>.png.tmp`
 * 直接报 0x80070003（ERROR_PATH_NOT_FOUND）。mkdir recursive 幂等，重复调用无害。
 */
async function ensureScreenshotDirectory(directory: string): Promise<void> {
  try {
    await fs.promises.mkdir(directory, { recursive: true });
  } catch (error) {
    console.error("[Screenshot] 创建截图目录失败:", directory, error);
  }
}

async function saveScreenshotPasteTemp(
  base64: string,
  _mime: string,
): Promise<{ filePath: string }> {
  const raw = Buffer.from(base64, "base64");
  if (raw.byteLength > MAX_SCREENSHOT_BYTES) {
    throw new Error("SCREENSHOT_TOO_LARGE");
  }
  const image = nativeImage.createFromBuffer(raw);
  if (image.isEmpty()) {
    throw new Error("INVALID_SCREENSHOT_IMAGE");
  }
  const screenshotDirectory = getScreenshotDirectory();
  await fs.promises.mkdir(screenshotDirectory, { recursive: true });
  const filePath = path.join(screenshotDirectory, `${randomUUID()}.png`);
  await fs.promises.writeFile(filePath, image.toPNG());
  return { filePath };
}

export function initializeScreenshotService(
  options: ScreenshotLifecycleOptions,
): ScreenshotService {
  const { getReactChatWindow, capturePetWindow } = options;
  const ipc = options.ipc ?? createIpcScope();
  const screenshotDirectory = getScreenshotDirectory();

  const validateInsert = (data: ScreenshotInsertData): ScreenshotInsertData => {
    let previewImage: Electron.NativeImage | null = null;
    const validated = validateScreenshotInsert(
      data,
      screenshotDirectory,
      (filePath) => {
        previewImage = nativeImage.createFromPath(filePath);
        return previewImage;
      },
    );
    if (!validated) {
      throw new Error(`INVALID_SCREENSHOT_RESULT:${data.filePath}`);
    }
    // React 开发预览运行在 http://，Chromium 会拦截 file:// 图片。
    // 截图体积有限，直接回传 data URL，旧 Chat 与 React 都能稳定显示。
    return {
      ...validated,
      previewUrl: previewImage ? (previewImage as Electron.NativeImage).toDataURL() : validated.previewUrl,
    };
  };

  const resolveHelperPath = () =>
    resolveScreenshotHelperPath({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      envOverride: process.env.CYRENE_SCREENSHOT_HELPER_PATH,
    });
  const isHelperAvailable = () => {
    try {
      return fs.existsSync(resolveHelperPath());
    } catch {
      return false;
    }
  };
  const useLinuxCapture = process.platform === "linux"
    && (process.env.XDG_SESSION_TYPE === "wayland" || Boolean(process.env.WAYLAND_DISPLAY));
  const capture = useLinuxCapture
    ? async (interactive: boolean, target?: "region" | "window") => {
      const filePath = await captureLinuxScreenshot({
        interactive,
        target: target ?? (interactive ? "region" : "screen"),
        outputDirectory: screenshotDirectory,
      });
      const image = nativeImage.createFromPath(filePath);
      const size = image.getSize();
      if (image.isEmpty() || size.width <= 0 || size.height <= 0) {
        throw new Error("SCREENSHOT_INVALID_IMAGE");
      }
      return { filePath, width: size.width, height: size.height };
    }
    : undefined;
  const client = new ElectronScreenshotHelperClient({
    spawnImpl: (command, args) =>
      spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }),
    resolveHelperPath,
    screenshotDirectory,
    logger: console,
  });
  // 启动即建目录 + 记录实际输出目录（排查 0x80070003 类路径问题）。
  void ensureScreenshotDirectory(screenshotDirectory);
  if (process.platform === "linux") {
    void pruneScreenshotDirectory(screenshotDirectory);
  }
  console.log("[Screenshot] helper output-dir =", screenshotDirectory);

  let hyprlandHotkey: ReturnType<typeof installHyprlandScreenshotHotkey> = null;
  let portalHotkey: GlobalShortcutsPortal | null = null;
  let portalAttempt = 0;
  let shortcutStatus: ScreenshotShortcutStatus = { phase: "disabled", accelerator: options.initialHotkey };
  let lastRegistration: Promise<boolean> = Promise.resolve(true);
  const setShortcutStatus = (status: ScreenshotShortcutStatus) => { shortcutStatus = status; };
  const shortcutConflict = (accelerator: string): boolean => {
    if (process.env.HYPRLAND_INSTANCE_SIGNATURE && process.env.CYRENE_HYPRLAND_HOTKEY !== "0") {
      return hasHyprlandShortcutConflict(accelerator, hyprlandHotkey?.bind);
    }
    return globalShortcut.isRegistered(accelerator) && shortcutStatus.accelerator !== accelerator;
  };
  const service = createScreenshotService({
    client,
    capture,
    annotate: useLinuxCapture
      ? (filePath) => annotateScreenshot(filePath, getReactChatWindow())
      : undefined,
    cleanupFile: (filePath) => {
      try { fs.rmSync(filePath, { force: true }); } catch { /* ignore */ }
    },
    copyToClipboard: (filePath) => {
      try {
        const png = fs.readFileSync(filePath);
        void clipboard.write([
          new ClipboardItem({ "image/png": new Blob([png], { type: "image/png" }) }),
        ]);
      } catch (error) {
        console.warn("[Screenshot] failed to copy image to clipboard:", error);
      }
    },
    isAvailable: () => (useLinuxCapture ? true : isHelperAvailable()),
    registerShortcut: (accelerator, callback) => {
      lastRegistration = Promise.resolve(false);
      try {
        if (!normalizeScreenshotShortcut(accelerator)) {
          setShortcutStatus({ phase: "error", accelerator, error: "invalid" });
          return false;
        }
        if (shortcutConflict(accelerator)) {
          setShortcutStatus({ phase: "error", accelerator, error: "conflict" });
          return false;
        }
      } catch {
        setShortcutStatus({ phase: "error", accelerator, error: "unavailable" });
        return false;
      }
      hyprlandHotkey = installHyprlandScreenshotHotkey(accelerator);
      if (hyprlandHotkey) {
        setShortcutStatus({ phase: "active", accelerator, backend: "hyprland" });
        lastRegistration = Promise.resolve(true);
        return true;
      }
      const trigger = toPortalTrigger(accelerator);
      if (!trigger) {
        let registered = false;
        try { registered = globalShortcut.register(accelerator, callback); } catch { /* unavailable */ }
        setShortcutStatus(registered
          ? { phase: "active", accelerator, backend: "electron" }
          : { phase: "error", accelerator, error: "unavailable" });
        lastRegistration = Promise.resolve(registered);
        return registered;
      }
      const attempt = ++portalAttempt;
      setShortcutStatus({ phase: "registering", accelerator });
      lastRegistration = (async () => {
        const portal = trigger ? new GlobalShortcutsPortal() : null;
        try {
          if (!portal || !trigger) throw new Error("portal trigger unavailable");
          await portal.bind([{ id: "screenshot", description: "Cyrene 截图", preferredTrigger: trigger }]);
          if (attempt !== portalAttempt) { await portal.close(); return false; }
          portalHotkey = portal;
          portal.onActivated(() => callback());
          setShortcutStatus({ phase: "active", accelerator, backend: "portal" });
          return true;
        } catch (error) {
          await portal?.close().catch(() => {});
          if (attempt !== portalAttempt) return false;
          const denied = error instanceof Error && /denied|cancel|response\s*[12]/i.test(error.message);
          if (denied) {
            setShortcutStatus({ phase: "error", accelerator, error: "denied" });
            return false;
          }
          let registered = false;
          try { registered = globalShortcut.register(accelerator, callback); } catch { /* invalid/unsupported */ }
          setShortcutStatus(registered
            ? { phase: "active", accelerator, backend: "electron" }
            : { phase: "error", accelerator, error: "unavailable" });
          return registered;
        }
      })();
      return true;
    },
    unregisterShortcut: (accelerator) => {
      hyprlandHotkey?.uninstall();
      hyprlandHotkey = null;
      portalAttempt += 1;
      const portal = portalHotkey;
      portalHotkey = null;
      if (portal) void portal.close();
      globalShortcut.unregister(accelerator);
      setShortcutStatus({ phase: "disabled", accelerator });
    },
    sendInsert: (data) => {
      const validated = validateInsert(data);
      const reactChatWindow = getReactChatWindow();
      if (reactChatWindow && !reactChatWindow.isDestroyed()) {
        reactChatWindow.webContents.send(IPC.SCREENSHOT_INSERT, validated);
      }
    },
  });

  let quitting = false;
  let configuring = false;
  let configured = { accelerator: options.initialHotkey, enabled: options.initialHotkeyEnabled !== false };
  ipc.handle(IPC.SCREENSHOT_SHORTCUT_GET, () => ({ ...shortcutStatus }));
  ipc.handle(IPC.SCREENSHOT_SHORTCUT_SET, async (_event, request: unknown): Promise<ScreenshotShortcutResult> => {
    if (quitting || configuring || !request || typeof request !== "object") {
      return { ok: false, error: "unavailable", status: { ...shortcutStatus } };
    }
    const input = request as { accelerator?: unknown; enabled?: unknown };
    const accelerator = typeof input.accelerator === "string" ? normalizeScreenshotShortcut(input.accelerator) : null;
    if (!accelerator || typeof input.enabled !== "boolean") {
      return { ok: false, error: "invalid", status: { ...shortcutStatus } };
    }
    configuring = true;
    const previous = { ...configured };
    try {
      if (input.enabled && shortcutConflict(accelerator)) {
        return { ok: false, error: "conflict", status: { ...shortcutStatus } };
      }
      // End recording suspension before registration; the candidate is checked before removing the old binding.
      service.setHotkeyEnabled?.(false);
      service.resumeHotkey();
      service.replaceHotkey(accelerator);
      setShortcutStatus({ phase: "disabled", accelerator });
      if (input.enabled) {
        service.setHotkeyEnabled?.(true);
        const registered = await lastRegistration;
        if (quitting) return { ok: false, error: "unavailable", status: { ...shortcutStatus } };
        if (!registered || shortcutStatus.phase !== "active") {
          const error = shortcutStatus.error ?? "unavailable";
          service.setHotkeyEnabled?.(false);
          service.replaceHotkey(previous.accelerator);
          if (previous.enabled) { service.setHotkeyEnabled?.(true); await lastRegistration; }
          return { ok: false, error, status: { ...shortcutStatus } };
        }
      }
      options.saveShortcutSettings?.({ screenshotHotkey: accelerator, screenshotHotkeyEnabled: input.enabled });
      configured = { accelerator, enabled: input.enabled };
      return { ok: true, status: { ...shortcutStatus } };
    } catch {
      service.setHotkeyEnabled?.(false);
      service.replaceHotkey(previous.accelerator);
      if (previous.enabled) { service.setHotkeyEnabled?.(true); await lastRegistration; }
      return { ok: false, error: "unavailable", status: { ...shortcutStatus } };
    } finally { configuring = false; }
  });

  ipc.handle(IPC.SCREENSHOT_START, async (event) => {
    // 请求前兜底重建目录：清理软件可能删掉 AppData 下的子目录，
    // helper 的 WIC 编码不会自建父目录（0x80070003）。
    await ensureScreenshotDirectory(screenshotDirectory);
    return service.startFromChatButton((data) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC.SCREENSHOT_INSERT, validateInsert(data));
      }
    });
  });
  ipc.handle(IPC.SCREENSHOT_SAVE_TEMP, (_event, base64: string, mime: string) =>
    saveScreenshotPasteTemp(base64, mime),
  );
  ipc.handle(IPC.SCREENSHOT_HOTKEY_CAPTURE_START, () => {
    service.suspendHotkey();
    return true;
  });
  ipc.handle(IPC.SCREENSHOT_HOTKEY_CAPTURE_END, () => {
    service.resumeHotkey();
    return true;
  });

  ipc.handle("debug:screenshot", async () => {
    const image = await capturePetWindow();
    if (!image) return null;
    const png = image.toPNG();
    const outPath = path.join(app.getPath("temp"), "cyrene-screenshot.png");
    fs.writeFileSync(outPath, png);
    return outPath;
  });

  if (!useLinuxCapture && !isHelperAvailable()) {
    console.warn(
      "[Screenshot] 原生截图助手不可用，截图热键与聊天截图入口已禁用:",
      resolveHelperPath(),
    );
  } else if (useLinuxCapture) {
    console.log("[Screenshot] Linux Wayland backend: grim/slurp (Hyprland) or xdg-desktop-portal");
  }
  setScreenshotControlHandler(async () => {
    const result = await service.startFromHotkey();
    if (!result.ok) throw new Error(result.reason ?? "SCREENSHOT_FAILED");
  });
  setScreenshotWindowControlHandler(async () => {
    const result = await service.startFromChatButton(undefined, "window");
    if (!result.ok) throw new Error(result.reason ?? "SCREENSHOT_FAILED");
  });
  app.once("will-quit", () => { quitting = true; void service.shutdown(); });
  service.setHotkeyEnabled?.(options.initialHotkeyEnabled !== false);
  service.init(options.initialHotkey);
  return service;
}

import { app, BrowserWindow, screen } from "electron";
import path from "node:path";
import { IPC } from "../../shared/ipc-channels";
import { createPetOverlayWindow, shouldUsePetOverlay } from "../pet-overlay";

/** 桌宠窗口的基础尺寸（zoom=1.0 时）。缩放因子改变窗口与模型尺寸，二者同步。 */
export const PET_WINDOW_BASE_WIDTH = 400;
export const PET_WINDOW_BASE_HEIGHT = 500;

function normalizeOutputLabel(label: string | undefined): string | undefined {
  const trimmed = typeof label === "string" ? label.trim() : "";
  if (!trimmed) return undefined;
  return trimmed.replace(/^\((.*)\)$/, "$1");
}

/**
 * 仅创建阶段需要的 GeneralSettings 切片。
 * 避免反向依赖 index.ts 中的完整 loadGeneralSettings。
 */
export interface PetWindowSettingsSlice {
  petWindowX?: number;
  petWindowY?: number;
  petWindowOutput?: string;
  petWindowPositions?: Record<string, { x: number; y: number }>;
  /** 桌宠缩放因子；离屏判定需按缩放后的实际窗口尺寸计算。 */
  petZoom?: number;
  /** 桌宠窗口置顶设置；窗口重建时需重新应用。 */
  petAlwaysOnTop?: boolean;
  disclaimerAcceptedVersion?: string;
}

export interface CreatePetWindowContext {
  loadGeneralSettings: () => PetWindowSettingsSlice;
  getCurrentAppIconPath: () => string;
  isDev: boolean;
}

export interface CreatePetWindowOptions {
  /** 窗口 ready 后是否立即 show；默认 true。启动闪屏场景可先隐藏，等闪屏关闭再显示。 */
  showOnReady?: boolean;
  /** 原生 overlay 失败后的回退路径：强制使用普通 BrowserWindow。 */
  forceNormal?: boolean;
}

/**
 * 创建主桌宠窗口。
 * 只负责机械构造：恢复上次坐标、创建 BrowserWindow、加载 URL/文件、
 * 绑定 show/hide 可见性广播。不含业务 getter 注入。
 */
export function createPetWindow(
  ctx: CreatePetWindowContext,
  options: CreatePetWindowOptions = {},
): BrowserWindow {
  const { showOnReady = true } = options;
  const settings = ctx.loadGeneralSettings();
  const transparent = true;
  // 窗口实际尺寸随 petZoom 等比缩放；创建尺寸与离屏判定保持一致。
  const zoom = typeof settings.petZoom === "number" && settings.petZoom > 0 ? settings.petZoom : 1;
  const petWidth = Math.round(PET_WINDOW_BASE_WIDTH * zoom);
  const petHeight = Math.round(PET_WINDOW_BASE_HEIGHT * zoom);
  let restoreX: number | undefined;
  let restoreY: number | undefined;

  const savedOutput = settings.petWindowOutput;
  const savedByOutput = savedOutput
    ? settings.petWindowPositions?.[savedOutput]
    : undefined;
  const savedOutputPresent = savedOutput
    ? screen.getAllDisplays().some(
      (display) => normalizeOutputLabel(display.label) === savedOutput,
    )
    : false;
  const savedX = savedOutputPresent ? savedByOutput?.x : settings.petWindowX;
  const savedY = savedOutputPresent ? savedByOutput?.y : settings.petWindowY;

  if (savedX !== undefined && savedY !== undefined) {
    const targetBounds = {
      x: savedX,
      y: savedY,
      width: petWidth,
      height: petHeight,
    };
    const display = screen.getDisplayMatching(targetBounds);
    const wa = display.workArea;

    // 窗口与 workArea 交集至少占窗口的三分之一才使用保存的坐标
    const interW =
      Math.min(targetBounds.x + petWidth, wa.x + wa.width) -
      Math.max(targetBounds.x, wa.x);
    const interH =
      Math.min(targetBounds.y + petHeight, wa.y + wa.height) -
      Math.max(targetBounds.y, wa.y);

    if (interW >= petWidth / 3 && interH >= petHeight / 3) {
      restoreX = savedX;
      restoreY = savedY;
    } else {
      console.log(
        "[Cyrene] 桌宠保存位置已离屏（仅 " +
          interW + "x" + interH + " 可见），回退到屏幕中央",
      );
    }
  }

  if (restoreX === undefined || restoreY === undefined) {
    // 无保存坐标或已离屏：居中到主屏工作区，避免落在不可见区域
    const wa = screen.getPrimaryDisplay().workArea;
    restoreX = Math.round(wa.x + (wa.width - petWidth) / 2);
    restoreY = Math.round(wa.y + (wa.height - petHeight) / 2);
  }

  const targetDisplay = screen.getDisplayMatching({
    x: restoreX,
    y: restoreY,
    width: petWidth,
    height: petHeight,
  });
  // Electron's Wayland display label is often "(HDMI-A-1)"; layer-shell
  // expects the bare wl_output name.
  const outputLabel = normalizeOutputLabel(targetDisplay.label);
  const requestedScale = Number(process.env.CYRENE_OVERLAY_SCALE);
  const displayScale = Number(targetDisplay.scaleFactor);
  const overlayScale = Math.max(
    1,
    Math.ceil(Number.isFinite(requestedScale) && requestedScale > 0 ? requestedScale : displayScale),
  );

  if (!options.forceNormal && shouldUsePetOverlay()) {
    try {
      const overlay = createPetOverlayWindow({
        isDev: ctx.isDev,
        width: petWidth,
        height: petHeight,
        x: restoreX,
        y: restoreY,
        zoom,
        alwaysOnTop: settings.petAlwaysOnTop ?? true,
        showOnReady,
        output: outputLabel,
        scale: overlayScale,
      });
      if (overlay) {
        console.log("[Cyrene] using native Wayland pet overlay host");
        return overlay.window;
      }
    } catch (error) {
      console.error("[Cyrene] native pet overlay unavailable, falling back:", error);
    }
  }

  const win = new BrowserWindow({
    x: restoreX,
    y: restoreY,
    width: petWidth,
    height: petHeight,
    transparent,
    frame: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: false,
    icon: ctx.getCurrentAppIconPath(),
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (ctx.isDev) {
    win.loadURL("http://localhost:5173");
  } else {
    win.loadFile(path.join(app.getAppPath(), "dist", "renderer", "index.html"));
  }

  // Linux 不支持 setIgnoreMouseEvents 的 forward 选项：一旦忽略鼠标事件，
  // 渲染层就再也收不到 pointermove，无法按像素恢复交互。Linux 先保持窗口可交互，
  // 由渲染层按模型 alpha 控制交互的完整方案留待后续平台适配。
  const supportsMouseForwarding = process.platform === "win32" || process.platform === "darwin";
  if (!ctx.isDev && supportsMouseForwarding) {
    win.setIgnoreMouseEvents(true, { forward: true });
  }

  win.on("hide", () => {
    win.webContents.send(IPC.PET_VISIBILITY_CHANGED, false);
  });
  win.on("show", () => {
    win.webContents.send(IPC.PET_VISIBILITY_CHANGED, true);
  });

  win.once("ready-to-show", () => {
    if (showOnReady && !win.isDestroyed()) {
      win.show();
    }
  });

  return win;
}

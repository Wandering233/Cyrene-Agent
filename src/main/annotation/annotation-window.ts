import { app, BrowserWindow, ipcMain, nativeImage, screen } from "electron";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface AnnotateScreenshotOptions {
  /** Test seam: lets a harness drive the window without manual input. */
  onWindow?(window: BrowserWindow): void;
}

const SAVE_CHANNEL = "screenshot:annotate-save";

/**
 * Simple local annotation editor for Linux screenshots.
 *
 * The Windows helper draws its own annotation UI. On Wayland we capture with
 * grim/portal, then edit the resulting PNG in a small self-contained Electron
 * window (pen, rectangle, arrow, undo, clear, save/cancel).
 */
export async function annotateScreenshot(
  filePath: string,
  parent: BrowserWindow | null = null,
  options: AnnotateScreenshotOptions = {},
): Promise<string | null> {
  const image = nativeImage.createFromPath(filePath);
  if (image.isEmpty()) throw new Error("SCREENSHOT_INVALID_IMAGE");
  const { width: imageWidth, height: imageHeight } = image.getSize();
  if (imageWidth <= 0 || imageHeight <= 0) throw new Error("SCREENSHOT_INVALID_IMAGE");

  const workArea = screen.getDisplayMatching({
    x: 0, y: 0, width: imageWidth, height: imageHeight,
  }).workArea;
  const maxWidth = Math.max(320, Math.min(workArea.width - 80, 1280));
  const maxHeight = Math.max(240, Math.min(workArea.height - 120, 900));
  const scale = Math.min(1, maxWidth / imageWidth, maxHeight / imageHeight);
  const windowWidth = Math.max(320, Math.round(imageWidth * scale));
  const windowHeight = Math.min(maxHeight + 52, Math.round(imageHeight * scale) + 52);

  const window = new BrowserWindow({
    parent: parent ?? undefined,
    modal: parent !== null,
    show: false,
    width: windowWidth,
    height: windowHeight,
    minWidth: 320,
    minHeight: 280,
    backgroundColor: "#17181c",
    title: "标注截图",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });

  const outputPath = path.join(
    path.dirname(filePath),
    `${randomUUID()}-annotated.png`,
  );

  let settled = false;
  const finish = (result: string | null): void => {
    if (settled) return;
    settled = true;
    ipcMain.off(SAVE_CHANNEL, onSave);
    if (!window.isDestroyed()) window.close();
    resolve(result);
  };
  let resolve: (value: string | null) => void = () => {};
  const resultPromise = new Promise<string | null>((r) => { resolve = r; });

  const onSave = (event: Electron.IpcMainEvent, dataUrl: unknown): void => {
    if (event.sender !== window.webContents) return;
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) {
      finish(null);
      return;
    }
    try {
      const png = Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64");
      fs.writeFileSync(outputPath, png, { mode: 0o600 });
      finish(outputPath);
    } catch {
      finish(null);
    }
  };
  ipcMain.on(SAVE_CHANNEL, onSave);

  window.once("closed", () => {
    if (!settled) {
      settled = true;
      ipcMain.off(SAVE_CHANNEL, onSave);
      resolve(null);
    }
  });

  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(ANNOTATION_HTML)}`);
  window.webContents.send("screenshot:annotate-image", image.toDataURL());
  window.show();
  options.onWindow?.(window);
  return resultPromise;
}

const ANNOTATION_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { margin:0; height:100%; background:#17181c; color:#e8e8ee;
    font:12px system-ui, sans-serif; overflow:hidden; }
  #bar { height:46px; display:flex; gap:6px; align-items:center; padding:0 10px;
    background:#24252b; border-bottom:1px solid #343640; }
  button { background:#343640; color:#e8e8ee; border:1px solid #454854;
    border-radius:6px; padding:5px 9px; cursor:pointer; font:inherit; }
  button.active { background:#5a6cff; border-color:#5a6cff; }
  #stage { position:absolute; inset:46px 0 0 0; display:flex; align-items:center;
    justify-content:center; overflow:hidden; }
  canvas { background:#000; box-shadow:0 0 0 1px #444; cursor:crosshair;
    max-width:100%; max-height:100%; }
</style></head><body>
<div id="bar">
  <button data-tool="pen" class="active">画笔</button>
  <button data-tool="rect">矩形</button>
  <button data-tool="arrow">箭头</button>
  <button id="undo">撤销</button>
  <button id="clear">清空</button>
  <span style="flex:1"></span>
  <button id="save" style="background:#2f8f5b;border-color:#2f8f5b">保存</button>
  <button id="cancel">取消</button>
</div>
<div id="stage"><canvas id="canvas"></canvas></div>
<script>
  const { ipcRenderer } = require("electron");
  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  let tool = "pen", drawing = false, start = null, snapshot = null;
  let history = [];
  const syncSize = () => {
    const stage = document.getElementById("stage");
    const maxW = stage.clientWidth - 20, maxH = stage.clientHeight - 20;
    const scale = Math.min(1, maxW / canvas.width, maxH / canvas.height);
    canvas.style.width = Math.max(1, Math.round(canvas.width * scale)) + "px";
    canvas.style.height = Math.max(1, Math.round(canvas.height * scale)) + "px";
  };
  ipcRenderer.on("screenshot:annotate-image", (_e, dataUrl) => {
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width; canvas.height = img.height;
      ctx.drawImage(img, 0, 0); syncSize();
    };
    img.src = dataUrl;
  });
  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => {
      tool = button.dataset.tool;
      document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("active", b === button));
    });
  });
  document.getElementById("undo").onclick = () => {
    const previous = history.pop();
    if (!previous) return;
    const img = new Image();
    img.onload = () => { ctx.clearRect(0,0,canvas.width,canvas.height); ctx.drawImage(img,0,0); };
    img.src = previous;
  };
  document.getElementById("clear").onclick = () => {
    pushHistory();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  };
  document.getElementById("save").onclick = () => {
    ipcRenderer.send("screenshot:annotate-save", canvas.toDataURL("image/png"));
  };
  document.getElementById("cancel").onclick = () => window.close();
  function pushHistory() {
    history.push(canvas.toDataURL("image/png"));
    if (history.length > 12) history.shift();
  }
  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  }
  canvas.addEventListener("pointerdown", (event) => {
    pushHistory();
    drawing = true; start = point(event);
    snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
    canvas.setPointerCapture(event.pointerId);
    if (tool === "pen") {
      ctx.beginPath(); ctx.moveTo(start.x, start.y);
      ctx.strokeStyle = "#ff4d6d"; ctx.lineWidth = Math.max(2, canvas.width / 400);
      ctx.lineCap = "round"; ctx.lineJoin = "round";
    }
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!drawing) return;
    const current = point(event);
    if (tool === "pen") {
      ctx.lineTo(current.x, current.y); ctx.stroke();
      return;
    }
    ctx.putImageData(snapshot, 0, 0);
    ctx.strokeStyle = "#ff4d6d"; ctx.lineWidth = Math.max(2, canvas.width / 400);
    ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.lineTo(current.x, current.y); ctx.stroke();
    if (tool === "rect") {
      ctx.strokeRect(start.x, start.y, current.x - start.x, current.y - start.y);
    } else if (tool === "arrow") {
      const angle = Math.atan2(current.y - start.y, current.x - start.x);
      const head = Math.max(10, canvas.width / 60);
      ctx.beginPath();
      ctx.moveTo(current.x, current.y);
      ctx.lineTo(current.x - head * Math.cos(angle - 0.45), current.y - head * Math.sin(angle - 0.45));
      ctx.moveTo(current.x, current.y);
      ctx.lineTo(current.x - head * Math.cos(angle + 0.45), current.y - head * Math.sin(angle + 0.45));
      ctx.stroke();
    }
  });
  canvas.addEventListener("pointerup", () => { drawing = false; snapshot = null; });
  window.addEventListener("resize", syncSize);
</script></body></html>`;

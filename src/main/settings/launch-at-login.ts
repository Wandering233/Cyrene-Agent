import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface LoginItemSettingsApp {
  setLoginItemSettings(settings: { openAtLogin: boolean }): void;
  isPackaged?: boolean;
  getPath?(name: "exe" | "userData" | "home"): string;
}

export interface InstallerOptionsFileSystem {
  readFileSync(path: string, encoding: "utf8"): string;
  unlinkSync(path: string): void;
}

/** XDG autostart entry name; keep in sync with the packaged app id. */
const AUTOSTART_FILE_NAME = "cyrene.desktop";

export interface LaunchAtLoginOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Test seam: allows asserting the desktop entry without touching the host. */
  isPackaged?: boolean;
  execPath?: string;
  appImagePath?: string;
  homeDir?: string;
}

function quoteDesktopExecArgument(value: string): string {
  // Desktop Entry spec: reserve '"' and '\' inside a quoted Exec argument.
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%")}"`;
}

function buildAutostartEntry(execPath: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Cyrene",
    "Comment=Live2D desktop AI companion",
    `Exec=${quoteDesktopExecArgument(execPath)} --autostart`,
    "Terminal=false",
    "StartupNotify=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

function resolveXdgConfigHome(options: LaunchAtLoginOptions): string {
  const env = options.env ?? process.env;
  return env.XDG_CONFIG_HOME || path.join(options.homeDir ?? os.homedir(), ".config");
}

/**
 * Enable/disable launch at login.
 *
 * Windows/macOS use Electron's login item API. Linux uses the XDG autostart
 * specification, which is the only portable mechanism that works on Wayland
 * and does not depend on X11 or a desktop-specific settings daemon.
 *
 * Dev builds intentionally skip autostart: registering `electron .` would make
 * the developer's machine launch the tool at every login.
 */
export function syncLaunchAtLogin(
  enabled: boolean,
  app: LoginItemSettingsApp,
  options: LaunchAtLoginOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") {
    app.setLoginItemSettings({ openAtLogin: enabled });
    return;
  }

  const isPackaged = options.isPackaged ?? app.isPackaged ?? false;
  if (!isPackaged) {
    console.warn("[Cyrene] Linux 开机自启仅在打包版启用，开发版跳过");
    return;
  }

  const execPath = options.appImagePath
    ?? (options.env ?? process.env).APPIMAGE
    ?? options.execPath
    ?? app.getPath?.("exe");
  if (!execPath) {
    console.warn("[Cyrene] 无法确定 Linux 可执行文件路径，跳过开机自启");
    return;
  }

  const autostartDir = path.join(resolveXdgConfigHome(options), "autostart");
  const entryPath = path.join(autostartDir, AUTOSTART_FILE_NAME);

  try {
    if (enabled) {
      fs.mkdirSync(autostartDir, { recursive: true });
      fs.writeFileSync(entryPath, buildAutostartEntry(execPath), { mode: 0o644 });
      console.log("[Cyrene] 已写入 XDG autostart:", entryPath);
    } else {
      fs.rmSync(entryPath, { force: true });
      console.log("[Cyrene] 已移除 XDG autostart:", entryPath);
    }
  } catch (error) {
    // A failed autostart write must not abort startup or settings saving.
    console.error("[Cyrene] 更新 XDG autostart 失败:", error);
  }
}

/**
 * Returns the one-shot preference selected in the installer, then removes it so
 * future starts continue to respect the user's in-app setting.
 */
export function consumeInstallerLaunchAtLoginSelection(
  path: string,
  fileSystem: InstallerOptionsFileSystem,
): boolean | null {
  try {
    const parsed = JSON.parse(fileSystem.readFileSync(path, "utf8")) as { launchAtLogin?: unknown };
    fileSystem.unlinkSync(path);
    return typeof parsed.launchAtLogin === "boolean" ? parsed.launchAtLogin : null;
  } catch {
    return null;
  }
}

export function applyInstallerLaunchAtLoginSelection<T extends object>(
  settings: T,
  selection: boolean | null,
): T {
  return selection === null ? settings : { ...settings, launchAtLogin: selection };
}

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyInstallerLaunchAtLoginSelection,
  consumeInstallerLaunchAtLoginSelection,
  syncLaunchAtLogin,
} from "./launch-at-login";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-autostart-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("syncLaunchAtLogin", () => {
  it("delegates to setLoginItemSettings on Windows/macOS", () => {
    const setLoginItemSettings = vi.fn();
    syncLaunchAtLogin(true, { setLoginItemSettings }, { platform: "win32" });
    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });

    syncLaunchAtLogin(false, { setLoginItemSettings }, { platform: "darwin" });
    expect(setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: false });
  });

  it("writes an XDG autostart entry on packaged Linux", () => {
    const configHome = makeTempDir();
    syncLaunchAtLogin(true, { setLoginItemSettings: vi.fn() }, {
      platform: "linux",
      isPackaged: true,
      execPath: "/opt/Cyrene/cyrene",
      env: { XDG_CONFIG_HOME: configHome },
    });

    const entryPath = path.join(configHome, "autostart", "cyrene.desktop");
    const content = fs.readFileSync(entryPath, "utf8");
    expect(content).toContain("[Desktop Entry]");
    expect(content).toContain('Exec="/opt/Cyrene/cyrene" --autostart');
    expect(content).toContain("X-GNOME-Autostart-enabled=true");
  });

  it("prefers the AppImage path and escapes quoted arguments", () => {
    const configHome = makeTempDir();
    syncLaunchAtLogin(true, { setLoginItemSettings: vi.fn() }, {
      platform: "linux",
      isPackaged: true,
      appImagePath: "/home/me/Apps/Cyrene \"Stable\".AppImage",
      env: { XDG_CONFIG_HOME: configHome },
    });

    const content = fs.readFileSync(
      path.join(configHome, "autostart", "cyrene.desktop"),
      "utf8",
    );
    expect(content).toContain('Exec="/home/me/Apps/Cyrene \\"Stable\\".AppImage" --autostart');
  });

  it("removes the entry when disabled", () => {
    const configHome = makeTempDir();
    const app = { setLoginItemSettings: vi.fn() };
    const options = {
      platform: "linux" as const,
      isPackaged: true,
      execPath: "/opt/Cyrene/cyrene",
      env: { XDG_CONFIG_HOME: configHome },
    };
    syncLaunchAtLogin(true, app, options);
    const entryPath = path.join(configHome, "autostart", "cyrene.desktop");
    expect(fs.existsSync(entryPath)).toBe(true);

    syncLaunchAtLogin(false, app, options);
    expect(fs.existsSync(entryPath)).toBe(false);
  });

  it("skips dev builds", () => {
    const configHome = makeTempDir();
    syncLaunchAtLogin(true, { setLoginItemSettings: vi.fn() }, {
      platform: "linux",
      isPackaged: false,
      execPath: "/usr/bin/electron",
      env: { XDG_CONFIG_HOME: configHome },
    });
    expect(fs.existsSync(path.join(configHome, "autostart"))).toBe(false);
  });
});

describe("installer launch-at-login selection", () => {
  it("consumes and removes the installer selection file", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "options.json");
    fs.writeFileSync(filePath, JSON.stringify({ launchAtLogin: true }));

    expect(consumeInstallerLaunchAtLoginSelection(filePath, fs)).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("returns null for missing or malformed files", () => {
    expect(consumeInstallerLaunchAtLoginSelection("/nonexistent", fs)).toBeNull();
  });

  it("applies a selected preference", () => {
    expect(applyInstallerLaunchAtLoginSelection({ launchAtLogin: false }, true))
      .toEqual({ launchAtLogin: true });
    expect(applyInstallerLaunchAtLoginSelection({ launchAtLogin: false }, null))
      .toEqual({ launchAtLogin: false });
  });
});

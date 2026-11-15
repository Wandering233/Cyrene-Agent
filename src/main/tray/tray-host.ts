import { execFileSync } from "node:child_process";

const WATCHER = "org.kde.StatusNotifierWatcher";

/**
 * Presence of StatusNotifierWatcher means the desktop has a tray host
 * (KDE plasmashell, quickshell, waybar, GNOME AppIndicator extension, ...).
 *
 * `gdbus` is part of glib2 and present on essentially every Wayland desktop.
 * If it is missing or the call fails we keep the tray object: Electron may
 * still have another host, and disabling the tray on an inconclusive probe
 * would be worse than an invisible icon.
 */
export function detectStatusNotifierWatcher(
  run: (command: string, args: string[]) => string = defaultRun,
): boolean {
  try {
    const output = run("gdbus", [
      "call",
      "--session",
      "--dest",
      "org.freedesktop.DBus",
      "--object-path",
      "/org/freedesktop/DBus",
      "--method",
      "org.freedesktop.DBus.NameHasOwner",
      WATCHER,
    ]);
    return parseNameHasOwner(output);
  } catch {
    return true;
  }
}

export function parseNameHasOwner(output: string): boolean {
  // gdbus prints `(true,)` or `(false,)`.
  return /^\(\s*true\s*,?\s*\)$/i.test(output.trim());
}

function defaultRun(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: 1500,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

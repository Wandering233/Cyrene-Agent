import { existsSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  cwd?: string;
  commandExists?(command: string): boolean;
  portalActive?(): boolean | null;
}

export interface DoctorResult {
  ok: boolean;
  lines: string[];
}

function pathCommandExists(command: string): boolean {
  const pathValue = process.env.PATH ?? "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    try {
      const candidate = path.join(dir, command);
      if (existsSync(candidate) && statSync(candidate).isFile()) return true;
    } catch { /* ignore */ }
  }
  return false;
}

function configRoot(env: NodeJS.ProcessEnv): string {
  return env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config");
}

/**
 * Local Linux/Wayland diagnostics for `cyrene doctor`.
 *
 * Keep this module free of Electron imports: it is bundled into the CLI and
 * must run even when the desktop app cannot start.
 */
export function runDoctor(options: DoctorOptions = {}): DoctorResult {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const cwd = options.cwd ?? process.cwd();
  const commandExists = options.commandExists ?? pathCommandExists;
  const lines: string[] = [];
  let ok = true;

  lines.push(`Cyrene doctor`);
  lines.push(`  platform: ${platform} ${arch}`);
  lines.push(`  node: ${process.versions.node}  electron: ${process.versions.electron ?? "(cli)"}`);

  if (platform !== "linux") {
    lines.push(`  ✓ desktop platform is ${platform}; Linux checks skipped`);
  } else {
    const session = env.XDG_SESSION_TYPE ?? "(unset)";
    const wayland = env.WAYLAND_DISPLAY ?? "(unset)";
    const desktop = env.XDG_CURRENT_DESKTOP ?? "(unset)";
    lines.push(`  session: ${session}  WAYLAND_DISPLAY: ${wayland}`);
    lines.push(`  desktop: ${desktop}`);
    if (session !== "wayland" && !env.WAYLAND_DISPLAY) {
      ok = false;
      lines.push(`  ✗ no Wayland session detected; the overlay host requires Wayland`);
    } else {
      lines.push(`  ✓ Wayland session detected`);
    }
    if (env.HYPRLAND_INSTANCE_SIGNATURE) lines.push(`  ✓ Hyprland detected; screenshot hotkey uses hyprctl`);
    if (env.APPIMAGE) lines.push(`  ✓ AppImage runtime: ${env.APPIMAGE}`);
    else lines.push(`  ⚠ APPIMAGE unset; in-app update disabled for packaged installs`);
  }

  const binaries: Array<[string, string, boolean, boolean]> = [
    ["bwrap", "bubblewrap sandbox", true, false],
    ["socat", "sandbox network bridge", true, false],
    ["rg", "ripgrep sandbox helper", false, false],
    ["grim", "Hyprland/wlroots screenshot", false, false],
    ["slurp", "region selection", false, false],
    ["hyprctl", "Hyprland hotkeys", false, false],
    ["gdbus", "portal/DBus diagnostics", false, false],
  ];
  for (const [command, label, required, _unused] of binaries) {
    const present = commandExists(command);
    lines.push(`  ${present ? "✓" : required ? "✗" : "⚠"} ${command}: ${label}`);
    if (!present && required) ok = false;
  }

  const binaryCandidates = [
    path.join(cwd, "resources", "bin", "linux", "cyrene-overlay-host"),
    path.join(cwd, "resources", "bin", "linux", "cyrene-overlay-fullscreen"),
    path.join(cwd, "native", "cyrene-overlay-host", "target", "release", "cyrene-overlay-host"),
    path.join(cwd, "native", "cyrene-overlay-host", "target", "release", "cyrene-overlay-fullscreen"),
  ];
  const hasHost = binaryCandidates.some((candidate) => existsSync(candidate));
  lines.push(`  ${hasHost ? "✓" : "✗"} overlay host binaries found`);
  if (!hasHost) ok = false;

  try {
    const value = existsSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
      ? readFileSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8").trim()
      : "0";
    lines.push(value === "1"
      ? "  ⚠ AppArmor restricts unprivileged user namespaces; bwrap may fail"
      : "  ✓ AppArmor unprivileged userns restriction absent");
  } catch {
    lines.push("  ⚠ could not read AppArmor userns restriction");
  }

  const screenshots = path.join(configRoot(env), "Cyrene", "screenshots");
  lines.push(`  ${existsSync(screenshots) ? "✓" : "⚠"} screenshots dir: ${screenshots}`);
  if (options.portalActive) {
    const portal = options.portalActive();
    lines.push(`  ${portal === false ? "⚠" : "✓"} xdg-desktop-portal: ${portal === null ? "unknown" : portal ? "available" : "not detected"}`);
  }
  lines.push(`  tip: run with \`CYRENE_OVERLAY_BACKEND=fullscreen\` for GNOME-compatible overlay`);
  return { ok, lines };
}

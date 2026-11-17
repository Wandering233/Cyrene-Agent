import { app } from "electron";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { normalizeScreenshotShortcut } from "../../shared/screenshot-shortcut";
import { resolveControlSocketPath } from "../../shared/control-socket";

export interface HyprlandHotkeyBinding {
  bind: string;
  uninstall(): void;
}

/** Convert an Electron accelerator to Hyprland's bind syntax. */
export function toHyprlandBind(accelerator: string): string | null {
  const normalized = normalizeScreenshotShortcut(accelerator);
  if (!normalized) return null;
  const parts = normalized.split("+");
  const key = parts.pop()!;
  return [...parts.map((part) => part === "Control" ? "CTRL" : part === "Super" ? "SUPER" : part.toUpperCase()),
    key === "PrintScreen" ? "Print" : key].join(" + ");
}

/**
 * Hyprland fallback for global screenshot hotkeys.
 *
 * Electron's globalShortcut is backed by the GlobalShortcuts portal, which
 * needs an installed desktop app id. On Hyprland we can bind the accelerator
 * directly and execute a tiny script that posts `screenshot` to our control
 * socket, so the hotkey works even in dev/unpackaged builds.
 */
export function installHyprlandScreenshotHotkey(
  accelerator: string,
  options: { env?: NodeJS.ProcessEnv; run?: (command: string, args: string[]) => void } = {},
): HyprlandHotkeyBinding | null {
  const env = options.env ?? process.env;
  if (!env.HYPRLAND_INSTANCE_SIGNATURE) return null;
  if (env.CYRENE_HYPRLAND_HOTKEY === "0") return null;
  const binding = toHyprlandBind(accelerator);
  if (!binding) return null;

  const scriptPath = path.join(app.getPath("userData"), "screenshot-hotkey.sh");
  const socketPath = resolveControlSocketPath(env);
  const script = `#!/bin/sh
python3 - "$1" <<'PY'
import socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(5)
s.connect(sys.argv[1])
s.sendall(b"screenshot\\n")
print(s.recv(4096).decode("utf-8", "replace"), end="")
PY
`;
  try {
    writeFileSync(scriptPath, script, { mode: 0o700 });
    const run = options.run ?? ((command, args) => {
      execFileSync(command, args, { stdio: "ignore", timeout: 3000 });
    });
    const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    const command = `${shellQuote(scriptPath)} ${shellQuote(socketPath)}`;
    const luaCommand = `hl.bind(${JSON.stringify(binding)}, hl.dsp.exec_cmd(${JSON.stringify(command)}))`;
    run("hyprctl", ["eval", luaCommand]);
    return {
      bind: binding,
      uninstall() {
        try {
          run("hyprctl", ["eval", `hl.unbind("${binding.replace(/"/g, '\\"')}")`]);
        } catch { /* hyprctl may be gone on logout */ }
      },
    };
  } catch (error) {
    console.warn("[Screenshot] failed to register Hyprland hotkey:", error);
    return null;
  }
}

/** Inspect compositor bindings before modifying them; an occupied bind is never overwritten. */
export function hasHyprlandShortcutConflict(
  accelerator: string, ownBinding?: string,
  run: (command: string, args: string[]) => string = (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 3000 }),
): boolean {
  const binding = toHyprlandBind(accelerator);
  if (!binding) return true;
  const parts = binding.split(" + ");
  const key = parts.pop()!.toLowerCase();
  const mask = parts.reduce((value, part) => value | ({ SHIFT: 1, CTRL: 4, ALT: 8, SUPER: 64 }[part] ?? 0), 0);
  const binds: Array<{ key?: string; modmask?: number }> = JSON.parse(run("hyprctl", ["-j", "binds"]));
  const matches = binds.filter((item) => item.key?.toLowerCase() === key && item.modmask === mask);
  return matches.length > (binding === ownBinding ? 1 : 0);
}

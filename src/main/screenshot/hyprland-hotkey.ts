import { app } from "electron";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { resolveControlSocketPath } from "../../shared/control-socket";

export interface HyprlandHotkeyBinding {
  bind: string;
  uninstall(): void;
}

/** Convert an Electron accelerator to Hyprland's bind syntax. */
export function toHyprlandBind(accelerator: string): string | null {
  const parts = accelerator.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const mods: string[] = [];
  let key: string | null = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (["alt", "option"].includes(lower)) mods.push("ALT");
    else if (["shift"].includes(lower)) mods.push("SHIFT");
    else if (["control", "ctrl", "commandorcontrol", "cmdorctrl"].includes(lower)) mods.push("CTRL");
    else if (["super", "meta", "command", "cmd"].includes(lower)) mods.push("SUPER");
    else key = part.length === 1 ? part.toUpperCase() : part;
  }
  if (!key || mods.length === 0) return null;
  return `${mods.join(" + ")} + ${key}`;
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
    const luaCommand = `hl.bind("${binding.replace(/"/g, '\\"')}", hl.dsp.exec_cmd("${scriptPath} ${socketPath}"))`;
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

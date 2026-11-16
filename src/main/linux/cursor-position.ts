import { execFileSync } from "node:child_process";

export interface CursorPoint { x: number; y: number }

type Runner = (command: string, args: string[], options: { encoding: "utf8"; timeout: number }) => string;

let lastRead = 0;
let lastPoint: CursorPoint | null = null;

/**
 * Native Wayland Electron reports (0,0) for `screen.getCursorScreenPoint()`.
 * On Hyprland we can read the compositor cursor directly; cache briefly so
 * toast placement / fallback display selection does not spawn hyprctl per
 * frame. Other compositors keep Electron's value.
 */
export function readLinuxCursorPosition(
  env: NodeJS.ProcessEnv = process.env,
  run: Runner = (command, args, options) => execFileSync(command, args, options).toString(),
  now: number = Date.now(),
): CursorPoint | null {
  if (!env.HYPRLAND_INSTANCE_SIGNATURE) return null;
  if (lastPoint && now >= lastRead && now - lastRead < 100) return lastPoint;
  try {
    const output = run("hyprctl", ["-j", "cursorpos"], { encoding: "utf8", timeout: 500 });
    const parsed = JSON.parse(output) as { x?: unknown; y?: unknown };
    if (typeof parsed.x === "number" && typeof parsed.y === "number") {
      lastPoint = { x: parsed.x, y: parsed.y };
      lastRead = now;
      return lastPoint;
    }
  } catch {
    // hyprctl missing or compositor restarting: use Electron's value.
  }
  return null;
}

export function withLinuxCursorFallback(
  fallback: () => CursorPoint,
  env: NodeJS.ProcessEnv = process.env,
): CursorPoint {
  return readLinuxCursorPosition(env) ?? fallback();
}

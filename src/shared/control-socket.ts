import * as os from "node:os";
import * as path from "node:path";

export const CONTROL_COMMANDS = [
  "show-chat",
  "show-settings",
  "toggle-pet",
  "quit",
  "ping",
] as const;

export type ControlCommand = typeof CONTROL_COMMANDS[number];

export function resolveControlSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(base, "cyrene-control.sock");
}

export function isControlCommand(value: string): value is ControlCommand {
  return (CONTROL_COMMANDS as readonly string[]).includes(value);
}

/**
 * True when the process was started by the XDG autostart entry.
 *
 * Autostart must not pop the chat window in the user's face; the pet (and the
 * tray, when available) is enough. The user can still open chat from either.
 */
export function isAutostartLaunch(argv: readonly string[] = process.argv): boolean {
  return argv.includes("--autostart");
}

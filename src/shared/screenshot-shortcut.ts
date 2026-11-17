export type ScreenshotShortcutError = "invalid" | "conflict" | "denied" | "unavailable";
export interface ScreenshotShortcutStatus {
  phase: "disabled" | "registering" | "active" | "error";
  accelerator: string;
  backend?: "hyprland" | "portal" | "electron";
  error?: ScreenshotShortcutError;
}
export type ScreenshotShortcutResult = { ok: true; status: ScreenshotShortcutStatus }
  | { ok: false; error: ScreenshotShortcutError; status: ScreenshotShortcutStatus };

const modifierAliases: Record<string, string> = {
  alt: "Alt", option: "Alt", shift: "Shift", control: "Control", ctrl: "Control",
  commandorcontrol: "Control", cmdorctrl: "Control", super: "Super", meta: "Super", command: "Super", cmd: "Super",
};
const keys: Record<string, string> = {
  print: "PrintScreen", printscreen: "PrintScreen", space: "Space", tab: "Tab",
  enter: "Enter", return: "Enter", backspace: "Backspace", delete: "Delete", insert: "Insert",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  up: "Up", down: "Down", left: "Left", right: "Right",
};
export function normalizeScreenshotShortcut(value: string): string | null {
  if (value.length > 80) return null;
  const parts = value.split("+").map((part) => part.trim());
  const modifiers = new Set<string>();
  let key: string | undefined;
  for (const part of parts) {
    const modifier = modifierAliases[part.toLowerCase()];
    if (modifier) {
      if (modifiers.has(modifier) || key) return null;
      modifiers.add(modifier);
    } else {
      if (key) return null;
      key = /^[a-z0-9]$/i.test(part) ? part.toUpperCase()
        : /^F(?:[1-9]|1\d|2[0-4])$/i.test(part) ? part.toUpperCase() : keys[part.toLowerCase()];
      if (!key) return null;
    }
  }
  if (!key || !modifiers.size) return null;
  return [...["Control", "Alt", "Shift", "Super"].filter((mod) => modifiers.has(mod)), key].join("+");
}

export function shortcutFromKeyboardEvent(event: { key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; repeat: boolean; getModifierState(key: string): boolean }): string | null {
  if (event.repeat || event.getModifierState("AltGraph")) return null;
  const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3)
    : /^Digit\d$/.test(event.code) ? event.code.slice(5)
    : event.key === " " ? "Space" : event.key.replace(/^Arrow/, "");
  return normalizeScreenshotShortcut([
    event.ctrlKey && "Control", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Super", key,
  ].filter(Boolean).join("+"));
}

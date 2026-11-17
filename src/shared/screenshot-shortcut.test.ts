import { describe, expect, it } from "vitest";
import { normalizeScreenshotShortcut, shortcutFromKeyboardEvent } from "./screenshot-shortcut";
describe("截图按键规范化", () => {
  it("统一别名和修饰键顺序", () => {
    expect(normalizeScreenshotShortcut("shift+ctrl+s")).toBe("Control+Shift+S");
    expect(normalizeScreenshotShortcut("Super+Print")).toBe("Super+PrintScreen");
  });
  it.each(["S", "Alt", "Alt+S+X", "Alt+Alt+S", "Alt++S", "Alt+\"", "Control+NoKey", "x".repeat(81)])("拒绝无效或注入按键 %s", value => {
    expect(normalizeScreenshotShortcut(value)).toBeNull();
  });
  it("录制物理按键，忽略重复和 AltGraph", () => {
    const event = { key: "!", code: "Digit1", ctrlKey: true, altKey: false, shiftKey: true,
      metaKey: false, repeat: false, getModifierState: () => false };
    expect(shortcutFromKeyboardEvent(event)).toBe("Control+Shift+1");
    expect(shortcutFromKeyboardEvent({ ...event, repeat: true })).toBeNull();
    expect(shortcutFromKeyboardEvent({ ...event, getModifierState: () => true })).toBeNull();
  });
});

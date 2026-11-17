import { describe, expect, it } from "vitest";
import { installHyprlandScreenshotHotkey, toHyprlandBind } from "./hyprland-hotkey";

describe("toHyprlandBind", () => {
  it("maps Electron accelerators", () => {
    expect(toHyprlandBind("Alt+Shift+S")).toBe("ALT + SHIFT + S");
    expect(toHyprlandBind("Control+Shift+F12")).toBe("CTRL + SHIFT + F12");
    expect(toHyprlandBind("Super+Print")).toBe("SUPER + Print");
  });

  it("rejects bindings without a modifier or key", () => {
    expect(toHyprlandBind("S")).toBeNull();
    expect(toHyprlandBind("Alt")).toBeNull();
    expect(toHyprlandBind("Alt+")).toBeNull();
  });
});


describe("installHyprlandScreenshotHotkey", () => {
  it("can be disabled while keeping HYPRLAND_INSTANCE_SIGNATURE for grim", () => {
    expect(installHyprlandScreenshotHotkey("Alt+Shift+S", {
      env: { HYPRLAND_INSTANCE_SIGNATURE: "test", CYRENE_HYPRLAND_HOTKEY: "0" },
    })).toBeNull();
  });
});

describe("Hyprland 组合键占用", () => {
  it("匹配大小写/修饰键，允许唯一自身绑定，重复仍判冲突", async () => {
    const { hasHyprlandShortcutConflict } = await import("./hyprland-hotkey");
    const run = () => JSON.stringify([{ key: "s", modmask: 9 }]);
    expect(hasHyprlandShortcutConflict("Alt+Shift+S", undefined, run)).toBe(true);
    expect(hasHyprlandShortcutConflict("Alt+Shift+S", "ALT + SHIFT + S", run)).toBe(false);
    expect(hasHyprlandShortcutConflict("Control+Shift+S", undefined, run)).toBe(false);
    expect(hasHyprlandShortcutConflict("Alt+Shift+S", "ALT + SHIFT + S", () => JSON.stringify([
      { key: "S", modmask: 9 }, { key: "s", modmask: 9 },
    ]))).toBe(true);
  });
});

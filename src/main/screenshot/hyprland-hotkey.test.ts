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

import { describe, expect, it } from "vitest";
import { toHyprlandBind } from "./hyprland-hotkey";

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

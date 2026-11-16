import { describe, expect, it } from "vitest";
import { toPortalTrigger } from "./global-shortcuts";

describe("toPortalTrigger", () => {
  it("maps Electron accelerators to portal triggers", () => {
    expect(toPortalTrigger("Alt+Shift+S")).toBe("ALT+SHIFT+S");
    expect(toPortalTrigger("Control+Shift+F12")).toBe("CTRL+SHIFT+F12");
    expect(toPortalTrigger("Super+Print")).toBe("LOGO+Print");
  });

  it("rejects unusable accelerators", () => {
    expect(toPortalTrigger("S")).toBeNull();
    expect(toPortalTrigger("Alt+")).toBeNull();
  });
});

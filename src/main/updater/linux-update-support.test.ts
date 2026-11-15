import { describe, expect, it } from "vitest";
import { isLinuxAppImageUpdateSupported } from "./linux-update-support";

describe("isLinuxAppImageUpdateSupported", () => {
  it("allows Windows/macOS", () => {
    expect(isLinuxAppImageUpdateSupported({ platform: "win32", isPackaged: true, env: {} })).toBe(true);
    expect(isLinuxAppImageUpdateSupported({ platform: "darwin", isPackaged: true, env: {} })).toBe(true);
  });

  it("requires APPIMAGE for packaged Linux", () => {
    expect(isLinuxAppImageUpdateSupported({ platform: "linux", isPackaged: true, env: {} })).toBe(false);
    expect(isLinuxAppImageUpdateSupported({
      platform: "linux",
      isPackaged: true,
      env: { APPIMAGE: "/home/me/Cyrene.AppImage" },
    })).toBe(true);
  });

  it("allows dev builds (no update feed is used)", () => {
    expect(isLinuxAppImageUpdateSupported({ platform: "linux", isPackaged: false, env: {} })).toBe(true);
  });
});

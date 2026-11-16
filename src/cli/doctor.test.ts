import { describe, expect, it } from "vitest";
import { runDoctor } from "./doctor";

describe("runDoctor", () => {
  it("reports a healthy Wayland environment", () => {
    const result = runDoctor({
      platform: "linux",
      env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-1", XDG_CURRENT_DESKTOP: "Hyprland", HOME: "/home/test" },
      cwd: "/repo",
      commandExists: (command) => command !== "socat",
      portalActive: () => true,
    });
    expect(result.lines.join("\n")).toContain("Wayland session detected");
    expect(result.lines.join("\n")).toContain("socat");
    expect(result.ok).toBe(false);
  });

  it("fails when no host binary exists", () => {
    const result = runDoctor({
      platform: "linux",
      env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-1", HOME: "/home/test" },
      cwd: "/nonexistent",
      commandExists: () => true,
      portalActive: () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("overlay host binaries found");
  });
});

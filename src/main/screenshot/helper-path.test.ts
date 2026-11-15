import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveScreenshotHelperPath, screenshotHelperBinaryName } from "./helper-path";

const binaryName = screenshotHelperBinaryName();

describe("resolveScreenshotHelperPath", () => {
  it("uses the development Rust release binary", () => {
    expect(resolveScreenshotHelperPath({
      isPackaged: false,
      appPath: "repo",
      resourcesPath: "app/resources",
      envOverride: undefined,
    })).toBe(path.join("repo", "native", "cyrene-screenshot", "target", "release", binaryName));
  });

  it("uses the packaged resources binary", () => {
    expect(resolveScreenshotHelperPath({
      isPackaged: true,
      appPath: "app/resources/app.asar",
      resourcesPath: "app/resources",
      envOverride: undefined,
    })).toBe(path.join("app/resources", "bin", binaryName));
  });

  it("allows an explicit helper path override", () => {
    const override = path.join("debug", binaryName);
    expect(resolveScreenshotHelperPath({
      isPackaged: true,
      appPath: "app/resources/app.asar",
      resourcesPath: "app/resources",
      envOverride: override,
    })).toBe(override);
  });

  it("uses the platform-specific helper name for non-Windows targets", () => {
    expect(screenshotHelperBinaryName("linux")).toBe("cyrene-screenshot");
    expect(screenshotHelperBinaryName("darwin")).toBe("cyrene-screenshot");
    expect(screenshotHelperBinaryName("win32")).toBe("cyrene-screenshot.exe");
  });
});

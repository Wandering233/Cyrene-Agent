import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinuxScreenshotError, captureLinuxScreenshot } from "./linux-screenshot";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-linux-shot-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("captureLinuxScreenshot (Hyprland backend)", () => {
  it("runs grim for a full-screen capture", async () => {
    const outputDirectory = makeTempDir();
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "grim" && args[0] === "--version") return { stdout: "grim 1.4", stderr: "" };
      if (command === "grim" && args[0] !== "--version") {
        fs.writeFileSync(args[0], "png");
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected ${command}`);
    });

    const filePath = await captureLinuxScreenshot({
      interactive: false,
      outputDirectory,
      env: { HYPRLAND_INSTANCE_SIGNATURE: "test" },
      run,
    });

    expect(fs.existsSync(filePath)).toBe(true);
    expect(run).toHaveBeenCalledWith("grim", [filePath]);
  });

  it("uses slurp geometry for a region capture", async () => {
    const outputDirectory = makeTempDir();
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "grim" && args[0] === "--version") return { stdout: "grim", stderr: "" };
      if (command === "slurp") return { stdout: "10,20 100x50\n", stderr: "" };
      if (command === "grim") {
        fs.writeFileSync(args[2], "png");
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected ${command}`);
    });

    const filePath = await captureLinuxScreenshot({
      interactive: true,
      outputDirectory,
      env: { HYPRLAND_INSTANCE_SIGNATURE: "test" },
      run,
    });

    expect(run).toHaveBeenCalledWith("grim", ["-g", "10,20 100x50", filePath]);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("maps slurp failure to a cancellation", async () => {
    const outputDirectory = makeTempDir();
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "grim") return { stdout: "grim", stderr: "" };
      if (command === "slurp" && args[0] === "--version") return { stdout: "slurp", stderr: "" };
      if (command === "slurp") throw new Error("cancelled");
      throw new Error("unexpected");
    });

    await expect(captureLinuxScreenshot({
      interactive: true,
      outputDirectory,
      env: { HYPRLAND_INSTANCE_SIGNATURE: "test" },
      run,
    })).rejects.toMatchObject<Partial<LinuxScreenshotError>>({ code: "SCREENSHOT_CANCELLED" });
  });
});

describe("screenshot retention", () => {
  it("writes captured files with 0600", async () => {
    const outputDirectory = makeTempDir();
    const run = vi.fn(async (command: string, args: string[]) => {
      if (args[0] === "--version" || args[0] === "-h") return { stdout: "", stderr: "" };
      fs.writeFileSync(args[0], "png");
      return { stdout: "", stderr: "" };
    });
    const filePath = await captureLinuxScreenshot({
      interactive: false,
      outputDirectory,
      env: { HYPRLAND_INSTANCE_SIGNATURE: "test" },
      run,
    });
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("prunes old files and keeps the newest maxFiles", async () => {
    const { pruneScreenshotDirectory } = await import("./linux-screenshot");
    const outputDirectory = makeTempDir();
    const oldPath = path.join(outputDirectory, "old.png");
    const keepPath = path.join(outputDirectory, "keep.png");
    fs.writeFileSync(oldPath, "old");
    fs.writeFileSync(keepPath, "keep");
    const now = Date.now();
    fs.utimesSync(oldPath, new Date(now - 10 * 24 * 60 * 60 * 1000), new Date(now - 10 * 24 * 60 * 60 * 1000));

    await pruneScreenshotDirectory(outputDirectory, { now, maxAgeMs: 24 * 60 * 60 * 1000, maxFiles: 10 });

    expect(fs.existsSync(oldPath)).toBe(false);
    expect(fs.existsSync(keepPath)).toBe(true);
  });
});

describe("window capture", () => {
  it("uses the active Hyprland window geometry", async () => {
    const outputDirectory = makeTempDir();
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "grim" && (args[0] === "--version" || args[0] === "-h")) return { stdout: "", stderr: "" };
      if (command === "hyprctl") return { stdout: JSON.stringify({ at: [100, 200], size: [800, 600], title: "Zen" }), stderr: "" };
      if (command === "grim") { fs.writeFileSync(args[2], "png"); return { stdout: "", stderr: "" }; }
      throw new Error(`unexpected ${command}`);
    });
    const filePath = await captureLinuxScreenshot({
      interactive: false,
      target: "window",
      outputDirectory,
      env: { HYPRLAND_INSTANCE_SIGNATURE: "test" },
      run,
    });
    expect(run).toHaveBeenCalledWith("grim", ["-g", "100,200 800x600", filePath]);
    expect(fs.existsSync(filePath)).toBe(true);
  });
});

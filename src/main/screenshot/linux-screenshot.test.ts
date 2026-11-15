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

import { execFile } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { captureScreenshotViaPortal } from "./portal-screenshot";

const execFileAsync = promisify(execFile);

export class LinuxScreenshotError extends Error {
  constructor(
    readonly code:
      | "SCREENSHOT_CANCELLED"
      | "SCREENSHOT_BACKEND_UNAVAILABLE"
      | "SCREENSHOT_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "LinuxScreenshotError";
  }
}

export interface LinuxScreenshotOptions {
  interactive: boolean;
  outputDirectory: string;
  /** Test seams. */
  env?: NodeJS.ProcessEnv;
  run?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * Linux/Wayland screenshot backend.
 *
 * Hyprland/wlroots expose grim+slurp, which gives the app a native selection
 * UI without a portal round trip. Other desktops fall back to the
 * xdg-desktop-portal Screenshot API.
 */
export async function captureLinuxScreenshot(
  options: LinuxScreenshotOptions,
): Promise<string> {
  const env = options.env ?? process.env;
  const run = options.run ?? defaultRun;
  await mkdir(options.outputDirectory, { recursive: true });
  const filePath = path.join(options.outputDirectory, `${randomUUID()}.png`);

  if (env.HYPRLAND_INSTANCE_SIGNATURE && await commandExists("grim", run)) {
    if (options.interactive) {
      if (!await commandExists("slurp", run)) {
        throw new LinuxScreenshotError(
          "SCREENSHOT_BACKEND_UNAVAILABLE",
          "slurp is required for region screenshots on Hyprland",
        );
      }
      let geometry: string;
      try {
        const result = await run("slurp", []);
        geometry = result.stdout.trim();
      } catch (error) {
        throw new LinuxScreenshotError(
          "SCREENSHOT_CANCELLED",
          `region selection cancelled: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!geometry) {
        throw new LinuxScreenshotError("SCREENSHOT_CANCELLED", "region selection cancelled");
      }
      try {
        await run("grim", ["-g", geometry, filePath]);
      } catch (error) {
        throw new LinuxScreenshotError(
          "SCREENSHOT_FAILED",
          `grim failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      try {
        await run("grim", [filePath]);
      } catch (error) {
        throw new LinuxScreenshotError(
          "SCREENSHOT_FAILED",
          `grim failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return filePath;
  }

  // Cross-desktop fallback. Portal implementations may write the image to
  // ~/Pictures; copy it into app storage so the chat pipeline can validate it.
  try {
    const result = await captureScreenshotViaPortal({ interactive: options.interactive });
    await copyFile(result.filePath, filePath);
    return filePath;
  } catch (error) {
    throw new LinuxScreenshotError(
      "SCREENSHOT_FAILED",
      `portal screenshot failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function commandExists(
  command: string,
  run: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>,
): Promise<boolean> {
  try {
    await run(command, ["--version"]);
    return true;
  } catch {
    try {
      await run(command, ["-h"]);
      return true;
    } catch {
      return false;
    }
  }
}

async function defaultRun(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, {
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

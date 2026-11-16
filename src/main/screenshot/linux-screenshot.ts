import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { randomUUID } from "node:crypto";
import { captureScreenshotViaPortal } from "./portal-screenshot";

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
    await chmod(filePath, 0o600);
    return filePath;
  }

  // Cross-desktop fallback. Portal implementations may write the image to
  // ~/Pictures; copy it into app storage so the chat pipeline can validate it.
  try {
    const result = await captureScreenshotViaPortal({ interactive: options.interactive });
    await copyFile(result.filePath, filePath);
    // The portal may have written its own file (often in ~/Pictures). We own
    // only the copy in app storage; remove the intermediate file.
    await rm(result.filePath, { force: true }).catch(() => {});
    await chmod(filePath, 0o600);
    return filePath;
  } catch (error) {
    throw new LinuxScreenshotError(
      "SCREENSHOT_FAILED",
      `portal screenshot failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * `execFile` gives the child a stdin pipe. `slurp` blocks waiting for input
 * when stdin is a pipe (confirmed on Hyprland); spawned with stdin ignored it
 * reads the Wayland pointer normally.
 */
function defaultRun(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out`));
    }, 120_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited code=${code} signal=${signal}`));
    });
  });
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


/**
 * Keep app-owned screenshots bounded and private.
 *
 * Called at startup; failures are ignored so a stale directory can never
 * prevent the app from starting.
 */
export async function pruneScreenshotDirectory(
  outputDirectory: string,
  options: { maxAgeMs?: number; maxFiles?: number; now?: number } = {},
): Promise<void> {
  const maxAgeMs = options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  const maxFiles = options.maxFiles ?? 100;
  const now = options.now ?? Date.now();
  try {
    const names = (await readdir(outputDirectory)).filter((name) => name.endsWith(".png"));
    const entries = await Promise.all(names.map(async (name) => {
      const filePath = path.join(outputDirectory, name);
      try {
        const info = await stat(filePath);
        return { filePath, mtimeMs: info.mtimeMs };
      } catch {
        return null;
      }
    }));
    const live = entries.filter((entry): entry is { filePath: string; mtimeMs: number } => entry !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const [index, entry] of live.entries()) {
      if (index >= maxFiles || now - entry.mtimeMs > maxAgeMs) {
        await rm(entry.filePath, { force: true }).catch(() => {});
      }
    }
  } catch {
    // Missing directory or permission issue: nothing to prune.
  }
}

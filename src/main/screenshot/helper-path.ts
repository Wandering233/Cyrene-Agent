import * as path from "node:path";

export interface ScreenshotHelperPathEnvironment {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
  envOverride: string | undefined;
}

/** 当前平台的原生截图助手文件名。非 Windows 平台预留同名无扩展名二进制。 */
export function screenshotHelperBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "cyrene-screenshot.exe" : "cyrene-screenshot";
}

export function resolveScreenshotHelperPath(
  environment: ScreenshotHelperPathEnvironment,
  platform: NodeJS.Platform = process.platform,
): string {
  if (environment.envOverride?.trim()) return environment.envOverride;
  const binaryName = screenshotHelperBinaryName(platform);
  if (environment.isPackaged) {
    return path.join(environment.resourcesPath, "bin", binaryName);
  }
  return path.join(environment.appPath, "native", "cyrene-screenshot", "target", "release", binaryName);
}

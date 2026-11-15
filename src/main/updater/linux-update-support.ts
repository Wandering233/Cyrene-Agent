export interface LinuxUpdateSupportInput {
  platform?: NodeJS.Platform;
  isPackaged: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * electron-updater can only replace a Linux install in place when the app runs
 * from an AppImage and `APPIMAGE` points at the file. Deb/rpm/tar.gz installs
 * must be updated by the package manager/installer instead.
 */
export function isLinuxAppImageUpdateSupported(
  input: LinuxUpdateSupportInput,
): boolean {
  const platform = input.platform ?? process.platform;
  if (platform !== "linux") return true;
  if (!input.isPackaged) return true;
  const env = input.env ?? process.env;
  return Boolean(env.APPIMAGE);
}

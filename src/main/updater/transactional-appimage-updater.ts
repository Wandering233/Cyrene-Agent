import { app } from "electron";
import { AppImageUpdater, autoUpdater } from "electron-updater";
import type { DownloadUpdateOptions } from "electron-updater/out/AppUpdater";
import path from "node:path";
import { AppImageTransaction, confirmAppImageHealth } from "./appimage-transaction";
import { OVERLAY_HOST_VERSION } from "../pet-overlay/protocol";

function transaction(target: string) {
  return new AppImageTransaction({ target, currentVersion: app.getVersion(), hostVersion: OVERLAY_HOST_VERSION,
    workerScript: path.join(process.resourcesPath, "bin/appimage-worker.py"),
    restartArgs: process.argv.includes("--autostart") ? ["--autostart"] : [] });
}

export class TransactionalAppImageUpdater extends AppImageUpdater {
  constructor(options?: ConstructorParameters<typeof AppImageUpdater>[0], adapter?: ConstructorParameters<typeof AppImageUpdater>[1],
    private readonly createTransaction: (target: string) => AppImageTransaction = transaction) { super(options, adapter); }
  private candidate: { file: string; sha512: string; version: string } | null = null;
  private transaction: AppImageTransaction | null = null;
  protected async doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
    await this.transaction?.cancel(); this.transaction = null; this.candidate = null;
    const files = await super.doDownloadUpdate(options);
    const file = this.installerPath;
    const sha512 = this.downloadedUpdateHelper?.downloadedFileInfo?.sha512;
    if (!file || !sha512) throw new Error("APPIMAGE_UPDATE_METADATA_MISSING");
    this.candidate = { file, sha512, version: options.updateInfoAndProvider.info.version };
    return files;
  }
  async prepareInstall(): Promise<void> {
    if (this.transaction?.canInstall()) return;
    if (!this.candidate || !process.env.APPIMAGE) throw new Error("APPIMAGE_UPDATE_NOT_DOWNLOADED");
    const prepared = this.createTransaction(process.env.APPIMAGE);
    try {
      await prepared.prepare(this.candidate.file, this.candidate.sha512, this.candidate.version);
      await prepared.arm();
      this.transaction = prepared;
    } catch (error) { await prepared.cancel(); throw error; }
  }
  protected doInstall(): boolean {
    if (!this.transaction?.canInstall()) throw new Error("APPIMAGE_UPDATE_NOT_PREPARED");
    return true;
  }
  installPreparedUpdate(): boolean {
    const installed = this.install(true, true);
    if (!installed) this.quitAndInstallCalled = false;
    if (installed) setImmediate(() => this.app.quit());
    else if (this.transaction) {
      // Controlled shutdown has already closed databases. Restart the intact
      // current AppImage rather than leave a disposed application running.
      void this.transaction.relaunchCurrent().catch((error) => this._logger.error(error))
        .finally(() => this.app.quit());
    }
    return installed;
  }
  quitAndInstall(): void { this.installPreparedUpdate(); }
}

let updater: typeof autoUpdater | null = null;
export function getAppUpdater(): typeof autoUpdater {
  if (!updater) updater = process.platform === "linux" && app.isPackaged && process.env.APPIMAGE
    ? new TransactionalAppImageUpdater() : autoUpdater;
  return updater;
}

export async function recoverAppImageBeforeStartup(): Promise<boolean> {
  if (process.platform !== "linux" || !app.isPackaged || !process.env.APPIMAGE) return false;
  return transaction(process.env.APPIMAGE).recoverInterrupted();
}

export async function confirmCurrentAppImageHealth(): Promise<void> {
  if (process.platform !== "linux" || !app.isPackaged || !process.env.APPIMAGE) return;
  await confirmAppImageHealth({ target: process.env.APPIMAGE, currentVersion: app.getVersion(), resourcesPath: process.resourcesPath,
    hostVersion: OVERLAY_HOST_VERSION, token: process.env.CYRENE_UPDATE_TOKEN });
}

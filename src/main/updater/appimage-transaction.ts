import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants, copyFile, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
type Phase = "prepared" | "armed" | "installed" | "healthy" | "rolled_back" | "failed";
export interface AppImageJournal {
  schema: 1; token: string; target: string; stage: string; backup: string; phase: Phase;
  oldVersion: string; newVersion: string; oldSha512: string; newSha512: string;
  hostVersion: string; verifiedHostVersion?: string; healthTimeoutMs: number; restartArgs: string[];
}

export function appImageUpdateDirectory(target: string): string {
  if (!path.isAbsolute(target) || target.includes("\0")) throw new Error("APPIMAGE_UPDATE_INVALID_PATH");
  return path.join(path.dirname(target), `.${path.basename(target)}.cyrene-update`);
}

async function ownedFile(file: string, allowRoot = false): Promise<void> {
  const info = await lstat(file);
  if (!info.isFile() || (info.uid !== process.getuid?.() && !(allowRoot && info.uid === 0))) throw new Error("APPIMAGE_UPDATE_UNSAFE_FILE");
}

export async function hashFile(file: string, algorithm = "sha512"): Promise<string> {
  const hash = createHash(algorithm);
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

export async function processStart(pid: number): Promise<string | null> {
  try {
    const fields = (await readFile(`/proc/${pid}/stat`, "utf8")).split(")").at(-1)!.trim().split(/\s+/);
    return fields[0] === "Z" ? null : fields[19] ?? null;
  }
  catch { return null; }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file); await syncDirectory(path.dirname(file));
}

async function copyWorker(source: string, directory: string): Promise<void> {
  const temporary = path.join(directory, `worker-${randomBytes(16).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(await readFile(source)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path.join(directory, "worker.py"));
  await syncDirectory(directory);
}

export async function readAppImageJournal(target: string): Promise<AppImageJournal | null> {
  const directory = appImageUpdateDirectory(target);
  const file = path.join(directory, "state.json");
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error("APPIMAGE_UPDATE_UNSAFE_DIRECTORY");
    await ownedFile(file);
    const state = JSON.parse(await readFile(file, "utf8")) as AppImageJournal;
    if (state.schema !== 1 || state.target !== target || !/^[a-f0-9]{64}$/.test(state.token)
      || !/^[a-f0-9]{128}$/.test(state.oldSha512) || !/^[a-f0-9]{128}$/.test(state.newSha512)
      || state.stage !== path.join(directory, `stage-${state.token}.AppImage`)
      || state.backup !== path.join(directory, `backup-${state.token}.AppImage`)) throw new Error("APPIMAGE_UPDATE_INVALID_JOURNAL");
    return state;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function workerAlive(directory: string): Promise<boolean> {
  try {
    await ownedFile(path.join(directory, "lock.json"));
    const lock = JSON.parse(await readFile(path.join(directory, "lock.json"), "utf8"));
    return Number.isInteger(lock.pid) && lock.start != null && await processStart(lock.pid) === lock.start;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export interface AppImageTransactionOptions {
  target: string; currentVersion: string; hostVersion: string; workerScript: string;
  parentPid?: number; healthTimeoutMs?: number; restartArgs?: string[];
}

export class AppImageTransaction {
  private worker: ChildProcess | null = null;
  private input: import("node:stream").Writable | null = null;
  private waitPhase: ((phase: string) => void) | null = null;
  private armed = false;
  constructor(private readonly options: AppImageTransactionOptions) {}

  async prepare(installer: string, sha512: string, version: string): Promise<void> {
    const { target, currentVersion, hostVersion, workerScript } = this.options;
    const directory = appImageUpdateDirectory(target);
    if (!path.isAbsolute(installer) || installer === target || Buffer.from(sha512, "base64").length !== 64
      || Buffer.from(sha512, "base64").toString("base64") !== sha512 || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) throw new Error("APPIMAGE_UPDATE_INVALID_METADATA");
    await ownedFile(target); await ownedFile(installer);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error("APPIMAGE_UPDATE_UNSAFE_DIRECTORY");
    if (await workerAlive(directory)) throw new Error("APPIMAGE_UPDATE_BUSY");
    const pending = await readAppImageJournal(target);
    if (pending && ["armed", "installed"].includes(pending.phase) && await hashFile(target) === pending.newSha512) throw new Error("APPIMAGE_UPDATE_RECOVERY_REQUIRED");
    const token = randomBytes(32).toString("hex");
    const stage = path.join(directory, `stage-${token}.AppImage`);
    const backup = path.join(directory, `backup-${token}.AppImage`);
    const candidate = path.join(directory, `candidate-${token}.json`);
    try {
      await copyFile(installer, stage, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      const { chmod } = await import("node:fs/promises");
      await chmod(stage, (await lstat(target)).mode & 0o777);
      const staged = await open(stage, "r"); try { await staged.sync(); } finally { await staged.close(); }
      const newSha512 = await hashFile(stage);
      if (newSha512 !== Buffer.from(sha512, "base64").toString("hex")) throw new Error("APPIMAGE_UPDATE_CHECKSUM_MISMATCH");
      await copyFile(target, backup, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      const saved = await open(backup, "r"); try { await saved.sync(); } finally { await saved.close(); }
      const oldSha512 = await hashFile(backup);
      if (await hashFile(target) !== oldSha512) throw new Error("APPIMAGE_UPDATE_CURRENT_CHANGED");
      const state: AppImageJournal = { schema: 1, token, target, stage, backup, phase: "prepared", oldVersion: currentVersion,
        newVersion: version, oldSha512, newSha512, hostVersion, healthTimeoutMs: this.options.healthTimeoutMs ?? 90000,
        restartArgs: this.options.restartArgs ?? [] };
      await atomicJson(candidate, state);
      await copyWorker(workerScript, directory);
      await this.startWorker(directory, "install", candidate);
    } catch (error) {
      await this.cancel();
      await unlink(stage).catch(() => {}); await unlink(backup).catch(() => {});
      await unlink(candidate).catch(() => {});
      throw error;
    }
  }

  private async startWorker(directory: string, mode: "install" | "rollback" | "relaunch", candidate = path.join(directory, "state.json")): Promise<void> {
    this.armed = false;
    const pid = this.options.parentPid ?? process.pid;
    const start = await processStart(pid);
    if (!start) throw new Error("APPIMAGE_UPDATE_PARENT_MISSING");
    const worker = spawn("python3", [path.join(directory, "worker.py"), "--state", candidate,
      "--mode", mode, "--parent", String(pid), "--parent-start", start], { detached: true, stdio: ["pipe", "pipe", "ignore"] });
    this.worker = worker; this.input = worker.stdin;
    let lines = "";
    worker.stdout!.setEncoding("utf8").on("data", (data: string) => {
      lines += data;
      let index;
      while ((index = lines.indexOf("\n")) >= 0) {
        const line = lines.slice(0, index); lines = lines.slice(index + 1);
        try { this.waitPhase?.(JSON.parse(line).phase); } catch { /* rejected by handshake timeout */ }
      }
    });
    worker.stdin!.on("error", () => {});
    await this.phase("ready");
  }

  private phase(expected: string, send?: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const worker = this.worker!;
      const failed = () => { finish(); reject(new Error("APPIMAGE_UPDATE_WORKER_FAILED")); };
      const timer = setTimeout(failed, 5000);
      const finish = () => { clearTimeout(timer); this.waitPhase = null; worker.off("error", failed); worker.off("exit", failed); };
      this.waitPhase = (phase) => { if (phase === expected) { finish(); resolve(); } };
      worker.once("error", failed); worker.once("exit", failed);
      send?.();
    });
  }

  async arm(): Promise<void> {
    if (this.armed) return;
    await this.phase("armed", () => { this.input!.write("install\n"); });
    this.armed = true;
    this.worker!.stdout!.destroy(); this.input!.end();
    this.worker!.unref();
  }

  canInstall(): boolean { return this.armed && this.worker?.exitCode === null && this.worker.signalCode === null && !this.worker.killed; }

  async cancel(): Promise<void> {
    const worker = this.worker;
    if (!worker || worker.exitCode !== null || worker.signalCode !== null) { this.worker = null; this.armed = false; return; }
    this.input?.end();
    if (this.armed) worker.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { worker.kill("SIGKILL"); resolve(); }, 2000);
      timer.unref();
      worker.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    this.worker = null; this.armed = false;
  }

  async recoverInterrupted(): Promise<boolean> {
    const state = await readAppImageJournal(this.options.target);
    if (!state || !["armed", "installed"].includes(state.phase)) return false;
    const directory = appImageUpdateDirectory(state.target);
    if (await workerAlive(directory)) return false;
    const current = await hashFile(state.target);
    if (current === state.oldSha512) {
      await atomicJson(path.join(directory, "state.json"), { ...state, phase: "failed" });
      await unlink(state.stage).catch(() => {}); await unlink(state.backup).catch(() => {});
      return false;
    }
    if (current !== state.newSha512) throw new Error("APPIMAGE_UPDATE_CURRENT_CHANGED");
    await ownedFile(state.backup);
    if (await hashFile(state.backup) !== state.oldSha512) throw new Error("APPIMAGE_UPDATE_BACKUP_CHANGED");
    await copyWorker(this.options.workerScript, directory);
    await this.startWorker(directory, "rollback"); await this.arm();
    return true;
  }

  async relaunchCurrent(): Promise<void> {
    await this.cancel();
    const state = await readAppImageJournal(this.options.target);
    if (!state || await hashFile(state.target) !== state.oldSha512) throw new Error("APPIMAGE_UPDATE_CURRENT_CHANGED");
    const directory = appImageUpdateDirectory(state.target);
    await copyWorker(this.options.workerScript, directory);
    await this.startWorker(directory, "relaunch"); await this.arm();
  }
}

export async function confirmAppImageHealth(input: { target: string; currentVersion: string; resourcesPath: string; hostVersion: string; token?: string }): Promise<boolean> {
  const state = await readAppImageJournal(input.target);
  if (!state || !["armed", "installed"].includes(state.phase)) return false;
  // The new application's compiled host version can differ from the old one.
  // Its resource checks below prove the new Electron/host pair, independently of the old package.
  if (state.newVersion !== input.currentVersion || (input.token && input.token !== state.token)) throw new Error("APPIMAGE_UPDATE_HEALTH_VERSION_MISMATCH");
  await ownedFile(input.target);
  if (await hashFile(input.target) !== state.newSha512) throw new Error("APPIMAGE_UPDATE_HEALTH_CHECKSUM_MISMATCH");
  const directory = path.join(input.resourcesPath, "bin");
  const records = (await readFile(path.join(directory, "SHA256SUMS"), "utf8")).trim().split("\n");
  for (const name of ["cyrene-overlay-host", "cyrene-overlay-fullscreen"]) {
    const matches = records.filter((line) => line.endsWith(`  ${name}`));
    if (matches.length !== 1 || !/^[a-f0-9]{64}  /.test(matches[0])) throw new Error("APPIMAGE_UPDATE_HOST_MANIFEST_INVALID");
    // SquashFS resources in an AppImage are commonly root-owned and read-only.
    const binary = path.join(directory, name); await ownedFile(binary, true);
    if (await hashFile(binary, "sha256") !== matches[0].slice(0, 64)) throw new Error("APPIMAGE_UPDATE_HOST_CHECKSUM_MISMATCH");
    const result = await exec(binary, ["--version"], { encoding: "utf8", timeout: 3000 });
    if (result.stdout.trim() !== `${name} ${input.hostVersion}`) throw new Error("APPIMAGE_UPDATE_HOST_VERSION_MISMATCH");
  }
  await atomicJson(path.join(appImageUpdateDirectory(input.target), `health-${state.token}.json`),
    { token: state.token, version: input.currentVersion, hostVersion: input.hostVersion });
  return true;
}

import { spawn } from "child_process";
import fs from "fs";
import path from "path";

export type ShellKind = "cmd" | "bash";

export interface ResolvedShellExecutable {
  kind: ShellKind;
  executable: string;
}

/**
 * 未显式指定解释器时的平台默认值。
 * cmd 只在 Windows 上有意义；Linux/macOS 统一使用 bash（POSIX shell）。
 */
export function getDefaultShellKind(platform: NodeJS.Platform = process.platform): ShellKind {
  return platform === "win32" ? "cmd" : "bash";
}

export function buildDirectShellInvocation(
  shell: ResolvedShellExecutable,
  command: string,
): { command: string; args: string[]; windowsVerbatimArguments: boolean } {
  if (shell.kind === "bash") {
    return {
      command: shell.executable,
      args: ["--noprofile", "--norc", "-lc", command],
      windowsVerbatimArguments: false,
    };
  }
  return {
    command: shell.executable,
    args: ["/d", "/s", "/c", command],
    windowsVerbatimArguments: true,
  };
}

export async function resolveShellExecutable(
  kind: ShellKind,
  platform: NodeJS.Platform = process.platform,
): Promise<ResolvedShellExecutable | null> {
  // POSIX 上没有 cmd.exe。把显式传入的 cmd 视作“平台默认 shell”的别名，
  // 避免模型沿用 Windows 习惯时命令直接 ENOENT。
  if (kind === "cmd" && platform === "win32") {
    return { kind, executable: process.env.ComSpec || "cmd.exe" };
  }

  const bashKind: ShellKind = "bash";
  for (const candidate of collectBashCandidates(platform)) {
    if (!fs.existsSync(candidate)) continue;
    // POSIX 上可执行位就是执行契约，避免每次解析都多启动一个探测进程；
    // Windows 的 Git Bash 来自用户安装，仍需真实试跑确认可用。
    const usable = platform === "win32" ? await probeBash(candidate) : isExecutableFile(candidate);
    if (usable) return { kind: bashKind, executable: candidate };
  }
  return null;
}

function isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function collectBashCandidates(platform: NodeJS.Platform): string[] {
  const candidates: string[] = [];
  const bashName = platform === "win32" ? "bash.exe" : "bash";
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, "");
    if (directory) candidates.push(path.join(directory, bashName));
  }

  if (platform === "win32") {
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    const localAppData = process.env.LOCALAPPDATA;
    if (programFiles) candidates.push(path.join(programFiles, "Git", "bin", "bash.exe"));
    if (programFilesX86) candidates.push(path.join(programFilesX86, "Git", "bin", "bash.exe"));
    if (localAppData) candidates.push(path.join(localAppData, "Programs", "Git", "bin", "bash.exe"));
  } else {
    // PATH 缺失或被裁剪时的常见安装位置；Apple Silicon Homebrew 也在其中。
    candidates.push("/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash");
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = platform === "win32"
      ? path.normalize(candidate).toLowerCase()
      : path.normalize(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function probeBash(executable: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(executable, ["--noprofile", "--norc", "-lc", "printf cyrene-bash-probe"], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0 && stdout === "cyrene-bash-probe"));
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      finish(false);
    }, 3_000);
  });
}

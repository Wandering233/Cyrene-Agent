import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

if (process.platform !== "linux") {
  console.error("[overlay-host] the native Wayland overlay host is Linux-only");
  process.exit(1);
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..", "..");
const manifestPath = path.join(repoRoot, "native", "cyrene-overlay-host", "Cargo.toml");
const binaries = ["cyrene-overlay-host", "cyrene-overlay-fullscreen"];

const result = spawnSync(
  "cargo",
  ["build", "--release", "--locked", "--manifest-path", manifestPath],
  { cwd: repoRoot, shell: false, stdio: "inherit" },
);

if (result.error) {
  console.error(`[overlay-host] failed to launch Cargo: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

for (const binary of binaries) {
  const builtPath = path.join(
    repoRoot,
    "native",
    "cyrene-overlay-host",
    "target",
    "release",
    binary,
  );
  const stagedPath = path.join(repoRoot, "resources", "bin", "linux", binary);
  await mkdir(path.dirname(stagedPath), { recursive: true });
  await copyFile(builtPath, stagedPath);
  await chmod(stagedPath, 0o755);
  console.log(`[overlay-host] staged ${stagedPath}`);
}

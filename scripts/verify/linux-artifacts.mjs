#!/usr/bin/env node
/**
 * Verify a Linux release directory produced by `pnpm run package:linux`.
 * Fails fast when the AppImage, update metadata, or native overlay hosts are
 * missing; this is the check we run before uploading release assets.
 */
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";

const releaseDir = path.resolve(process.argv[2] ?? "release");
const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
const errors = [];
const checked = [];

async function checkFile(file, executable = false) {
  const full = path.join(releaseDir, file);
  try {
    const info = await stat(full);
    if (!info.isFile()) throw new Error("not a file");
    if (executable && (info.mode & 0o111) === 0) throw new Error("not executable");
    checked.push(`${file} (${info.size} bytes)`);
  } catch (error) {
    errors.push(`${file}: ${error.message}`);
  }
}

const appImage = `Cyrene-${packageJson.version}.AppImage`;
await checkFile(appImage, true);
await checkFile("latest-linux.yml");
await checkFile("linux-unpacked/resources/bin/cyrene-overlay-host", true);
await checkFile("linux-unpacked/resources/bin/cyrene-overlay-fullscreen", true);

try {
  const update = await readFile(path.join(releaseDir, "latest-linux.yml"), "utf8");
  if (!/^version:/m.test(update)) errors.push("latest-linux.yml: missing version");
  if (!/^path: .*\.AppImage$/m.test(update)) errors.push("latest-linux.yml: missing AppImage path");
  if (!/^sha512:/m.test(update)) errors.push("latest-linux.yml: missing sha512");
} catch (error) {
  errors.push(`latest-linux.yml: ${error.message}`);
}

if (errors.length > 0) {
  console.error("[linux-artifacts] failed:");
  for (const error of errors) console.error(`  ✗ ${error}`);
  process.exit(1);
}
console.log("[linux-artifacts] ok");
for (const item of checked) console.log(`  ✓ ${item}`);

#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const binaries = ["cyrene-overlay-host", "cyrene-overlay-fullscreen"];

async function digestFile(file, algorithm, encoding = "hex") {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}

/** Validate update metadata and bytes before publishing a Linux release. */
export async function verifyLinuxArtifacts({ releaseDir, version, expectedPublish, stagedBinDir, workerScript }) {
  const errors = [];
  const checked = [];
  const appImage = `Cyrene-${version}.AppImage`;
  const binDir = path.join(releaseDir, "linux-unpacked/resources/bin");
  async function checkFile(file, executable = false) {
    try {
      const info = await stat(path.join(releaseDir, file));
      if (!info.isFile() || info.size === 0) throw new Error("empty or not a file");
      if (executable && (info.mode & 0o111) === 0) throw new Error("not executable");
      checked.push(`${file} (${info.size} bytes)`);
      return info;
    } catch (error) { errors.push(`${file}: ${error.message}`); }
  }
  const imageInfo = await checkFile(appImage, true);
  await checkFile("latest-linux.yml");
  for (const binary of binaries) await checkFile(`linux-unpacked/resources/bin/${binary}`, true);
  await checkFile("linux-unpacked/resources/bin/SHA256SUMS");
  await checkFile("linux-unpacked/resources/bin/appimage-worker.py");
  if (workerScript) {
    try {
      if (await digestFile(path.join(binDir, "appimage-worker.py"), "sha256") !== await digestFile(workerScript, "sha256")) errors.push("AppImage worker mismatch");
    } catch (error) { errors.push(`AppImage worker: ${error.message}`); }
  }

  try {
    const update = parse(await readFile(path.join(releaseDir, "latest-linux.yml"), "utf8"));
    if (update?.version !== version) errors.push("latest-linux.yml: version mismatch");
    if (update?.path !== appImage) errors.push("latest-linux.yml: AppImage path mismatch");
    const files = update?.files;
    if (!Array.isArray(files) || files.length !== 1 || files[0]?.url !== appImage) {
      errors.push("latest-linux.yml: expected exactly one matching AppImage entry");
    }
    const entry = Array.isArray(files) ? files[0] : undefined;
    if (!imageInfo || entry?.size !== imageInfo.size) errors.push("latest-linux.yml: AppImage size mismatch");
    const digest = await digestFile(path.join(releaseDir, appImage), "sha512", "base64");
    if (update?.sha512 !== digest || entry?.sha512 !== digest) errors.push("latest-linux.yml: AppImage sha512 mismatch");
  } catch (error) { errors.push(`latest-linux.yml: ${error.message}`); }

  try {
    const entries = new Map();
    const sums = await readFile(path.join(binDir, "SHA256SUMS"), "utf8");
    for (const line of sums.split(/\r?\n/).filter((line) => line.trim())) {
      const match = /^([a-f0-9]{64})  ([a-z0-9-]+)$/.exec(line);
      if (!match || !binaries.includes(match[2]) || entries.has(match[2])) {
        throw new Error("invalid, unexpected or duplicate SHA256SUMS entry");
      }
      entries.set(match[2], match[1]);
    }
    for (const binary of binaries) {
      if (!entries.has(binary)) { errors.push(`SHA256SUMS: missing ${binary}`); continue; }
      const digest = await digestFile(path.join(binDir, binary), "sha256");
      if (digest !== entries.get(binary)) errors.push(`SHA256SUMS mismatch: ${binary}`);
      if (stagedBinDir && digest !== await digestFile(path.join(stagedBinDir, binary), "sha256")) {
        errors.push(`staged host mismatch: ${binary}`);
      }
    }
  } catch (error) { errors.push(`SHA256SUMS: ${error.message}`); }

  if (expectedPublish) {
    try {
      const publish = parse(await readFile(path.join(releaseDir, "linux-unpacked/resources/app-update.yml"), "utf8"));
      for (const key of ["provider", "owner", "repo"]) {
        if (publish?.[key] !== expectedPublish[key]) errors.push(`app-update.yml: ${key} mismatch`);
      }
    } catch (error) { errors.push(`app-update.yml: ${error.message}`); }
  }
  return { errors, checked };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const config = parse(await readFile(path.join(repoRoot, "electron-builder.yml"), "utf8"));
  const result = await verifyLinuxArtifacts({
    releaseDir: path.resolve(process.argv[2] ?? path.join(repoRoot, "release")),
    version: packageJson.version,
    expectedPublish: config.linux?.publish ?? config.publish,
    stagedBinDir: path.join(repoRoot, "resources/bin/linux"),
    workerScript: path.join(repoRoot, "scripts/update/appimage-worker.py"),
  });
  if (result.errors.length) {
    console.error("[linux-artifacts] failed:");
    for (const error of result.errors) console.error(`  ✗ ${error}`);
    process.exitCode = 1;
  } else {
    console.log("[linux-artifacts] ok");
    for (const item of result.checked) console.log(`  ✓ ${item}`);
  }
}

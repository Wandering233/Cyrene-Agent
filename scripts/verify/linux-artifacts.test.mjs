import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";
import { verifyLinuxArtifacts } from "./linux-artifacts.mjs";

let root, binDir, staged, metadata;
const publish = { provider: "github", owner: "Wandering233", repo: "Cyrene-Agent" };
const sha = (bytes, kind, encoding = "hex") => createHash(kind).update(bytes).digest(encoding);
async function verify() {
  return verifyLinuxArtifacts({ releaseDir: root, version: "1.3.7", expectedPublish: publish, stagedBinDir: staged,
    workerScript: path.join(root, "worker-source.py") });
}
async function saveMetadata() { await writeFile(path.join(root, "latest-linux.yml"), stringify(metadata)); }
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "cyrene-artifacts-"));
  binDir = path.join(root, "linux-unpacked/resources/bin"); staged = path.join(root, "staged");
  await mkdir(binDir, { recursive: true }); await mkdir(staged);
  const image = Buffer.from("test AppImage bytes");
  await writeFile(path.join(root, "Cyrene-1.3.7.AppImage"), image, { mode: 0o755 });
  const sums = [];
  for (const name of ["cyrene-overlay-host", "cyrene-overlay-fullscreen"]) {
    const bytes = Buffer.from(name);
    await writeFile(path.join(binDir, name), bytes, { mode: 0o755 });
    await writeFile(path.join(staged, name), bytes);
    sums.push(`${sha(bytes, "sha256")}  ${name}`);
  }
  await writeFile(path.join(binDir, "SHA256SUMS"), sums.join("\n") + "\n");
  await writeFile(path.join(binDir,"appimage-worker.py"),"worker fixture");
  await writeFile(path.join(root,"worker-source.py"),"worker fixture");
  await writeFile(path.join(root, "linux-unpacked/resources/app-update.yml"), stringify(publish));
  const digest = sha(image, "sha512", "base64");
  metadata = { version: "1.3.7", path: "Cyrene-1.3.7.AppImage", sha512: digest,
    files: [{ url: "Cyrene-1.3.7.AppImage", size: image.length, sha512: digest }] };
  await saveMetadata();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test("完整产物通过", async () => { assert.deepEqual((await verify()).errors, []); });
test("缺失安装 worker 会拒绝产物", async () => {
  await rm(path.join(binDir,"appimage-worker.py"));
  assert.ok((await verify()).errors.some(error=>error.includes("appimage-worker.py")));
});
test("安装 worker 与当前源码不符会拒绝产物", async () => {
  await writeFile(path.join(binDir,"appimage-worker.py"),"old worker");
  assert.ok((await verify()).errors.some(error=>error.includes("worker mismatch")));
});
test("同尺寸替换 AppImage 也会拒绝", async () => {
  await writeFile(path.join(root, metadata.path), Buffer.alloc(metadata.files[0].size));
  assert.ok((await verify()).errors.some((e) => e.includes("sha512 mismatch")));
});
test("截断 AppImage 同时报告大小和摘要不一致", async () => {
  await writeFile(path.join(root, metadata.path), "short");
  const { errors } = await verify();
  assert.ok(errors.some((e) => e.includes("size mismatch")));
  assert.ok(errors.some((e) => e.includes("sha512 mismatch")));
});
for (const field of ["version", "path", "fileUrl", "fileSha512", "sha512"]) {
  test(`拒绝元数据 ${field} 不匹配`, async () => {
    if (field === "fileUrl") metadata.files[0].url = "other.AppImage";
    else if (field === "fileSha512") metadata.files[0].sha512 = "wrong";
    else metadata[field] = "wrong";
    await saveMetadata(); assert.ok((await verify()).errors.length);
  });
}
for (const content of ["", "bad\n", "a".repeat(64) + "  ../outside\n"]) {
  test(`拒绝空或非法宿主摘要 ${content.slice(0, 8)}`, async () => {
    await writeFile(path.join(binDir, "SHA256SUMS"), content);
    assert.ok((await verify()).errors.length);
  });
}
test("拒绝缺少或重复宿主摘要", async () => {
  const line = (await readFile(path.join(binDir, "SHA256SUMS"), "utf8")).split("\n")[0];
  await writeFile(path.join(binDir, "SHA256SUMS"), line + "\n");
  assert.ok((await verify()).errors.some((e) => e.includes("missing cyrene-overlay-fullscreen")));
  await writeFile(path.join(binDir, "SHA256SUMS"), `${line}\n${line}\n`);
  assert.ok((await verify()).errors.some((e) => e.includes("duplicate")));
});
test("拒绝与当前 staging 不同的包内宿主", async () => {
  await writeFile(path.join(staged, "cyrene-overlay-host"), "new host");
  assert.ok((await verify()).errors.some((e) => e.includes("staged host mismatch")));
});
test("拒绝仍指向上游的更新配置", async () => {
  await writeFile(path.join(root, "linux-unpacked/resources/app-update.yml"), stringify({ ...publish, owner: "Playa-Cyrene" }));
  assert.ok((await verify()).errors.some((e) => e.includes("owner mismatch")));
});
test("CI 触发与 Linux 更新配置使用当前 fork 分支", async () => {
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const workflow = parse(await readFile(path.join(repoRoot, ".github/workflows/linux.yml"), "utf8"));
  assert.deepEqual(workflow.on.push.branches, ["cyreneOnHyprland"]);
  assert.deepEqual(workflow.on.pull_request.branches, ["cyreneOnHyprland"]);
  const config = parse(await readFile(path.join(repoRoot, "electron-builder.yml"), "utf8"));
  assert.deepEqual(config.linux.publish, publish);
  assert.equal(config.publish.owner, "Playa-Cyrene");
});

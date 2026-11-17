import { mkdtemp, readFile, writeFile, chmod, rm, symlink, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppImageTransaction, appImageUpdateDirectory, confirmAppImageHealth, processStart, readAppImageJournal } from "./appimage-transaction";

let directory: string;
const processes: ChildProcess[] = [];
const transactions: AppImageTransaction[] = [];
const workerScript = path.resolve("scripts/update/appimage-worker.py");
const hash = (data: string) => createHash("sha512").update(data).digest("base64");
const wait = async (condition: () => unknown | Promise<unknown>) => {
  for (let i = 0; i < 150; i++) { if (await condition()) return; await new Promise((resolve) => setTimeout(resolve, 40)); }
  throw new Error("transaction did not settle");
};
async function executable(file: string, body: string) { await writeFile(file, body); await chmod(file, 0o755); }
async function parent() {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {stdio:"ignore"});
  processes.push(child); await wait(async () => await processStart(child.pid!) !== null); return child;
}
function oldImage() { return `#!/usr/bin/python3\nfrom pathlib import Path\nPath(${JSON.stringify(path.join(directory,"old-started"))}).write_text('old')\n`; }
function newImage(mode: "healthy" | "exit" | "hang", badVersion = false) {
  return `#!/usr/bin/python3\nimport os,json,time\nfrom pathlib import Path\ns=Path(os.environ['CYRENE_UPDATE_STATE'])\nst=json.loads(s.read_text())\nPath(${JSON.stringify(path.join(directory,"new.pid"))}).write_text(str(os.getpid()))\n`
    + (mode === "healthy" ? `p=s.parent/('health-'+st['token']+'.json')\np.write_text(json.dumps({'token':st['token'],'version':${badVersion ? "'9.9.9'" : "st['newVersion']"},'hostVersion':st['hostVersion']}))\n` : "")
    + (mode === "exit" ? "raise SystemExit(7)\n" : "time.sleep(60)\n");
}
async function setup(mode: "healthy" | "exit" | "hang" = "healthy", badVersion = false) {
  const target = path.join(directory, "Cyrene custom.AppImage");
  const installer = path.join(directory, "download.AppImage");
  await executable(target, oldImage()); await executable(installer, newImage(mode,badVersion));
  const owner = await parent();
  const transaction = new AppImageTransaction({target,currentVersion:"1.0.0",hostVersion:"0.1.5",workerScript,parentPid:owner.pid,healthTimeoutMs:800});
  transactions.push(transaction);
  return {target,installer,owner,transaction,body:await readFile(installer,"utf8")};
}
async function install(context: Awaited<ReturnType<typeof setup>>) {
  await context.transaction.prepare(context.installer,hash(context.body),"1.0.1");
  expect(await readFile(context.target,"utf8")).toBe(oldImage());
  await context.transaction.arm();context.owner.kill();
}

beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(),"cyrene-appimage-update-")); });
afterEach(async () => {
  for (const transaction of transactions.splice(0)) await transaction.cancel();
  for (const child of processes.splice(0)) child.kill("SIGKILL");
  try { process.kill(-Number(await readFile(path.join(directory,"new.pid"),"utf8")),"SIGKILL"); } catch {}
  await rm(directory,{recursive:true,force:true});
});

describe.skipIf(process.platform !== "linux")("AppImage 文件与进程事务", () => {
  it("健康确认后固定路径保留新版本，并保留上一版和结果记录", async () => {
    const c=await setup();await install(c);
    await wait(async()=> (await readAppImageJournal(c.target))?.phase==="healthy");
    expect(await readFile(c.target,"utf8")).toBe(c.body);
    expect(await readFile(path.join(appImageUpdateDirectory(c.target),"previous.AppImage"),"utf8")).toBe(oldImage());
    expect(JSON.parse(await readFile(path.join(appImageUpdateDirectory(c.target),"result.json"),"utf8"))).toMatchObject({result:"healthy",version:"1.0.1",previousVersion:"1.0.0"});
  },15000);
  it.each(["exit","hang"] as const)("新版本 %s 时恢复原字节并重新启动旧版", async (mode) => {
    const c=await setup(mode);await install(c);
    await wait(async()=> (await readAppImageJournal(c.target))?.phase==="rolled_back");
    await wait(async()=>{try{return await readFile(path.join(directory,"old-started"),"utf8");}catch{return false;}});
    expect(await readFile(c.target,"utf8")).toBe(oldImage());
  },15000);
  it("错误版本的健康消息不能阻止回滚", async () => {
    const c=await setup("healthy",true);await install(c);
    await wait(async()=> (await readAppImageJournal(c.target))?.phase==="rolled_back");
    expect(await readFile(c.target,"utf8")).toBe(oldImage());
  },15000);
  it("校验失败与准备取消不改变当前版本，取消后可重试", async () => {
    const c=await setup();
    await expect(c.transaction.prepare(c.installer,hash("wrong"),"1.0.1")).rejects.toThrow("CHECKSUM");
    expect(await readFile(c.target,"utf8")).toBe(oldImage());
    await c.transaction.prepare(c.installer,hash(c.body),"1.0.1");await c.transaction.cancel();
    expect(await readFile(c.target,"utf8")).toBe(oldImage());
    await c.transaction.prepare(c.installer,hash(c.body),"1.0.1");await c.transaction.cancel();
  },15000);
  it("并发准备只允许一个持有文件锁，失败的一方不清理赢家的文件", async () => {
    const c=await setup();
    const other=new AppImageTransaction({target:c.target,currentVersion:"1.0.0",hostVersion:"0.1.5",workerScript,parentPid:c.owner.pid});transactions.push(other);
    const results=await Promise.allSettled([c.transaction.prepare(c.installer,hash(c.body),"1.0.1"),other.prepare(c.installer,hash(c.body),"1.0.1")]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    const state=(await readAppImageJournal(c.target))!;
    expect(await readFile(state.stage,"utf8")).toBe(c.body);expect(await readFile(state.backup,"utf8")).toBe(oldImage());
  },15000);
  it("复制后 stage 被篡改时拒绝替换当前文件", async () => {
    const c=await setup();await c.transaction.prepare(c.installer,hash(c.body),"1.0.1");
    await writeFile((await readAppImageJournal(c.target))!.stage,"tampered");await c.transaction.arm();c.owner.kill();
    await wait(async()=> (await readAppImageJournal(c.target))?.phase==="failed");
    expect(await readFile(c.target,"utf8")).toBe(oldImage());
  },15000);
  it("worker 被杀且新版本未确认时，下次启动恢复上一版", async () => {
    const c=await setup("hang");await install(c);
    await wait(async()=> (await readAppImageJournal(c.target))?.phase==="installed");
    const lock=JSON.parse(await readFile(path.join(appImageUpdateDirectory(c.target),"lock.json"),"utf8"));process.kill(lock.pid,"SIGKILL");
    await wait(async()=> await processStart(lock.pid)===null);
    expect(c.transaction.canInstall()).toBe(false);
    await wait(async()=>{try{return await readFile(path.join(directory,"new.pid"),"utf8");}catch{return false;}});
    process.kill(-Number(await readFile(path.join(directory,"new.pid"),"utf8")),"SIGKILL");
    const owner=await parent();const recovery=new AppImageTransaction({target:c.target,currentVersion:"1.0.1",hostVersion:"0.1.5",workerScript,parentPid:owner.pid});transactions.push(recovery);
    const journal=(await readAppImageJournal(c.target))!;
    await writeFile(path.join(appImageUpdateDirectory(c.target),`restore-${journal.token}.AppImage`),"interrupted partial restore");
    expect(await recovery.recoverInterrupted()).toBe(true);owner.kill();
    await wait(async()=> (await readAppImageJournal(c.target))?.phase==="rolled_back");
    expect(await readFile(c.target,"utf8")).toBe(oldImage());
  },15000);
  it("符号链接目标被拒绝，外部文件不被覆盖", async () => {
    const c=await setup();const link=path.join(directory,"linked.AppImage");await symlink(c.target,link);
    const transaction=new AppImageTransaction({target:link,currentVersion:"1.0.0",hostVersion:"0.1.5",workerScript});
    await expect(transaction.prepare(c.installer,hash(c.body),"1.0.1")).rejects.toThrow("UNSAFE_FILE");
    expect(await readFile(c.target,"utf8")).toBe(oldImage());
  });
  it("更新目录里的 worker 符号链接不会覆盖外部文件", async () => {
    const c=await setup();const external=path.join(directory,"external.txt");await writeFile(external,"keep");
    await import("node:fs/promises").then(fs=>fs.mkdir(appImageUpdateDirectory(c.target),{mode:0o700}));
    await symlink(external,path.join(appImageUpdateDirectory(c.target),"worker.py"));
    await c.transaction.prepare(c.installer,hash(c.body),"1.0.1");
    expect(await readFile(external,"utf8")).toBe("keep");await c.transaction.cancel();
  },15000);
  it("受控退出后安装未提交时，通过 worker 重新启动保留的当前版本", async () => {
    const c=await setup();await c.transaction.prepare(c.installer,hash(c.body),"1.0.1");await c.transaction.arm();
    const lock=JSON.parse(await readFile(path.join(appImageUpdateDirectory(c.target),"lock.json"),"utf8"));process.kill(lock.pid,"SIGKILL");
    await wait(async()=>await processStart(lock.pid)===null);
    await c.transaction.relaunchCurrent();c.owner.kill();
    await wait(async()=>{try{return await readFile(path.join(directory,"old-started"),"utf8");}catch{return false;}});
    expect(await readFile(c.target,"utf8")).toBe(oldImage());
  },15000);
  it("健康确认检查两宿主的实际版本与摘要，错误配套不能写标记", async () => {
    const c=await setup("hang");await install(c);
    await wait(async()=> (await readAppImageJournal(c.target))?.phase==="installed");
    const resources=path.join(directory,"resources");const bin=path.join(resources,"bin");await import("node:fs/promises").then(fs=>fs.mkdir(bin,{recursive:true}));
    const records=[];
    for(const name of ["cyrene-overlay-host","cyrene-overlay-fullscreen"]){const body=`#!/bin/sh\nprintf '%s\\n' '${name} 0.1.4'\n`;await executable(path.join(bin,name),body);records.push(`${createHash("sha256").update(body).digest("hex")}  ${name}`);}
    await writeFile(path.join(bin,"SHA256SUMS"),records.join("\n")+"\n");
    await expect(confirmAppImageHealth({target:c.target,currentVersion:"1.0.1",resourcesPath:resources,hostVersion:"0.1.5"})).rejects.toThrow("HOST_VERSION");
    expect((await readdir(appImageUpdateDirectory(c.target))).some(name=>name.startsWith("health-"))).toBe(false);
    await expect(confirmAppImageHealth({target:c.target,currentVersion:"1.0.1",resourcesPath:resources,hostVersion:"0.1.5",token:"wrong"})).rejects.toThrow("HEALTH_VERSION");
    const correct=[];
    for(const name of ["cyrene-overlay-host","cyrene-overlay-fullscreen"]){const body=`#!/bin/sh\nprintf '%s\\n' '${name} 0.1.6'\n`;await executable(path.join(bin,name),body);correct.push(`${createHash("sha256").update(body).digest("hex")}  ${name}`);}
    await writeFile(path.join(bin,"SHA256SUMS"),correct.join("\n")+"\n");
    expect(await confirmAppImageHealth({target:c.target,currentVersion:"1.0.1",resourcesPath:resources,hostVersion:"0.1.6"})).toBe(true);
    await wait(async()=> (await readAppImageJournal(c.target))?.phase==="healthy");
    expect((await readAppImageJournal(c.target))!.verifiedHostVersion).toBe("0.1.6");
  },15000);
});

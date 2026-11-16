#!/usr/bin/env node
/**
 * Short Linux overlay soak check: launch the real app hidden, sample main
 * process RSS/fd count, then terminate. Catches obvious unbounded growth in
 * the frame/socket path; not a substitute for a long-running leak test.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const seconds = Number(process.argv[2] ?? 20);
const electron = path.resolve("node_modules/electron/dist/electron");
const tempConfig = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-soak-"));
const userData = path.join(tempConfig, "userdata");
const env = { ...process.env, XDG_CONFIG_HOME: tempConfig, CYRENE_PET_OVERLAY: "1" };
delete env.DISPLAY;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findAppPid() {
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const args = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
      if (args.some((arg) => arg.includes(`--user-data-dir=${userData}`))) return Number(entry);
    } catch { /* raced */ }
  }
  return 0;
}
function rssKb(pid) {
  try {
    const fields = fs.readFileSync(`/proc/${pid}/statm`, "utf8").trim().split(/\s+/);
    return Number(fields[1] ?? 0) * 4;
  } catch { return 0; }
}
function fdCount(pid) {
  try { return fs.readdirSync(`/proc/${pid}/fd`).length; } catch { return 0; }
}
const clockTicks = 100;
function cpuTicks(pid) {
  try {
    const fields = fs.readFileSync(`/proc/${pid}/stat`, "utf8").trim().split(/\s+/);
    return Number(fields[13]) + Number(fields[14]);
  } catch { return 0; }
}

const child = spawn(electron, [".", "--autostart", `--user-data-dir=${userData}`], {
  cwd: process.cwd(), env, stdio: "ignore", detached: true,
});
await sleep(5000);
const pid = findAppPid();
if (!pid) {
  console.error("[overlay-soak] app main process did not start");
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  fs.rmSync(tempConfig, { recursive: true, force: true });
  process.exit(1);
}
const samples = [];
for (let i = 0; i < Math.max(2, Math.floor(seconds / 4)); i += 1) {
  samples.push({ rss: rssKb(pid), fds: fdCount(pid), cpu: cpuTicks(pid), at: Date.now() });
  await sleep(4000);
}
const cpuPercent = samples.length > 1 && samples.at(-1).cpu >= samples[0].cpu
  ? ((samples.at(-1).cpu - samples[0].cpu) / clockTicks)
    / ((samples.at(-1).at - samples[0].at) / 1000) * 100
  : 0;
try { process.kill(-child.pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
await sleep(1500);
try { process.kill(-child.pid, "SIGKILL"); } catch {}
fs.rmSync(tempConfig, { recursive: true, force: true });

const first = samples[0], last = samples.at(-1);
const growth = first.rss > 0 ? ((last.rss - first.rss) / first.rss) * 100 : 0;
console.log("[overlay-soak] samples", samples);
console.log(`[overlay-soak] rss ${first.rss}KB -> ${last.rss}KB (${growth.toFixed(1)}%), fds ${first.fds} -> ${last.fds}, cpu ${cpuPercent.toFixed(1)}%`);
if (first.rss === 0) { console.error("[overlay-soak] could not read main process RSS"); process.exit(1); }
if (growth > 20) { console.error("[overlay-soak] RSS growth above 20%"); process.exit(1); }
if (last.fds - first.fds > 10) { console.error("[overlay-soak] fd growth above 10"); process.exit(1); }
console.log("[overlay-soak] ok");

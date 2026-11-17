#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const env = { ...process.env, QT_QPA_PLATFORM: "wayland" };
if (!env.WAYLAND_DISPLAY || !env.HYPRLAND_INSTANCE_SIGNATURE) throw new Error("A running Hyprland/Wayland host session is required");
const root = await mkdtemp(path.join(os.tmpdir(), "cyrene-host-"));
const started = Math.floor(Date.now() / 1000);
const qsSnapshot = async () => {
  const output = (await exec("ps", ["-u", String(process.getuid()), "-o", "pid=,stat=,comm="])).stdout;
  return output.split("\n").map(line => line.trim().split(/\s+/)).filter(parts => parts[2] === "quickshell")
    .map(([pid, state]) => ({ pid: Number(pid), state }));
};
const initialQs = await qsSnapshot();
const initialQsPids = new Set(initialQs.map(item => item.pid));
let lastQsCheck = 0;
const checkQs = async () => {
  if (Date.now() - lastQsCheck < 250) return;
  lastQsCheck = Date.now();
  const current = await qsSnapshot();
  if (initialQs.some(old => !old.state.startsWith("Z") && !current.some(item => item.pid === old.pid && !item.state.startsWith("Z")))
    || current.some(item => !initialQsPids.has(item.pid))) throw new Error(`Host Quickshell process state changed: ${JSON.stringify(current)}`);
};
const children = [];
let host, server, socket, proxy, originalCursor, originalWindow;
const logs = { compositor: "", host: "", quickshell: "", electron: "", proxy: "" };
const events = [];
const quickshellOnly = process.argv.includes("--quickshell-only");
const desktopInput = process.argv.includes("--desktop-input");
const windowBehavior = process.argv.includes("--window-behavior");
const cursorTheme = process.argv.includes("--cursor-theme");
const surfaceOnly = process.argv.includes("--surface-only");
const realMotion = process.argv.includes("--real-motion");
const launch = (name, command, args, options = {}) => {
  const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true, ...options });
  children.push(child);
  child.stdout.on("data", (bytes) => { logs[name] += bytes.toString(); });
  child.stderr.on("data", (bytes) => { logs[name] += bytes.toString(); });
  child.on("error", (error) => { logs[name] += error.message; });
  return child;
};
const deadline = Date.now() + 60_000;
const wait = async (condition, label) => {
  while (Date.now() < deadline) {
    const result = await condition();
    await checkQs();
    if (host && host.exitCode !== null) throw new Error(`Overlay host exited: ${logs.host.slice(-1500)}`);
    if (result) return result;
    await sleep(30);
  }
  throw new Error(`Timeout: ${label}`);
};
try {
  const instance = env.HYPRLAND_INSTANCE_SIGNATURE;
  const ctl = async (...args) => (await exec("hyprctl", ["-i", instance, ...args], { env, timeout: 3000 })).stdout;
  const monitors = async () => JSON.parse(await ctl("-j", "monitors"));
  const hostPath = path.resolve(process.env.CYRENE_OVERLAY_TEST_HOST ?? path.join(repoRoot, "resources/bin/linux/cyrene-overlay-host"));
  const displays = await monitors();
  const main = displays.find(item => item.focused) ?? displays[0];
  if (!main) throw new Error("No active host output");
  originalCursor = JSON.parse(await ctl("-j", "cursorpos"));
  originalWindow = JSON.parse(await ctl("-j", "activewindow"))?.address;
  if (process.argv.includes("--quickshell-config")) throw new Error("Host mode observes the running Quickshell; it does not load a second configuration");
  if (desktopInput || windowBehavior) {
    const electron = launch("electron", path.join(repoRoot, "node_modules/electron/dist/electron"),
      ["--ozone-platform=wayland", path.join(repoRoot, windowBehavior ? "scripts/verify/fixtures/linux-window-behavior.cjs" : "scripts/verify/fixtures/linux-window-input.cjs")],
      { env: { ...env, CYRENE_TEST_ROOT: root, CYRENE_TEST_REPO: repoRoot } });
    await wait(() => electron.exitCode !== null || electron.signalCode !== null, "desktop input regression");
    console.log(logs.electron);
    assert.equal(electron.exitCode, 0, "desktop input fixture failed");
    console.log("[window-input] host session and Quickshell remained healthy");
  } else if (quickshellOnly) {
    await sleep(500); await checkQs();
    console.log(`[overlay-lifecycle] host Quickshell observation passed: ${JSON.stringify(initialQs.filter(item => !item.state.startsWith("Z")))}`);
  } else {
    const address = path.join(root, "h.sock");
    server = net.createServer((connection) => {
      socket = connection;
      let buffer = "";
      connection.setEncoding("utf8");
      connection.on("data", (data) => {
        buffer += data;
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          events.push(JSON.parse(buffer.slice(0, newline))); buffer = buffer.slice(newline + 1);
        }
      });
      connection.on("error", () => {});
    });
    await new Promise((resolve) => server.listen(address, resolve));
    let hostDisplay = env.WAYLAND_DISPLAY;
    if (cursorTheme) {
      const proxySocket = path.join(root, "cursor.sock");
      proxy = launch("proxy", "python3", [path.join(repoRoot, "scripts/verify/fixtures/wayland-no-cursor-shape.py"), proxySocket, path.isAbsolute(env.WAYLAND_DISPLAY) ? env.WAYLAND_DISPLAY : path.join(env.XDG_RUNTIME_DIR, env.WAYLAND_DISPLAY)]);
      await wait(async () => { try { return (await readdir(root)).includes("cursor.sock"); } catch { return false; } }, "cursor proxy");
      hostDisplay = proxySocket;
    }
    host = launch("host", hostPath, ["--socket", address, "--layer", "overlay"], {
      env: { ...env, WAYLAND_DISPLAY: hostDisplay, WAYLAND_DEBUG: "1", ...(cursorTheme ? {XCURSOR_THEME:"Adwaita",XCURSOR_SIZE:"24"} : {}) },
    });
    await wait(() => events.some((event) => event.type === "ready"), "host ready");
    const send = (message) => socket.write(JSON.stringify(message) + "\n");
    const initialX = Math.round(Math.max(50, main.width / main.scale / 2 - 40));
    const initialY = Math.round(Math.max(60, main.height / main.scale / 2 - 50));
    const init = (name, x = initialX) => send({ type: "init", protocol: 1, width: 80, height: 100, x, y: initialY, scale: 1, output: name });
    init(main.name); send({ type: "show" });
    const pixels = Buffer.alloc(80 * 100 * 4);
    for (let i = 0; i < pixels.length; i += 4) { pixels[i + 1] = 180; pixels[i + 3] = 255; }
    send({ type: "frame", seq: 1, width: 80, height: 100, stride: 320 }); socket.write(pixels);
    await wait(() => events.some((event) => event.type === "frame_ack" && event.seq === 1), "initial frame");
    const mappedOn = async (name) => {
      const layers = JSON.parse(await ctl("-j", "layers"));
      return layers[name] && Object.values(layers[name].levels).flat().find((layer) => layer.pid === (proxy?.pid ?? host.pid) && layer.w === 80 && layer.h === 100);
    };
    const mapped = await wait(() => mappedOn(main.name), "initial host surface");
    console.log(`[overlay-lifecycle] test surface mapped at ${mapped.x},${mapped.y} ${mapped.w}x${mapped.h}`);
    const point = { x: mapped.x + 20, y: mapped.y + 20 };
    const movePointer = async (x, y) => {
      await ctl("dispatch", `hl.dsp.cursor.move({x=${Math.round(x)},y=${Math.round(y)}})`);
      if (realMotion) await exec("python3", [path.join(repoRoot, "scripts/verify/fixtures/pointer-motion.py"), String(Math.round(x)), String(Math.round(y))], { env, timeout: 5000 });
    };
    if (!surfaceOnly) {
    // Cursor requests before enter are cached. The request sent after enter
    // must use that enter's serial, including on later re-entry.
    send({ type: "cursor", cursor: "hand" });
    await movePointer(point.x, point.y);
    await wait(() => events.some((event) => event.type === "pointer" && event.event === "enter"), "pointer enter");
    const cursorCount = () => (logs.host.match(/wl_pointer@\d+\.set_cursor\(/g) ?? []).length;
    const screenshot = async (name) => {
      await sleep(80);
      const file = path.join(root, name + ".png");
      await exec("grim", ["-c", "-g", `${mapped.x},${mapped.y} ${mapped.w}x${mapped.h}`, file], { env, timeout: 3000 });
      const png = await readFile(file);
      const chunks=[]; let offset=8;
      while(offset+12<=png.length){const length=png.readUInt32BE(offset);const kind=png.toString("ascii",offset+4,offset+8);
        if(kind==="IDAT")chunks.push(png.subarray(offset+8,offset+8+length));offset+=length+12;}
      return {size:png.subarray(16,24),pixels:Buffer.concat(chunks)};
    };
    await wait(() => cursorTheme ? cursorCount() > 0 : /set_shape\(\d+, 4\)/.test(logs.host), "hand cursor shape");
    const hand = cursorTheme ? await screenshot("hand") : null;
    let requests = cursorCount();
    send({ type: "cursor", cursor: "ibeam" });
    await wait(() => cursorTheme ? cursorCount() > requests : /set_shape\(\d+, 9\)/.test(logs.host), "text cursor shape");
    const text = cursorTheme ? await screenshot("text") : null;
    send({ type: "cursor", cursor: "none" });
    await wait(() => /wl_pointer@\d+\.set_cursor\(\d+, (?:nil|<anonymous>@0|null)/.test(logs.host), "hidden cursor");
    if (cursorTheme) {
      const hidden = await screenshot("hidden");
      assert.deepEqual(hand.size, text.size); assert.deepEqual(text.size, hidden.size);
      assert.notDeepEqual(hand.pixels, text.pixels, "theme hand/text cursor pixels did not change");
      assert.notDeepEqual(text.pixels, hidden.pixels, "theme text/hidden cursor pixels did not change");
    }
    await movePointer(mapped.x + mapped.w + 60, mapped.y + mapped.h + 60);
    await wait(() => events.some((event) => event.type === "pointer" && event.event === "leave"), "pointer leave");
    send({ type: "cursor", cursor: "grab" });
    requests = cursorCount();
    await movePointer(point.x, point.y);
    await wait(() => cursorTheme ? cursorCount() > requests : /set_shape\(\d+, 16\)/.test(logs.host), "cached grab cursor on re-enter");
    let enterSerial;
    for (const line of logs.host.split("\n")) {
      const enter = /wl_pointer@\d+\.enter(?:\(|, \()(\d+),/.exec(line);
      if (enter) enterSerial = Number(enter[1]);
      const shape = /(?:set_shape|wl_pointer@\d+\.set_cursor)\((\d+),/.exec(line);
      if (shape) assert.equal(Number(shape[1]), enterSerial, "cursor shape used a stale enter serial");
    }
    if (cursorTheme) {
      assert.ok(!logs.host.includes("set_shape("), "cursor-shape was not filtered");
      assert.ok(!/cursor not found|missing enter event serial/i.test(logs.host), "theme icon or enter serial failed");
    }
    console.log(`[overlay-lifecycle] cursor passed: ${cursorTheme ? "legacy Adwaita theme pixels" : "cursor-shape"}, hand, text, hidden and grab with enter serial`);
    } else console.log("[overlay-lifecycle] cursor skipped: surface-only mode");
    const secondary = displays.find(item => item.name !== main.name);
    for (let iteration = 0; iteration < 5; iteration++) {
      if (secondary) { init(secondary.name); await wait(() => mappedOn(secondary.name), "cached frame maps existing output"); }
      send({ type: "hide" }); send({ type: "show" });
      await sleep(120);
      await wait(() => mappedOn(secondary?.name ?? main.name), "hide/show remaps cached frame after configure");
      if (secondary) { init(main.name); await wait(() => mappedOn(main.name), "cached frame returns to main output"); }
      await checkQs();
      console.log(`[overlay-lifecycle] host ${secondary ? "existing output switch and " : ""}hide/show ${iteration + 1}/5 passed`);
    }
    assert.ok(!events.some((event) => event.type === "error"), JSON.stringify(events));
    // Wayland object IDs can be reused; track each role generation in order.
    const roles = new Map(); const configured = new Set(); const attached = new Set(); const layerSurfaces = new Set();
    let attachments = 0;
    for (const line of logs.host.split("\n")) {
      let match = /get_layer_surface\((?:new id )?zwlr_layer_surface_v1@(\d+), wl_surface@(\d+)/.exec(line);
      if (match) { roles.set(match[1], match[2]); layerSurfaces.add(match[2]); configured.delete(match[2]); attached.delete(match[2]); }
      match = /zwlr_layer_surface_v1@(\d+)\.configure(?:\(|,)/.exec(line);
      if (match && roles.has(match[1])) configured.add(roles.get(match[1]));
      match = /wl_surface@(\d+)\.attach\((?:nil|<anonymous>@0|null)/.exec(line);
      if (match) { configured.delete(match[1]); attached.delete(match[1]); }
      match = /wl_surface@(\d+)\.attach\(wl_buffer@/.exec(line);
      if (match && layerSurfaces.has(match[1]) && !attached.has(match[1])) {
        assert.ok(configured.has(match[1]), `buffer committed before configure on surface ${match[1]}`);
        attached.add(match[1]); attachments++;
      }
      match = /wl_surface@(\d+)\.destroy\(/.exec(line);
      if (match) { layerSurfaces.delete(match[1]); configured.delete(match[1]); attached.delete(match[1]); }
    }
    assert.ok(attachments >= 6, `Only ${attachments} surface generations/remaps observed`);
    console.log("[overlay-lifecycle] passed: cached frames, configure ordering, hide/show and Quickshell process stability");
  }
  await checkQs();
  try {
    const result = await exec("coredumpctl", ["--no-pager", "--since", `@${started}`, "list", "quickshell"], { env: { ...env, LC_ALL: "C.UTF-8" }, timeout: 4000 });
    if (/quickshell/.test(result.stdout)) throw new Error(`New host Quickshell coredump: ${result.stdout}`);
  } catch (error) { if (!/No coredumps found/.test(error.stderr ?? "")) throw error; }
} catch (error) {
  console.error(`[overlay-lifecycle] failed: ${error.message}`);
  console.error(`host tail: ${logs.host.slice(-1800)}`);
  process.exitCode = 1;
} finally {
  socket?.destroy(); server?.close();
  if (originalWindow && /^0x[0-9a-f]+$/i.test(originalWindow)) {
    try { await exec("hyprctl", ["-i", env.HYPRLAND_INSTANCE_SIGNATURE, "dispatch", `hl.dsp.focus({window=${JSON.stringify(`address:${originalWindow}`)}})`], {env,timeout:2000}); } catch {}
  }
  if (originalCursor && [originalCursor.x, originalCursor.y].every(Number.isFinite)) {
    try { await exec("hyprctl", ["-i", env.HYPRLAND_INSTANCE_SIGNATURE, "dispatch", `hl.dsp.cursor.move({x=${originalCursor.x},y=${originalCursor.y}})`], {env,timeout:2000}); } catch {}
  }
  for (const child of children.reverse()) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
  }
  await sleep(200);
  for (const child of children) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  if (process.exitCode) {
    for (const [name, data] of Object.entries(logs)) await writeFile(path.join(root, `${name}.log`), data);
    console.error(`[overlay-lifecycle] diagnostics retained at ${root}`);
  } else await rm(root, { recursive: true, force: true });
}

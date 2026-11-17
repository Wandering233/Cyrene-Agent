const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const repo = process.env.CYRENE_TEST_REPO;
const root = process.env.CYRENE_TEST_ROOT;
if (!repo || !root || !process.env.HYPRLAND_INSTANCE_SIGNATURE) throw new Error("Run through verify:linux-window-input");
app.setAppPath(repo);
app.setPath("userData", path.join(root, "data"));
fs.mkdirSync(app.getPath("userData"), { recursive: true });
app.on("window-all-closed", () => {});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = async (condition, label) => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { const result = await condition(); if (result) return result; await sleep(40); }
  throw new Error(`Timeout: ${label}`);
};
const ctl = async (...args) => (await exec("hyprctl", ["-i", process.env.HYPRLAND_INSTANCE_SIGNATURE, ...args], { timeout: 2500 })).stdout;
const clients = async () => JSON.parse(await ctl("-j", "clients"));
const key = async (window, keyCode) => {
  window.webContents.sendInputEvent({ type: "keyDown", keyCode });
  if (keyCode === "Enter") window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode });
  await sleep(100);
};

app.whenReady().then(async () => {
  let menu, overlay;
  const { createIpcScope } = require(path.join(repo, "dist/main/main/application/ipc-scope.js"));
  const ipc = createIpcScope();
  let code = 0;
  try {
    const placement = require(path.join(repo, "dist/main/main/linux/window-placement.js"));
    const open = async (title, bounds, remember = true) => {
      const window = new BrowserWindow({ ...bounds, title, show: false });
      await window.loadURL(`data:text/html,${encodeURIComponent(`<title>${title}</title><body>窗口定位回归</body>`)}`);
      placement.attachHyprlandWindowPlacement(window, title, bounds, remember);
      window.show();
      const client = await wait(async () => (await clients()).find((item) => item.pid === process.pid && item.title === title
        && item.floating && item.at[0] === bounds.x && item.at[1] === bounds.y), "window placement");
      assert.deepEqual(client.size, [bounds.width, bounds.height]);
      return window;
    };
    let window = await open("Cyrene placement regression", { x: 300, y: 160, width: 500, height: 400 });
    const target = (await clients()).find((item) => item.pid === process.pid && item.title === window.getTitle());
    await ctl("dispatch", `hl.dsp.window.move({window=${JSON.stringify(`address:${target.address}`)},x=450,y=230,relative=false})`);
    const recordPath = path.join(app.getPath("userData"), "hyprland-window-bounds.json");
    await wait(() => { try { return JSON.parse(fs.readFileSync(recordPath, "utf8"))[window.getTitle()]?.x === 450; } catch { return false; } }, "user move saved");
    assert.deepEqual(await placement.readWindowBounds(window), { x: 450, y: 230, width: 500, height: 400 });
    window.hide(); window.show(); await sleep(150);
    assert.equal((await placement.readWindowBounds(window)).x, 450);
    window.destroy();
    window = new BrowserWindow({ title: "Cyrene placement regression", show: false });
    await window.loadURL("data:text/html,<title>Cyrene placement regression</title>");
    placement.attachHyprlandWindowPlacement(window, window.getTitle(), { x: 10, y: 10, width: 600, height: 500 }, true);
    window.show();
    await wait(async () => (await placement.readWindowBounds(window))?.x === 450, "restart bounds restored");
    assert.equal((await placement.readWindowBounds(window)).width, 500);
    window.setFullScreen(true);
    await wait(async () => (await clients()).find((item) => item.pid === process.pid && item.title === window.getTitle())?.fullscreen, "fullscreen");
    await sleep(850);
    assert.equal(JSON.parse(fs.readFileSync(recordPath, "utf8"))[window.getTitle()].width, 500);
    window.destroy();
    window = await open("Cyrene tiled restore", {x:300,y:160,width:500,height:400});
    let tiled = (await clients()).find((item)=>item.pid===process.pid&&item.title===window.getTitle());
    await ctl("dispatch", `hl.dsp.window.float({window=${JSON.stringify(`address:${tiled.address}`)},action="disable"})`);
    await wait(()=>{try{return JSON.parse(fs.readFileSync(recordPath,"utf8"))[window.getTitle()]?.floating===false;}catch{return false;}},"tiled mode saved");
    window.destroy();
    window=new BrowserWindow({title:"Cyrene tiled restore",show:false});
    await window.loadURL("data:text/html,<title>Cyrene tiled restore</title>");
    placement.attachHyprlandWindowPlacement(window,window.getTitle(),{x:300,y:160,width:500,height:400},true);
    window.show(); await sleep(500);
    tiled=(await clients()).find((item)=>item.pid===process.pid&&item.title===window.getTitle());
    assert.ok(tiled); assert.equal(tiled.floating,false); window.destroy();

    const monitors=JSON.parse(await ctl("-j","monitors"));
    const secondary=monitors.find(item=>item.x<0&&item.scale===2);
    if(secondary){
      const bounds={x:secondary.x+40,y:secondary.y+20,width:Math.min(500,Math.floor(secondary.width/2)-60),height:Math.min(300,Math.floor(secondary.height/2)-40)};
      window=await open("Cyrene negative placement",bounds);
      assert.deepEqual(await placement.readWindowBounds(window),bounds);window.destroy();
    }else console.log("[window-input] negative 2x output skipped: no existing matching host output");
    console.log("[window-input] placement passed on host: user move, hide/show, restart, tiled mode and fullscreen");

    const { createPetMenuWindow } = require(path.join(repo, "dist/main/main/pet-overlay/pet-menu-window.js"));
    const actions = [];
    menu = createPetMenuWindow({ ipc, openSettings: () => { actions.push("settings"); },
      hidePet: () => { actions.push("hide"); }, quit: () => { actions.push("quit"); } });
    const menuWindow = () => BrowserWindow.getAllWindows().find((item) => item.getTitle() === "Cyrene · 桌宠菜单");
    const active = (window) => window.webContents.executeJavaScript("document.activeElement.dataset.action");
    await menu.open(); window = menuWindow();
    await wait(() => window.isFocused(), "menu focus");
    assert.equal(await active(window), "settings");
    await key(window, "Tab"); assert.equal(await active(window), "hide");
    await key(window, "Down"); assert.equal(await active(window), "quit");
    await key(window, "Up"); assert.equal(await active(window), "hide");
    await key(window, "Space"); await wait(() => window.isDestroyed(), "Space menu action");
    assert.deepEqual(actions, ["hide"]);
    await menu.open(); window = menuWindow(); await wait(() => {
      if (!window || window.isDestroyed()) throw new Error("menu closed after losing host focus");
      return window.isFocused();
    }, "menu reopen focus");
    await key(window, "Enter"); await wait(() => window.isDestroyed(), "Enter menu action");
    assert.deepEqual(actions, ["hide", "settings"]);
    await menu.open(); window = menuWindow(); await wait(() => window.isFocused(), "menu escape focus");
    await key(window, "Escape"); await wait(() => window.isDestroyed(), "Escape closes menu");
    assert.deepEqual(actions, ["hide", "settings"]);
    await menu.open(); window = menuWindow();
    const other = new BrowserWindow({ title: "Cyrene blur test", width: 400, height: 300 });
    other.focus(); await wait(() => window.isDestroyed(), "blur closes menu"); other.destroy();
    menu.dispose(); menu = null;
    console.log("[window-input] menu passed: real Tab, arrows, Space, Enter, Escape and blur");

    // A tiny page drives the actual controller and native host without starting application services.
    const testApp = path.join(root, "input-app");
    fs.mkdirSync(path.join(testApp, "dist/renderer"), { recursive: true });
    fs.symlinkSync(path.join(repo, "dist/preload"), path.join(testApp, "dist/preload"), "dir");
    fs.writeFileSync(path.join(testApp, "dist/renderer/index.html"), `<html><head>
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
      </head><body style="margin:0">
      <button style="width:200px;height:150px;cursor:pointer">touch target</button><script>
      window.stats={downs:0,ups:0,clicks:0};
      window.addEventListener('mousedown',()=>stats.downs++);
      window.addEventListener('mouseup',()=>stats.ups++);
      document.querySelector('button').addEventListener('click',()=>stats.clicks++);
      </script></body></html>`);
    app.setAppPath(testApp);
    const { PetOverlayController } = require(path.join(repo, "dist/main/main/pet-overlay/controller.js"));
    overlay = new PetOverlayController({ isDev: false, binaryPath: process.env.CYRENE_OVERLAY_TEST_HOST ?? path.join(repo, "resources/bin/linux/cyrene-overlay-host"),
      width: 300, height: 240, x: 50, y: 50, zoom: 1, scale: 2, alwaysOnTop: true, showOnReady: false });
    await wait(() => overlay.pageLoaded && overlay.hostReady, "offscreen controller ready");
    const stats = () => overlay.window.webContents.executeJavaScript("window.stats");
    const pointer = async (event) => { overlay.handleHostEvent({ type: "pointer", event, x: 20, y: 30, button: 0x110 }); await sleep(100); };
    await pointer("down"); await pointer("cancel");
    assert.equal((await stats()).downs, 1); assert.equal((await stats()).clicks, 0);
    await pointer("down"); await pointer("up"); assert.equal((await stats()).clicks, 1);
    assert.equal(overlay.getFrameStats().restarts, 0, "native host unexpectedly restarted");
    await pointer("down"); overlay.handleHostFailure(new Error("test host disconnect")); await sleep(100);
    assert.equal((await stats()).clicks, 1);
    console.log("[window-input] offscreen input passed: 2x touch cancel/disconnect never click; next tap clicks once");
  } catch (error) {
    console.error(error);
    console.error("test clients:", JSON.stringify((await clients().catch(() => [])).filter(item => item.pid === process.pid)
      .map(({address,at,size,floating,fullscreen}) => ({address,at,size,floating,fullscreen}))));
    console.error("Electron PID/metrics:", process.pid, JSON.stringify(app.getAppMetrics().map(({pid,type})=>({pid,type}))));
    console.error("Electron displays:", JSON.stringify(require("electron").screen.getAllDisplays()));
    console.error("Electron window states:", BrowserWindow.getAllWindows().map((w)=>({title:w.getTitle(),visible:w.isVisible(),maximized:w.isMaximized(),fullscreen:w.isFullScreen()})));
    code = 1;
  }
  finally {
    overlay?.dispose(); menu?.dispose(); ipc.dispose();
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    app.exit(code);
  }
});

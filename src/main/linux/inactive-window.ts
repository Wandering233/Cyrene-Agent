import type { BrowserWindow } from "electron";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";

const execute = (args: string[]) => new Promise<string>((resolve,reject) => {
  execFile("hyprctl",args,{encoding:"utf8",timeout:2500},(error,stdout)=>{if(error)reject(error);else resolve(stdout);});
});
interface InactiveState { window: BrowserWindow; name: string; title: string; installing: Promise<void>; closed: boolean; showing: boolean; disabling?: Promise<void> }
const states = new WeakMap<BrowserWindow, InactiveState>();
const tracked = new Set<InactiveState>();
const hyprland = () => process.platform === "linux" && Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE);

/** Register a private in-memory rule before mapping the fallback reminder. */
function stateFor(window: BrowserWindow): InactiveState {
  const current = states.get(window);
  if (current) return current;
  const name = `cyrene-inactive-${process.pid}-${randomBytes(16).toString("hex")}`;
  const state: InactiveState = { window, name, title: window.getTitle(), installing: Promise.resolve(), closed: false, showing: false };
  states.set(window,state);
  tracked.add(state);
  window.once("closed", () => {
    void disableRule(state)
      .catch((error) => console.warn("[Hyprland] inactive window rule cleanup failed:",error));
  });
  return state;
}

function disableRule(state: InactiveState): Promise<void> {
  if (state.disabling) return state.disabling;
  state.closed = true;
  state.disabling = (async () => {
    try { await state.installing; } catch { /* disable a possibly partially registered rule */ }
    await execute(["eval", `(function() local rule=hl.window_rule({name=${JSON.stringify(state.name)},enabled=false}); assert(rule:is_enabled()==false,"inactive rule still enabled") end)()`]);
    tracked.delete(state);
  })();
  return state.disabling;
}

export async function disposeInactiveWindowRules(): Promise<void> {
  await Promise.allSettled([...tracked].map(async state => {
    if (!state.window.isDestroyed()) state.window.hide();
    await disableRule(state);
  }));
}

export async function showWindowInactive(window: BrowserWindow, shouldShow: () => boolean = () => true): Promise<void> {
  if (window.isDestroyed() || window.isVisible()) return;
  if (!hyprland()) { if (shouldShow()) window.showInactive(); return; }
  const state = stateFor(window);
  if (state.closed || state.showing) return;
  state.showing = true;
  try {
    // Rules live only in compositor memory; re-register after config reload or remap.
    const selector = JSON.stringify(`^${state.name}$`);
    state.installing = execute(["eval", `hl.window_rule({name=${JSON.stringify(state.name)},enabled=true,match={initial_title=${selector},xwayland=false},no_initial_focus=true,no_focus=true})`]).then(() => {});
    await state.installing;
    if (state.closed || window.isDestroyed() || !shouldShow()) return;
    // A loading document can replace the title before the first xdg map.
    const loadDeadline = Date.now() + 10000;
    while (window.webContents?.isLoadingMainFrame()) {
      if (state.closed || window.isDestroyed() || !shouldShow()) return;
      if (Date.now() >= loadDeadline) throw new Error("HYPRLAND_INACTIVE_WINDOW_LOAD_TIMEOUT");
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    // Hide/show replaces xdg_toplevel; use the private initial title again on every map.
    window.setTitle(state.name);
    window.showInactive();
    for (let attempt=0;attempt<20;attempt++) {
      if (state.closed || window.isDestroyed() || !window.isVisible() || !shouldShow()) return;
      const result = await execute(["-j","clients"]);
      const clients = JSON.parse(result) as Array<{pid:number;initialTitle:string;mapped:boolean;hidden:boolean}>;
      if (clients.some(client=>client.pid===process.pid&&client.initialTitle===state.name&&client.mapped&&!client.hidden)) {
        window.setTitle(state.title); return;
      }
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw new Error("HYPRLAND_INACTIVE_WINDOW_NOT_MAPPED");
  } finally { state.showing = false; }
}

import { app, screen, type BrowserWindow } from "electron";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";

export interface HyprlandClient { address: string; pid: number; title: string; initialTitle?: string; at: number[]; size: number[]; floating: boolean; fullscreen?: number; mapped?: boolean; hidden?: boolean }
export interface WindowBounds { x: number; y: number; width: number; height: number }
const run = (args: string[]): Promise<string> => new Promise((resolve, reject) => {
  execFile("hyprctl", args, { encoding: "utf8", timeout: 2500 }, (error, stdout) => {
    if (error) reject(error); else resolve(stdout);
  });
});

export async function placeHyprlandWindow(client: HyprlandClient, bounds: WindowBounds,
  execute: (args: string[]) => Promise<string> = run, active: () => boolean = () => true): Promise<void> {
  if (!/^0x[0-9a-f]+$/i.test(client.address) || !Object.values(bounds).every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0) throw new Error("Invalid window placement");
  const target = JSON.stringify(`address:${client.address}`);
  // Tiled windows ignore an absolute resize. Float explicitly; resizing then moves the center, so move is last.
  if (!client.floating) {
    if (!active()) return;
    await execute(["dispatch", `hl.dsp.window.float({window=${target},action="enable"})`]);
  }
  if (!active()) return;
  await execute(["dispatch", `hl.dsp.window.resize({window=${target},x=${Math.round(bounds.width)},y=${Math.round(bounds.height)},relative=false})`]);
  if (!active()) return;
  await execute(["dispatch", `hl.dsp.window.move({window=${target},x=${Math.round(bounds.x)},y=${Math.round(bounds.y)},relative=false})`]);
}

function matchClient(clients: HyprlandClient[], window: BrowserWindow, address?: string): HyprlandClient | undefined {
  if (window.isDestroyed()) return;
  clients = clients.filter((item) => /^0x[0-9a-f]+$/i.test(item.address) && item.mapped !== false && !item.hidden);
  if (address) return clients.find((item) => item.address === address && item.pid === process.pid);
  const title = window.getTitle();
  const matches = clients.filter((item) => item.pid === process.pid && (item.initialTitle === title || item.title === title));
  return matches.length === 1 ? matches[0] : undefined;
}

function clientBounds(client: HyprlandClient | undefined): WindowBounds | undefined {
  if (!client || client.at?.length !== 2 || client.size?.length !== 2) return;
  const [x, y] = client.at;
  const [width, height] = client.size;
  if ([x, y, width, height].every(Number.isFinite) && width > 0 && height > 0) return { x, y, width, height };
}

/** Parent windows may report (0, 0) through Electron on Wayland. */
export async function readHyprlandWindowClient(window: BrowserWindow): Promise<HyprlandClient | undefined> {
  if (window.isDestroyed()) return;
  return matchClient(JSON.parse(await run(["-j", "clients"])), window);
}

export async function readWindowBounds(window: BrowserWindow | null): Promise<WindowBounds | undefined> {
  if (!window || window.isDestroyed()) return;
  if (process.platform === "linux" && process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    try { return clientBounds(await readHyprlandWindowClient(window)); }
    catch { return; }
  }
  return window.getBounds();
}

export function fitWindowBounds(bounds: WindowBounds, areas: WindowBounds[]): WindowBounds {
  if (!areas.length) return bounds;
  const overlap = (area: WindowBounds) => Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x))
    * Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y));
  const area = areas.reduce((best, next) => overlap(next) > overlap(best) ? next : best);
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return { x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)), width, height };
}

/** Native Wayland window bounds are read from the compositor, keyed by a verified process/window identity. */
export function attachHyprlandWindowPlacement(window: BrowserWindow, key: string, initial: WindowBounds, remember: boolean): void {
  if (process.platform !== "linux" || !process.env.HYPRLAND_INSTANCE_SIGNATURE) return;
  const file = path.join(app.getPath("userData"), "hyprland-window-bounds.json");
  let bounds = initial;
  let floating = true;
  if (remember) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"))[key];
      if (saved && [saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)
        && saved.width >= 200 && saved.height >= 150) {
        bounds = { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
        floating = saved.floating !== false;
      }
    } catch { /* first launch */ }
  }
  const displays = screen.getAllDisplays();
  const visible = displays.some((display) => bounds.x + bounds.width > display.workArea.x
    && bounds.x < display.workArea.x + display.workArea.width && bounds.y + bounds.height > display.workArea.y
    && bounds.y < display.workArea.y + display.workArea.height);
  if (!visible) bounds = initial;
  bounds = fitWindowBounds(bounds, displays.map((display) => display.workArea));
  let stopped = false;
  let pending: NodeJS.Timeout | undefined;
  let address: string | undefined;
  let attempts = 0;
  let placed = false;
  let generation = 0;
  const client = async (): Promise<HyprlandClient | undefined> => {
    const currentAddress = address;
    const clients: HyprlandClient[] = JSON.parse(await run(["-j", "clients"]));
    return matchClient(clients, window, currentAddress);
  };
  const active = () => !stopped && !window.isDestroyed() && window.isVisible();
  const place = async (epoch: number) => {
    if (stopped || window.isDestroyed() || epoch !== generation) return;
    try {
      const item = await client();
      if (stopped || window.isDestroyed() || epoch !== generation) return;
      if (item) {
        address = item.address;
        // Hyprland marks normal tiled windows as maximized in xdg configure.
        // Its own fullscreen field distinguishes actual fullscreen/maximized modes.
        if (!item.fullscreen && !window.isFullScreen()) {
          if (floating) await placeHyprlandWindow(item, bounds, run, () => active() && epoch === generation);
          else if (item.floating && active()) await run(["dispatch", `hl.dsp.window.float({window=${JSON.stringify(`address:${item.address}`)},action="disable"})`]);
        }
        if (epoch !== generation) return;
        placed = true;
        return;
      }
    } catch (error) { console.warn("[Hyprland] window placement failed:", error); }
    if (epoch === generation && ++attempts < 10) pending = setTimeout(() => { void place(epoch); }, 100);
  };
  window.on("show", () => {
    // Native Wayland hide/show can replace the xdg_toplevel and its address.
    clearTimeout(pending); address = undefined; attempts = 0; placed = false;
    void place(++generation);
  });
  let sampling = false;
  const sample = setInterval(async () => {
    if (!active() || sampling || !remember || !address || !placed) return;
    sampling = true;
    const epoch = generation;
    try {
      const item = await client();
      if (!active() || epoch !== generation) return;
      if (item?.fullscreen || window.isFullScreen()) return;
      const next = clientBounds(item);
      if (!next || next.width < 200 || next.height < 150) return;
      if (JSON.stringify(next) === JSON.stringify(bounds) && floating === item?.floating) return;
      let records: Record<string, unknown> = {};
      try { records = JSON.parse(readFileSync(file, "utf8")); } catch { /* first save */ }
      mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ ...records, [key]: { ...next, floating: item!.floating } }), { mode: 0o600 });
      renameSync(temporary, file);
      bounds = next;
      floating = item!.floating;
    } catch { /* compositor exits before application */ }
    finally { sampling = false; }
  }, 750);
  sample.unref();
  window.once("closed", () => { stopped = true; clearTimeout(pending); clearInterval(sample); });
}

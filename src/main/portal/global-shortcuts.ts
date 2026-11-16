import { installDbusCompat } from "../platform/dbus-compat";

export interface PortalShortcut {
  id: string;
  description: string;
  preferredTrigger?: string;
}

export interface PortalActivation {
  shortcutId: string;
  timestamp: number;
}

const PORTAL_BUS = "org.freedesktop.portal.Desktop";
const PORTAL_PATH = "/org/freedesktop/portal/desktop";
const SHORTCUTS_INTERFACE = "org.freedesktop.portal.GlobalShortcuts";
const REQUEST_INTERFACE = "org.freedesktop.portal.Request";
const SESSION_INTERFACE = "org.freedesktop.portal.Session";
const RESPONSE_MATCH = `type='signal',interface='${REQUEST_INTERFACE}',member='Response'`;
const SESSION_XML = `<?xml version="1.0"?>
<node><interface name="org.freedesktop.portal.Session"><method name="Close"/></interface></node>`;

interface RequestResponse {
  response: number;
  results: Record<string, unknown>;
}

/** Convert an Electron accelerator to the portal trigger syntax. */
export function toPortalTrigger(accelerator: string): string | null {
  const parts = accelerator.split("+").map((part) => part.trim()).filter(Boolean);
  const mods: string[] = [];
  let key: string | null = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "alt" || lower === "option") mods.push("ALT");
    else if (lower === "shift") mods.push("SHIFT");
    else if (["control", "ctrl", "commandorcontrol", "cmdorctrl"].includes(lower)) mods.push("CTRL");
    else if (["super", "meta", "command", "cmd"].includes(lower)) mods.push("LOGO");
    else key = part.length === 1 ? part.toUpperCase() : part;
  }
  if (!key || mods.length === 0) return null;
  return [...mods, key].join("+");
}

/**
 * xdg-desktop-portal GlobalShortcuts client.
 *
 * The portal owns the actual key grab, so this works on Wayland without X11
 * grabs. It requires the portal to resolve an app id for the caller; packaged
 * desktop installs satisfy that, while bare dev Electron may not.
 */
export class GlobalShortcutsPortal {
  private bus: any = null;
  private portal: any = null;
  private daemon: any = null;
  private dbus: any = null;
  private sessionHandle: string | null = null;
  private readonly responses = new Map<string, RequestResponse>();
  private listeners = new Set<(activation: PortalActivation) => void>();
  private closed = false;

  async bind(shortcuts: PortalShortcut[]): Promise<void> {
    installDbusCompat();
    const dbus = await import("dbus-next") as unknown as typeof import("dbus-next");
    this.dbus = dbus;
    const bus = dbus.sessionBus();
    this.bus = bus;
    bus.on("message", this.onMessage);
    const daemonObject = await bus.getProxyObject("org.freedesktop.DBus", "/org/freedesktop/DBus");
    this.daemon = daemonObject.getInterface("org.freedesktop.DBus");
    await this.daemon.AddMatch(RESPONSE_MATCH);
    await this.daemon.AddMatch(
      `type='signal',interface='${SHORTCUTS_INTERFACE}',member='Activated'`,
    );

    const portalObject = await bus.getProxyObject(PORTAL_BUS, PORTAL_PATH);
    this.portal = portalObject.getInterface(SHORTCUTS_INTERFACE);
    // Some dbus-next/compositor combinations do not surface portal proxy
    // signals reliably; the low-level message hook below is authoritative.

    const sessionResponse = await this.callRequest("CreateSession", [{
      handle_token: new dbus.Variant("s", this.token("session")),
      session_handle_token: new dbus.Variant("s", this.token("id")),
    }]);
    const value = sessionResponse.session_handle as { value?: unknown } | string | undefined;
    const handle = typeof value === "string" ? value : typeof value?.value === "string" ? value.value : undefined;
    if (!handle) throw new Error("GlobalShortcuts CreateSession returned no session handle");
    this.sessionHandle = handle;

    await this.callRequest("BindShortcuts", [
      handle,
      shortcuts.map((shortcut) => [
        shortcut.id,
        {
          description: new dbus.Variant("s", shortcut.description),
          ...(shortcut.preferredTrigger
            ? { preferred_trigger: new dbus.Variant("s", shortcut.preferredTrigger) }
            : {}),
        },
      ]),
      "",
      { handle_token: new dbus.Variant("s", this.token("bind")) },
    ]);
  }

  onActivated(listener: (activation: PortalActivation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const bus = this.bus;
    const handle = this.sessionHandle;
    this.sessionHandle = null;
    if (bus && handle) {
      try {
        const object = await bus.getProxyObject(PORTAL_BUS, handle, SESSION_XML);
        await object.getInterface(SESSION_INTERFACE).Close();
      } catch { /* session already gone */ }
    }
    try { await this.daemon?.RemoveMatch(RESPONSE_MATCH); } catch { /* ignore */ }
    try {
      await this.daemon?.RemoveMatch(
        `type='signal',interface='${SHORTCUTS_INTERFACE}',member='Activated'`,
      );
    } catch { /* ignore */ }
    try { bus?.off("message", this.onMessage); } catch { /* ignore */ }
    try { bus?.disconnect(); } catch { /* ignore */ }
    this.bus = null;
    this.portal = null;
    this.daemon = null;
    this.listeners.clear();
    this.responses.clear();
  }

  private readonly onMessage = (message: any): void => {
    if (message.type !== this.dbus?.MessageType.SIGNAL) return;
    if (message.interface === SHORTCUTS_INTERFACE && message.member === "Activated") {
      const [, shortcutId, timestamp] = message.body as [string, string, number];
      console.info("[GlobalShortcuts] activated", shortcutId);
      for (const listener of this.listeners) listener({ shortcutId, timestamp });
      return;
    }
    if (message.interface !== REQUEST_INTERFACE || message.member !== "Response") return;
    const [response, results] = message.body as [number, Record<string, unknown>];
    this.responses.set(message.path, { response, results: results ?? {} });
  };

  private async callRequest(method: "CreateSession" | "BindShortcuts", args: unknown[]): Promise<Record<string, unknown>> {
    if (!this.portal) throw new Error("GlobalShortcuts portal not connected");
    const result = await this.portal[method](...args) as string | [string];
    const handle = Array.isArray(result) ? result[0] : result;
    if (typeof handle !== "string" || !handle.startsWith("/")) {
      throw new Error(`GlobalShortcuts ${method} returned an invalid request handle`);
    }
    const response = await this.waitForResponse(handle);
    if (response.response !== 0) {
      throw new Error(`GlobalShortcuts ${method} failed with response ${response.response}`);
    }
    return response.results;
  }

  private waitForResponse(handle: string, timeoutMs = 120_000): Promise<RequestResponse> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const existing = this.responses.get(handle);
      if (existing) {
        this.responses.delete(handle);
        resolve(existing);
        return;
      }
      const timer = setInterval(() => {
        const response = this.responses.get(handle);
        if (response) {
          clearInterval(timer);
          this.responses.delete(handle);
          resolve(response);
          return;
        }
        if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error("GlobalShortcuts request timed out"));
        }
      }, 25);
    });
  }

  private token(prefix: string): string {
    return `cyrene_${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

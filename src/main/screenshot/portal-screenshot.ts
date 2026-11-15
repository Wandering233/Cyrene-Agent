import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Message } from "dbus-next";
import { installDbusCompat } from "../platform/dbus-compat";

export interface PortalScreenshotOptions {
  /** Ask the portal's own UI to let the user choose area/window/screen. */
  interactive?: boolean;
  /** Portal request timeout; a screen-share picker can stay open for a while. */
  timeoutMs?: number;
}

export interface PortalScreenshotResult {
  filePath: string;
  uri: string;
}

const PORTAL_BUS = "org.freedesktop.portal.Desktop";
const PORTAL_PATH = "/org/freedesktop/portal/desktop";
const SCREENSHOT_INTERFACE = "org.freedesktop.portal.Screenshot";
const REQUEST_INTERFACE = "org.freedesktop.portal.Request";
const RESPONSE_MATCH =
  `type='signal',interface='${REQUEST_INTERFACE}',member='Response'`;

export class PortalScreenshotError extends Error {
  constructor(
    readonly code:
      | "PORTAL_UNAVAILABLE"
      | "SCREENSHOT_CANCELLED"
      | "SCREENSHOT_FAILED"
      | "SCREENSHOT_TIMEOUT",
    message: string,
  ) {
    super(message);
    this.name = "PortalScreenshotError";
  }
}

interface PortalResponse {
  response: number;
  results: Record<string, unknown>;
}

/**
 * Capture a screenshot through xdg-desktop-portal.
 *
 * This is the cross-desktop Wayland path: no X11, no native helper, no
 * assumption about Hyprland/KDE/GNOME-specific tools. The portal may show its
 * own selection UI when `interactive` is true and may write the image to the
 * user's Pictures directory; callers should copy it into app storage.
 */
export async function captureScreenshotViaPortal(
  options: PortalScreenshotOptions = {},
): Promise<PortalScreenshotResult> {
  const interactive = options.interactive ?? false;
  const timeoutMs = options.timeoutMs ?? 120_000;
  installDbusCompat();
  const dbus = await import("dbus-next") as unknown as typeof import("dbus-next");
  const bus = dbus.sessionBus();

  try {
    const portalObject = await bus.getProxyObject(PORTAL_BUS, PORTAL_PATH);
    const screenshot = portalObject.getInterface(SCREENSHOT_INTERFACE);

    // Subscribe to Request.Response at the D-Bus message level before making
    // the call. Portal request objects are dynamic and cannot always be
    // introspected, and a non-interactive response can arrive before a
    // post-call proxy would be ready.
    const responses = new Map<string, PortalResponse>();
    const onMessage = (message: Message) => {
      if (
        message.type === dbus.MessageType.SIGNAL
        && message.interface === REQUEST_INTERFACE
        && message.member === "Response"
      ) {
        const [response, results] = message.body as [number, Record<string, unknown>];
        responses.set(message.path, { response, results: results ?? {} });
      }
    };
    bus.on("message", onMessage);

    const daemonObject = await bus.getProxyObject("org.freedesktop.DBus", "/org/freedesktop/DBus");
    const daemon = daemonObject.getInterface("org.freedesktop.DBus");
    await daemon.AddMatch(RESPONSE_MATCH);

    const token = `cyrene_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const rawHandle = await screenshot.Screenshot("", {
      handle_token: new dbus.Variant("s", token),
      interactive: new dbus.Variant("b", interactive),
      modal: new dbus.Variant("b", true),
    });
    // dbus-next may return a single out-argument directly or wrapped in an array.
    const handle = Array.isArray(rawHandle) ? rawHandle[0] : rawHandle;
    if (typeof handle !== "string" || !handle.startsWith("/")) {
      throw new PortalScreenshotError(
        "SCREENSHOT_FAILED",
        `portal returned an invalid request handle: ${String(handle)}`,
      );
    }

    let interval: NodeJS.Timeout | null = null;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (interval) clearInterval(interval);
      bus.off("message", onMessage);
      void daemon.RemoveMatch(RESPONSE_MATCH).catch(() => {});
    };

    return await new Promise<PortalScreenshotResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new PortalScreenshotError(
          "SCREENSHOT_TIMEOUT",
          `screenshot portal did not respond within ${timeoutMs}ms`,
        ));
      }, timeoutMs);
      timer.unref?.();

      const finish = (response: PortalResponse) => {
        cleanup();
        clearTimeout(timer);
        if (response.response === 1) {
          reject(new PortalScreenshotError("SCREENSHOT_CANCELLED", "screenshot cancelled"));
          return;
        }
        if (response.response !== 0) {
          reject(new PortalScreenshotError(
            "SCREENSHOT_FAILED",
            `screenshot portal response ${response.response}`,
          ));
          return;
        }
        const uriValue = response.results.uri as { value?: unknown } | string | undefined;
        const uri = typeof uriValue === "string"
          ? uriValue
          : typeof uriValue?.value === "string"
            ? uriValue.value
            : undefined;
        if (!uri || !uri.startsWith("file:")) {
          reject(new PortalScreenshotError(
            "SCREENSHOT_FAILED",
            `screenshot portal returned no file URI: ${String(uri)}`,
          ));
          return;
        }
        let filePath: string;
        try {
          filePath = fileURLToPath(uri);
        } catch (error) {
          reject(new PortalScreenshotError(
            "SCREENSHOT_FAILED",
            `invalid screenshot URI: ${error instanceof Error ? error.message : String(error)}`,
          ));
          return;
        }
        if (!existsSync(filePath)) {
          reject(new PortalScreenshotError(
            "SCREENSHOT_FAILED",
            `screenshot file does not exist: ${filePath}`,
          ));
          return;
        }
        resolve({ filePath, uri });
      };

      const existing = responses.get(handle);
      if (existing) {
        finish(existing);
        return;
      }
      interval = setInterval(() => {
        const response = responses.get(handle);
        if (response) finish(response);
      }, 25);
      interval.unref?.();
    });
  } catch (error) {
    if (error instanceof PortalScreenshotError) throw error;
    throw new PortalScreenshotError(
      "PORTAL_UNAVAILABLE",
      `xdg-desktop-portal Screenshot unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    try { bus.disconnect(); } catch { /* ignore */ }
  }
}

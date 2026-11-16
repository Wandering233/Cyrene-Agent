import { chmodSync, mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  isControlCommand,
  resolveControlSocketPath,
  type ControlCommand,
} from "../../shared/control-socket";

export interface ControlServerHandlers {
  "show-chat"(): void | Promise<void>;
  "show-settings"(): void | Promise<void>;
  "toggle-pet"(): void | Promise<void>;
  screenshot?(): void | Promise<void>;
  quit(): void | Promise<void>;
}

let screenshotHandler: (() => void | Promise<void>) | null = null;
let screenshotWindowHandler: (() => void | Promise<void>) | null = null;
let toastTestHandler: (() => void | Promise<void>) | null = null;

/** Register the screenshot action after the core screenshot service exists. */
export function setScreenshotWindowControlHandler(
  handler: (() => void | Promise<void>) | null,
): void {
  screenshotWindowHandler = handler;
}

export function setToastTestControlHandler(
  handler: (() => void | Promise<void>) | null,
): void {
  toastTestHandler = handler;
}

export function setScreenshotControlHandler(
  handler: (() => void | Promise<void>) | null,
): void {
  screenshotHandler = handler;
}

export interface ControlServer {
  socketPath: string;
  close(): void;
}

/**
 * Tiny local control channel used when the desktop has no tray host.
 *
 * The socket is per-user (0600), line-oriented, and intentionally not a
 * general IPC surface: only the fixed commands below are accepted.
 */
export function startControlServer(
  handlers: ControlServerHandlers,
  socketPath = resolveControlSocketPath(),
): ControlServer {
  try {
    mkdirSync(path.dirname(socketPath), { recursive: true });
    rmSync(socketPath, { force: true });
  } catch {
    // The listen below reports the actionable error.
  }

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line) void handle(line, socket);
      }
    });
    socket.on("error", () => { /* client disconnected */ });
  });

  async function handle(command: string, socket: net.Socket): Promise<void> {
    if (!isControlCommand(command) || command === "ping") {
      if (command === "ping") {
        socket.write(JSON.stringify({ ok: true, command }) + "\n");
        return;
      }
      socket.write(JSON.stringify({ ok: false, error: "unknown command" }) + "\n");
      return;
    }
    try {
      if (command === "screenshot") {
        if (!screenshotHandler) throw new Error("screenshot backend not ready");
        await screenshotHandler();
      } else if (command === "screenshot-window") {
        if (!screenshotWindowHandler) throw new Error("screenshot backend not ready");
        await screenshotWindowHandler();
      } else if (command === "toast-test") {
        if (!toastTestHandler) throw new Error("toast backend not ready");
        await toastTestHandler();
      } else {
        await handlers[command as Exclude<ControlCommand, "ping" | "screenshot" | "screenshot-window" | "toast-test">]();
      }
      socket.write(JSON.stringify({ ok: true, command }) + "\n");
    } catch (error) {
      socket.write(JSON.stringify({
        ok: false,
        command,
        error: error instanceof Error ? error.message : String(error),
      }) + "\n");
    }
  }

  server.listen(socketPath, () => {
    try { chmodSync(socketPath, 0o600); } catch { /* best effort */ }
    console.log("[Control] listening on", socketPath);
  });
  server.on("error", (error) => {
    console.error("[Control] server error:", error);
  });

  let closed = false;
  return {
    socketPath,
    close() {
      if (closed) return;
      closed = true;
      server.close();
      try { rmSync(socketPath, { force: true }); } catch { /* ignore */ }
    },
  };
}

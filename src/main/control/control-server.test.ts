import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setScreenshotControlHandler, startControlServer } from "./control-server";

const tempDirs: string[] = [];

function makeSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-control-test-"));
  tempDirs.push(dir);
  return path.join(dir, "control.sock");
}

function send(socketPath: string, command: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${command}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as Record<string, unknown>);
    });
    socket.on("error", reject);
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("control socket", () => {
  it("accepts the fixed commands and rejects unknown ones", async () => {
    const socketPath = makeSocketPath();
    const showChat = vi.fn();
    const server = startControlServer({
      "show-chat": showChat,
      "show-settings": vi.fn(),
      "toggle-pet": vi.fn(),
      quit: vi.fn(),
    }, socketPath);

    try {
      await expect(send(socketPath, "ping")).resolves.toEqual({ ok: true, command: "ping" });
      await expect(send(socketPath, "show-chat")).resolves.toEqual({ ok: true, command: "show-chat" });
      expect(showChat).toHaveBeenCalledTimes(1);
      await expect(send(socketPath, "rm -rf /")).resolves.toEqual({
        ok: false,
        error: "unknown command",
      });
    } finally {
      server.close();
    }
  });

  it("routes the screenshot command to the registered handler", async () => {
    const socketPath = makeSocketPath();
    const screenshot = vi.fn();
    setScreenshotControlHandler(screenshot);
    const server = startControlServer({
      "show-chat": vi.fn(),
      "show-settings": vi.fn(),
      "toggle-pet": vi.fn(),
      quit: vi.fn(),
    }, socketPath);
    try {
      await expect(send(socketPath, "screenshot")).resolves.toEqual({ ok: true, command: "screenshot" });
      expect(screenshot).toHaveBeenCalledTimes(1);
    } finally {
      server.close();
      setScreenshotControlHandler(null);
    }
  });

  it("creates a 0600 socket and removes it on close", async () => {
    const socketPath = makeSocketPath();
    const server = startControlServer({
      "show-chat": vi.fn(),
      "show-settings": vi.fn(),
      "toggle-pet": vi.fn(),
      quit: vi.fn(),
    }, socketPath);
    try {
      for (let i = 0; i < 50; i += 1) {
        if (fs.existsSync(socketPath) && (fs.statSync(socketPath).mode & 0o777) === 0o600) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
    } finally {
      server.close();
    }
    expect(fs.existsSync(socketPath)).toBe(false);
  });
});

import { spawn, type ChildProcess } from "node:child_process";
import { chmod, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  encodeControl,
  encodeFrameHeader,
  parseHostEvent,
  type ControlMessage,
  type HostEvent,
} from "./protocol";

export interface OverlayHostCallbacks {
  onEvent(event: HostEvent): void;
  onFailure(error: Error): void;
  onLog(message: string): void;
}

interface StartWaiter {
  resolve(): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * Owns the native `cyrene-overlay-host` process and its Unix socket.
 *
 * Electron is the server: it creates a per-process socket in the temp
 * directory, spawns the host with that path, and the host connects back. This
 * makes process startup ordering explicit and keeps stale sockets bounded to
 * one process.
 */
export class PetOverlayHostClient {
  private readonly socketPath: string;
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private child: ChildProcess | null = null;
  private lineBuffer = "";
  private ready = false;
  private stopped = false;
  private waiter: StartWaiter | null = null;
  private readonly callbacks: OverlayHostCallbacks;

  constructor(
    private readonly binaryPath: string,
    callbacks: OverlayHostCallbacks,
    private readonly extraArgs: string[] = [],
  ) {
    this.socketPath = path.join(
      os.tmpdir(),
      `cyrene-overlay-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.sock`,
    );
    this.callbacks = callbacks;
  }

  get socketFilePath(): string {
    return this.socketPath;
  }

  async start(timeoutMs = 8000): Promise<void> {
    await rm(this.socketPath, { force: true });

    const server = net.createServer((socket) => this.attachSocket(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    // The socket only serves this app's host process; keep other local users
    // from injecting frames or pointer events.
    await chmod(this.socketPath, 0o600);

    const readyPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`overlay host did not become ready within ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiter = { resolve, reject, timer };
    });

    const child = spawn(this.binaryPath, ["--socket", this.socketPath, ...this.extraArgs], {
      stdio: ["ignore", "ignore", "pipe"],
      env: process.env,
    });
    this.child = child;

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) this.callbacks.onLog(line);
      }
    });
    child.once("error", (error) => {
      this.fail(new Error(`failed to spawn overlay host: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      if (this.stopped) return;
      this.fail(
        new Error(`overlay host exited (code=${code}, signal=${signal})`),
      );
    });

    try {
      await readyPromise;
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  sendControl(message: ControlMessage): void {
    const socket = this.socket;
    if (!socket || socket.destroyed) return;
    socket.write(encodeControl(message));
  }

  /**
   * Returns false when the frame should be dropped (host not ready or the
   * socket is falling behind). Frames are disposable; stale frames are worse
   * than a dropped frame.
   */
  sendFrame(seq: number, bitmap: Buffer, width: number, height: number): boolean {
    const socket = this.socket;
    if (!this.ready || !socket || socket.destroyed) return false;
    if (socket.writableLength > bitmap.length * 2) return false;

    const stride = bitmap.length / height;
    socket.write(encodeFrameHeader(seq, width, height, stride));
    socket.write(bitmap);
    return true;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    this.rejectWaiter(new Error("overlay host stopped"));

    this.sendControl({ type: "quit" });
    this.socket?.end();
    this.socket?.destroy();
    this.socket = null;

    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 750).unref();
    }

    this.server?.close();
    this.server = null;
    void rm(this.socketPath, { force: true }).catch(() => {});
  }

  private attachSocket(socket: net.Socket): void {
    if (this.socket) {
      socket.destroy();
      return;
    }
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.handleChunk(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
    });
  }

  private handleChunk(chunk: string): void {
    this.lineBuffer += chunk;
    let newline = this.lineBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.lineBuffer.slice(0, newline);
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      const event = parseHostEvent(line);
      if (event) this.handleEvent(event);
      newline = this.lineBuffer.indexOf("\n");
    }
  }

  private handleEvent(event: HostEvent): void {
    if (event.type === "ready") {
      this.ready = true;
      this.waiter?.resolve();
      this.clearWaiter();
    } else if (event.type === "error") {
      this.fail(new Error(`${event.code}: ${event.message}`));
    }
    this.callbacks.onEvent(event);
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    this.rejectWaiter(error);
    this.callbacks.onFailure(error);
  }

  private rejectWaiter(error: Error): void {
    if (!this.waiter) return;
    this.waiter.reject(error);
    this.clearWaiter();
  }

  private clearWaiter(): void {
    if (!this.waiter) return;
    clearTimeout(this.waiter.timer);
    this.waiter = null;
  }
}

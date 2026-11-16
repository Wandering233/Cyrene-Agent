#!/usr/bin/env node
/**
 * Verify the native host closes a mismatched protocol version instead of
 * silently accepting frames. Requires a live Wayland session.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const host = path.resolve(process.argv[2] ?? "resources/bin/linux/cyrene-overlay-host");
const socketPath = path.join(os.tmpdir(), `cyrene-mismatch-${process.pid}.sock`);
try { fs.unlinkSync(socketPath); } catch {}

const timeout = setTimeout(() => {
  console.error("[overlay-protocol] timeout waiting for PROTOCOL_MISMATCH");
  child?.kill();
  server.close();
  process.exit(1);
}, 5000);

let child = null;
const server = net.createServer((socket) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === "ready") {
        socket.write(JSON.stringify({
          type: "init", protocol: 99, width: 400, height: 500, x: 0, y: 0, scale: 1,
        }) + "\n");
      }
      if (event.type === "error" && event.code === "PROTOCOL_MISMATCH") {
        clearTimeout(timeout);
        console.log("[overlay-protocol] ok: PROTOCOL_MISMATCH");
        socket.destroy();
        server.close();
        child?.kill();
        process.exit(0);
      }
    }
  });
});

server.listen(socketPath, () => {
  child = spawn(host, ["--socket", socketPath], { stdio: ["ignore", "ignore", "inherit"] });
  child.once("error", (error) => {
    console.error("[overlay-protocol] spawn failed:", error.message);
    clearTimeout(timeout);
    process.exit(1);
  });
});

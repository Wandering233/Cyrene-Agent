import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PetOverlayHostClient } from "./host-client";

const tempDirs: string[] = [];

function makeFakeHost(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-host-client-test-"));
  tempDirs.push(dir);
  const script = path.join(dir, "fake-host.mjs");
  fs.writeFileSync(script, `#!/usr/bin/env node
import net from "node:net";
const index = process.argv.indexOf("--socket");
const socketPath = process.argv[index + 1];
const socket = net.createConnection(socketPath);
socket.setEncoding("utf8");
socket.write(JSON.stringify({ type: "ready", protocol: 1, width: 400, height: 500, output: "TEST-1", scale: 1 }) + "\\n");
let buffer = "";
socket.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.type === "init") {
      socket.write(JSON.stringify({ type: "pointer", event: "enter", x: 12, y: 34 }) + "\\n");
    }
    if (message.type === "quit") process.exit(0);
  }
});
socket.on("error", () => process.exit(1));
`, { mode: 0o755 });
  return script;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("PetOverlayHostClient", () => {
  it("starts the host, sends init, receives pointer events and cleans up", async () => {
    const script = makeFakeHost();
    const events: unknown[] = [];
    const failures: Error[] = [];
    const client = new PetOverlayHostClient(script, {
      onEvent: (event) => events.push(event),
      onFailure: (error) => failures.push(error),
      onLog: () => {},
    });

    // A stale socket from a crashed previous process must be removed before
    // server.listen(); otherwise start() would fail with EADDRINUSE.
    fs.writeFileSync(client.socketFilePath, "stale");
    await client.start(3000);
    expect(fs.statSync(client.socketFilePath).mode & 0o777).toBe(0o600);
    client.sendControl({
      type: "init", protocol: 1, width: 400, height: 500, x: 10, y: 20, scale: 1,
    });
    await vi.waitFor(() => {
      expect(events.some((event) => (event as { type?: string }).type === "pointer")).toBe(true);
    });
    client.stop();
    expect(failures).toHaveLength(0);
    expect(fs.existsSync(client.socketFilePath)).toBe(false);
  });
});

describe("PetOverlayHostClient multi-instance", () => {
  it("allocates a unique socket path per client", () => {
    const callbacks = { onEvent: () => {}, onFailure: () => {}, onLog: () => {} };
    const first = new PetOverlayHostClient(makeFakeHost(), callbacks);
    const second = new PetOverlayHostClient(makeFakeHost(), callbacks);
    expect(first.socketFilePath).not.toBe(second.socketFilePath);
    expect(first.socketFilePath).toContain(`cyrene-overlay-${process.pid}-`);
  });
});

describe("PetOverlayHostClient failure paths", () => {
  it("reports a host error event and rejects startup", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-host-error-test-"));
    tempDirs.push(dir);
    const script = path.join(dir, "error-host.mjs");
    fs.writeFileSync(script, `#!/usr/bin/env node
import net from "node:net";
const i = process.argv.indexOf("--socket");
const socket = net.createConnection(process.argv[i + 1]);
socket.write(JSON.stringify({ type: "error", code: "PROTOCOL_MISMATCH", message: "client 2 host 1" }) + "\\n");
setTimeout(() => process.exit(0), 2000);
`, { mode: 0o755 });
    const failures: Error[] = [];
    const client = new PetOverlayHostClient(script, {
      onEvent: () => {},
      onFailure: (error) => failures.push(error),
      onLog: () => {},
    });

    await expect(client.start(1000)).rejects.toThrow(/PROTOCOL_MISMATCH/);
    expect(failures.length).toBeGreaterThan(0);
    client.stop();
  });

  it("rejects when the host never becomes ready", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-host-timeout-test-"));
    tempDirs.push(dir);
    const script = path.join(dir, "slow-host.mjs");
    fs.writeFileSync(script, `#!/usr/bin/env node
import net from "node:net";
const i = process.argv.indexOf("--socket");
net.createConnection(process.argv[i + 1]);
setTimeout(() => process.exit(0), 3000);
`, { mode: 0o755 });
    const client = new PetOverlayHostClient(script, {
      onEvent: () => {}, onFailure: () => {}, onLog: () => {},
    });
    await expect(client.start(200)).rejects.toThrow(/did not become ready/);
    client.stop();
  });
});

describe("PetOverlayHostClient spawn failures", () => {
  it("rejects when the binary cannot be spawned", async () => {
    const failures: Error[] = [];
    const client = new PetOverlayHostClient("/definitely/not/a/host", {
      onEvent: () => {}, onFailure: (error) => failures.push(error), onLog: () => {},
    });
    await expect(client.start(500)).rejects.toThrow();
    expect(failures.length).toBeGreaterThan(0);
    client.stop();
  });

  it("rejects when the host exits before ready", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-host-exit-test-"));
    tempDirs.push(dir);
    const script = path.join(dir, "exit-host.mjs");
    fs.writeFileSync(script, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o755 });
    const client = new PetOverlayHostClient(script, {
      onEvent: () => {}, onFailure: () => {}, onLog: () => {},
    });
    await expect(client.start(1000)).rejects.toThrow();
    client.stop();
  });
});

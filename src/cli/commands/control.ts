import net from "node:net";
import {
  CONTROL_COMMANDS,
  isControlCommand,
  resolveControlSocketPath,
} from "../../shared/control-socket.js";
import { errLine, outLine } from "../util/log.js";

/** Send one command to the running app's local control socket. */
export async function cmdControl(command: string): Promise<number> {
  if (!command) {
    errLine(`cyrene control: missing command. Choose one of: ${CONTROL_COMMANDS.join(", ")}`);
    return 2;
  }
  if (!isControlCommand(command)) {
    errLine(`cyrene control: unknown command '${command}'. Choose one of: ${CONTROL_COMMANDS.join(", ")}`);
    return 2;
  }

  return await new Promise<number>((resolve) => {
    const socket = net.createConnection(resolveControlSocketPath());
    let buffer = "";
    const done = (code: number): void => {
      socket.destroy();
      resolve(code);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(3000, () => {
      errLine("cyrene control: Cyrene is not running (control socket timeout).");
      done(1);
    });
    socket.on("connect", () => {
      socket.write(`${command}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const line = buffer.slice(0, buffer.indexOf("\n"));
      try {
        const response = JSON.parse(line) as { ok?: boolean; error?: string };
        if (response.ok) {
          outLine(`ok: ${command}`);
          done(0);
        } else {
          errLine(`cyrene control: ${response.error ?? "command failed"}`);
          done(1);
        }
      } catch {
        errLine(`cyrene control: invalid response: ${line}`);
        done(1);
      }
    });
    socket.on("error", (error) => {
      errLine(`cyrene control: ${error.message}`);
      done(1);
    });
  });
}

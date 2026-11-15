import Module from "node:module";
import net from "node:net";
import util from "node:util";

/**
 * dbus-next's optional native `usocket` dependency is incompatible with
 * Electron's Node 24 (it still calls the removed `util.isError`, and its
 * native addon can SIGTRAP the renderer/main process). Portal calls need a
 * plain AF_UNIX socket, so route `require("usocket")` to this small net.Socket
 * adapter before dbus-next is loaded. Fd-passing APIs are intentionally not
 * emulated; screenshot/global-shortcut portal calls do not use them.
 */
class USocket extends net.Socket {
  private readonly socketPath: string | undefined;

  constructor(options?: { path?: string }) {
    super();
    this.socketPath = options?.path;
    if (this.socketPath) {
      setImmediate(() => {
        try {
          this.connect(this.socketPath!);
        } catch (error) {
          this.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }
  }
}

let installed = false;

export function installDbusCompat(): void {
  if (installed) return;
  installed = true;

  const utilCompat = util as typeof util & { isError?: (value: unknown) => boolean };
  if (typeof utilCompat.isError !== "function") {
    utilCompat.isError = (value: unknown): boolean => value instanceof Error;
  }

  const moduleWithLoad = Module as typeof Module & {
    _load?: (
      request: string,
      parent: NodeModule | undefined,
      isMain: boolean,
      options?: unknown,
    ) => unknown;
  };
  const originalLoad = moduleWithLoad._load;
  if (typeof originalLoad !== "function") return;
  moduleWithLoad._load = function patchedLoad(
    request: string,
    parent: NodeModule | undefined,
    isMain: boolean,
    options?: unknown,
  ): unknown {
    if (request === "usocket") return { USocket };
    return originalLoad.call(this, request, parent, isMain, options);
  };
}

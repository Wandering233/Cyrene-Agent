import { describe, expect, it } from "vitest";
import { installDbusCompat } from "./dbus-compat";

describe("installDbusCompat", () => {
  it("routes the native usocket dependency to a plain net.Socket adapter", () => {
    installDbusCompat();
    installDbusCompat();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const shim = require("usocket") as { USocket?: unknown };
    expect(typeof shim.USocket).toBe("function");
  });
});

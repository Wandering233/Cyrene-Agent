import { describe, expect, it, vi } from "vitest";
import { detectStatusNotifierWatcher, parseNameHasOwner } from "./tray-host";

describe("StatusNotifierWatcher detection", () => {
  it("parses gdbus NameHasOwner output", () => {
    expect(parseNameHasOwner("(true,)\n")).toBe(true);
    expect(parseNameHasOwner("(false,)")).toBe(false);
    expect(parseNameHasOwner("garbage")).toBe(false);
  });

  it("returns true when the probe cannot run", () => {
    expect(detectStatusNotifierWatcher(() => { throw new Error("no gdbus"); })).toBe(true);
  });

  it("queries the session bus for the watcher", () => {
    const run = vi.fn(() => "(true,)");
    expect(detectStatusNotifierWatcher(run)).toBe(true);
    expect(run).toHaveBeenCalledWith(
      "gdbus",
      expect.arrayContaining(["org.kde.StatusNotifierWatcher"]),
    );
  });
});

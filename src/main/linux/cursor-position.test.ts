import { describe, expect, it } from "vitest";
import { readLinuxCursorPosition, withLinuxCursorFallback } from "./cursor-position";

describe("readLinuxCursorPosition", () => {
  it("parses hyprctl JSON and caches for 100ms", () => {
    const calls: string[][] = [];
    const run = (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return JSON.stringify({ x: 123, y: 456 });
    };
    expect(readLinuxCursorPosition({ HYPRLAND_INSTANCE_SIGNATURE: "x" }, run, 1000)).toEqual({ x: 123, y: 456 });
    expect(readLinuxCursorPosition({ HYPRLAND_INSTANCE_SIGNATURE: "x" }, run, 1050)).toEqual({ x: 123, y: 456 });
    expect(calls).toHaveLength(1);
  });

  it("falls back when not on Hyprland or hyprctl fails", () => {
    expect(readLinuxCursorPosition({}, () => "{}", 0)).toBeNull();
    expect(readLinuxCursorPosition({ HYPRLAND_INSTANCE_SIGNATURE: "x" }, () => { throw new Error("no"); }, 0)).toBeNull();
    expect(withLinuxCursorFallback(() => ({ x: 1, y: 2 }), {})).toEqual({ x: 1, y: 2 });
  });
});

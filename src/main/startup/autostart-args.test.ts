import { describe, expect, it } from "vitest";
import { isAutostartLaunch } from "./autostart-args";

describe("isAutostartLaunch", () => {
  it("detects the XDG autostart flag", () => {
    expect(isAutostartLaunch(["cyrene", "--autostart"])).toBe(true);
  });

  it("ignores unrelated arguments", () => {
    expect(isAutostartLaunch(["cyrene"])).toBe(false);
    expect(isAutostartLaunch(["cyrene", "--squirrel-firstrun"])).toBe(false);
  });
});

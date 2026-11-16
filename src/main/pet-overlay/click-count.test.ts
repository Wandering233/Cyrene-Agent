import { describe, expect, it } from "vitest";
import { resolvePointerClickCount } from "./click-count";

describe("resolvePointerClickCount", () => {
  it("counts double and triple clicks within time/distance", () => {
    let state = null;
    let result = resolvePointerClickCount(state, "left", 10, 10, 1000);
    state = result.state;
    expect(result.count).toBe(1);
    result = resolvePointerClickCount(state, "left", 11, 11, 1200);
    state = result.state;
    expect(result.count).toBe(2);
    result = resolvePointerClickCount(state, "left", 12, 12, 1300);
    expect(result.count).toBe(3);
  });

  it("resets on another button, distance or timeout", () => {
    const first = resolvePointerClickCount(null, "left", 10, 10, 1000);
    expect(resolvePointerClickCount(first.state, "right", 10, 10, 1100).count).toBe(1);
    expect(resolvePointerClickCount(first.state, "left", 30, 10, 1100).count).toBe(1);
    expect(resolvePointerClickCount(first.state, "left", 10, 10, 2000).count).toBe(1);
  });
});

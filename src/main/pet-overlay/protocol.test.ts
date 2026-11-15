import { describe, expect, it } from "vitest";
import {
  encodeControl,
  frameStride,
  parseHostEvent,
  pointerButtonName,
} from "./protocol";

describe("pet overlay protocol", () => {
  it("encodes control messages as one JSON line", () => {
    const encoded = encodeControl({ type: "move", x: 12, y: 34 }).toString("utf8");
    expect(encoded.endsWith("\n")).toBe(true);
    expect(JSON.parse(encoded)).toEqual({ type: "move", x: 12, y: 34 });
  });

  it("parses host events and rejects malformed lines", () => {
    expect(parseHostEvent('{"type":"ready","protocol":1,"width":400,"height":500,"output":null,"scale":1}'))
      .toEqual({ type: "ready", protocol: 1, width: 400, height: 500, output: null, scale: 1 });
    expect(parseHostEvent("")).toBeNull();
    expect(parseHostEvent("not json")).toBeNull();
    expect(parseHostEvent('{"type":42}')).toBeNull();
  });

  it("parses axis deltas", () => {
    expect(parseHostEvent(
      '{"type":"pointer","event":"axis","x":12,"y":34,"delta_x":0,"delta_y":15}',
    )).toEqual({
      type: "pointer",
      event: "axis",
      x: 12,
      y: 34,
      delta_x: 0,
      delta_y: 15,
    });
  });

  it("validates frame stride", () => {
    expect(frameStride(400 * 500 * 4, 400, 500)).toBe(1600);
    expect(frameStride(400 * 500 * 4 - 1, 400, 500)).toBeNull();
    expect(frameStride(100, 400, 500)).toBeNull();
    expect(frameStride(400 * 500 * 4, 0, 500)).toBeNull();
  });

  it("maps Linux input button codes", () => {
    expect(pointerButtonName(0x110)).toBe("left");
    expect(pointerButtonName(0x111)).toBe("right");
    expect(pointerButtonName(0x112)).toBe("middle");
    expect(pointerButtonName(0x999)).toBeNull();
  });
});

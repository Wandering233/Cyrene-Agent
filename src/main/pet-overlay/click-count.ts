export type PointerButton = "left" | "middle" | "right";

export interface PointerClickState {
  button: PointerButton;
  at: number;
  x: number;
  y: number;
  count: number;
}

/**
 * Click count for offscreen sendInputEvent. Wayland's layer surface gives us
 * raw button events, so double/triple click has to be synthesized from time
 * and movement instead of relying on the compositor.
 */
export function resolvePointerClickCount(
  previous: PointerClickState | null,
  button: PointerButton,
  x: number,
  y: number,
  now: number,
  options: { maxGapMs?: number; maxDistance?: number } = {},
): { state: PointerClickState; count: number } {
  const maxGapMs = options.maxGapMs ?? 400;
  const maxDistance = options.maxDistance ?? 4;
  const near = previous !== null
    && previous.button === button
    && now - previous.at <= maxGapMs
    && Math.abs(previous.x - x) <= maxDistance
    && Math.abs(previous.y - y) <= maxDistance;
  const count = near ? Math.min(3, previous.count + 1) : 1;
  return { state: { button, at: now, x, y, count }, count };
}

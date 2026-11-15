/**
 * Wire protocol between the Electron main process and the native Wayland
 * overlay host.
 *
 * Frames are sent as a JSON header line followed by exactly
 * `stride * height` bytes of premultiplied BGRA data (the same layout
 * Electron's `NativeImage.toBitmap()` returns on Linux, and the same layout
 * Wayland's `WL_SHM_FORMAT_ARGB8888` expects on little-endian machines).
 */

export const PROTOCOL_VERSION = 1;

export interface InitMessage {
  type: "init";
  protocol: number;
  width: number;
  height: number;
  x: number;
  y: number;
  output?: string;
  namespace?: string;
  layer?: "top" | "overlay";
}

export interface ResizeMessage {
  type: "size";
  width: number;
  height: number;
}

export interface MoveMessage {
  type: "move";
  x: number;
  y: number;
}

export interface ShowMessage {
  type: "show";
}

export interface HideMessage {
  type: "hide";
}

export interface InteractiveMessage {
  type: "interactive";
  interactive: boolean;
}

export interface LayerMessage {
  type: "layer";
  layer: "top" | "overlay";
}

export interface QuitMessage {
  type: "quit";
}

export type ControlMessage =
  | InitMessage
  | ResizeMessage
  | MoveMessage
  | ShowMessage
  | HideMessage
  | InteractiveMessage
  | LayerMessage
  | QuitMessage;

export interface FrameHeader {
  type: "frame";
  seq: number;
  width: number;
  height: number;
  stride: number;
}

export interface ReadyEvent {
  type: "ready";
  protocol: number;
  width: number;
  height: number;
  output: string | null;
  scale: number;
}

export type PointerEventName =
  | "enter"
  | "leave"
  | "motion"
  | "down"
  | "up"
  | "axis";

export interface PointerEvent {
  type: "pointer";
  event: PointerEventName;
  x: number;
  y: number;
  button?: number;
  time?: number;
  delta_x?: number;
  delta_y?: number;
}

export type DragPhase = "start" | "move" | "end";

export interface DragEvent {
  type: "drag";
  phase: DragPhase;
  x: number;
  y: number;
}

export interface PositionEvent {
  type: "position";
  x: number;
  y: number;
}

export interface ErrorEvent {
  type: "error";
  code: string;
  message: string;
}

export interface LogEvent {
  type: "log";
  message: string;
}

export type HostEvent =
  | ReadyEvent
  | PointerEvent
  | DragEvent
  | PositionEvent
  | ErrorEvent
  | LogEvent;

export function encodeControl(message: ControlMessage): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}

export function encodeFrameHeader(
  seq: number,
  width: number,
  height: number,
  stride: number,
): Buffer {
  const header: FrameHeader = { type: "frame", seq, width, height, stride };
  return Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
}

export function parseHostEvent(line: string): HostEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as HostEvent;
    return typeof parsed === "object" && parsed !== null && typeof parsed.type === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * Electron reports premultiplied BGRA on Linux. Validate the bitmap before it
 * hits the host so a malformed frame can never make the native process
 * allocate an unexpected amount of memory.
 */
export function frameStride(bitmapLength: number, width: number, height: number): number | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  if (bitmapLength % height !== 0) return null;
  const stride = bitmapLength / height;
  if (!Number.isInteger(stride) || stride < width * 4) return null;
  if (stride > width * 4 * 8) return null;
  return stride;
}

export function pointerButtonName(button: number | undefined): "left" | "middle" | "right" | null {
  switch (button) {
    case 0x110:
      return "left";
    case 0x111:
      return "right";
    case 0x112:
      return "middle";
    default:
      return null;
  }
}

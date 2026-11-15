import type { BrowserWindow } from "electron";
import type { PetOverlayController } from "./controller";

const overlays = new WeakMap<BrowserWindow, PetOverlayController>();

export function registerPetOverlay(
  window: BrowserWindow,
  controller: PetOverlayController,
): void {
  overlays.set(window, controller);
}

export function getPetOverlay(window: BrowserWindow | null): PetOverlayController | null {
  if (!window) return null;
  return overlays.get(window) ?? null;
}

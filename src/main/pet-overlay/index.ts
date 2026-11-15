import { app } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { PetOverlayController, type PetOverlayControllerOptions } from "./controller";
import { registerPetOverlay } from "./registry";

export { getPetOverlay } from "./registry";

export function resolveOverlayHostBinary(): string | null {
  const override = process.env.CYRENE_OVERLAY_HOST_BIN;
  if (override) return existsSync(override) ? override : null;

  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "bin", "cyrene-overlay-host")]
    : [
        path.join(app.getAppPath(), "native", "cyrene-overlay-host", "target", "release", "cyrene-overlay-host"),
        path.join(app.getAppPath(), "native", "cyrene-overlay-host", "target", "debug", "cyrene-overlay-host"),
      ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function shouldUsePetOverlay(): boolean {
  if (process.platform !== "linux") return false;
  const mode = process.env.CYRENE_PET_OVERLAY;
  if (mode === "0") return false;
  if (!process.env.WAYLAND_DISPLAY && process.env.XDG_SESSION_TYPE !== "wayland") return false;
  // Mutter does not implement wlr-layer-shell. Explicitly enabling the overlay
  // is still allowed for development, but the automatic path avoids spawning a
  // host that can only fail and fall back.
  if (mode !== "1" && (process.env.XDG_CURRENT_DESKTOP ?? "").toLowerCase().includes("gnome")) {
    return false;
  }
  return resolveOverlayHostBinary() !== null;
}

export interface CreatePetOverlayOptions
  extends Omit<PetOverlayControllerOptions, "isDev" | "binaryPath"> {
  isDev: boolean;
}

export function createPetOverlayWindow(options: CreatePetOverlayOptions): PetOverlayController | null {
  const binaryPath = resolveOverlayHostBinary();
  if (!binaryPath) return null;
  const controller = new PetOverlayController({ ...options, binaryPath });
  registerPetOverlay(controller.window, controller);
  return controller;
}

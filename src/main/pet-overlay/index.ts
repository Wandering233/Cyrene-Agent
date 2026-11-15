import { app } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { PetOverlayController, type PetOverlayControllerOptions } from "./controller";
import { registerPetOverlay } from "./registry";

export { getPetOverlay } from "./registry";

export type OverlayBackend = "layer" | "fullscreen";

export function resolveOverlayBackend(): OverlayBackend {
  const explicit = process.env.CYRENE_OVERLAY_BACKEND?.trim().toLowerCase();
  if (explicit === "fullscreen" || explicit === "layer") return explicit;
  const desktop = (process.env.XDG_CURRENT_DESKTOP ?? "").toLowerCase();
  if (desktop.includes("gnome")) return "fullscreen";
  return "layer";
}

function backendBinaryName(backend: OverlayBackend): string {
  return backend === "fullscreen" ? "cyrene-overlay-fullscreen" : "cyrene-overlay-host";
}

export function resolveOverlayHostBinary(backend: OverlayBackend = resolveOverlayBackend()): string | null {
  const override = process.env.CYRENE_OVERLAY_HOST_BIN;
  if (override) return existsSync(override) ? override : null;

  const name = backendBinaryName(backend);
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "bin", name)]
    : [
        path.join(app.getAppPath(), "native", "cyrene-overlay-host", "target", "release", name),
        path.join(app.getAppPath(), "native", "cyrene-overlay-host", "target", "debug", name),
      ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function shouldUsePetOverlay(): boolean {
  if (process.platform !== "linux") return false;
  const mode = process.env.CYRENE_PET_OVERLAY;
  if (mode === "0") return false;
  if (!process.env.WAYLAND_DISPLAY && process.env.XDG_SESSION_TYPE !== "wayland") return false;
  return resolveOverlayHostBinary() !== null;
}

export interface CreatePetOverlayOptions
  extends Omit<PetOverlayControllerOptions, "isDev" | "binaryPath" | "scale"> {
  isDev: boolean;
  backend?: OverlayBackend;
  scale?: number;
}

export function createPetOverlayWindow(options: CreatePetOverlayOptions): PetOverlayController | null {
  const backend = options.backend ?? resolveOverlayBackend();
  const binaryPath = resolveOverlayHostBinary(backend);
  if (!binaryPath) return null;
  // The fullscreen fallback currently renders at 1x buffer scale; keep the
  // frame/coordinate contract simple until per-output buffer scale is added.
  const scale = backend === "fullscreen" ? 1 : (options.scale ?? 1);
  const controller = new PetOverlayController({ ...options, binaryPath, scale });
  registerPetOverlay(controller.window, controller);
  return controller;
}
